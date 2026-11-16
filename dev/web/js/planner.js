// The planner: a search bot built as an instrument for balancing and
// playtesting (docs/better-bots.md). It keeps SearchBot's formulas, but only
// as proposers, and adds:
//
// - Hidden cards shuffled before each rollout (step 3): its own draw pile,
//   the other hands dealt afresh from hand and draw pile, and the market
//   decks within their tiers. The look-ahead no longer sees the future.
// - Targets searched (step 1): for the best card plays it also tries the
//   formula's best digs or builds, plus one at random, as separate
//   candidates; a rule that makes the second-ranked target better is found
//   by the rollouts, with no constant edited.
// - Sequential halving: the rollout budget goes first to all candidates,
//   then to the better half, and so on, on common random numbers.
// - Opponents played by their own lean (step "everyone thinks alike"): in a
//   rollout each other seat plays a plan inferred from the cards it owns.
// - A fitted value (step 2a): where a rollout stops, the position is scored
//   by a regression of the final margin on features of the position, fitted
//   from the bots' own games by tools/fit_value.mjs (bots/value-fit.json).
//   Off by default until a fit beats the hand-set evaluation in a mixed-seat
//   test ("planner-fit" in tools/playtest).
import * as E from "./engine.js";
import { SearchBot, plan, PLANS, preset, legalMoves, LANES } from "./bots.js";

const makeRng = (seed) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// --------------------------------------------------------------------------- //
// Hidden information
// --------------------------------------------------------------------------- //

/** Shuffle what player `me` cannot know, in a copy of the game. */
export function determinize(g, me, rnd) {
  const sh = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  g.players.forEach((p, i) => {
    if (i === me) { sh(p.draw); return; }
    const n = p.hand.length, all = sh([...p.hand, ...p.draw]);
    p.hand = all.slice(0, n); p.draw = all.slice(n);
  });
  // Market decks: shuffled within each run of one tier, so tier 2 stays under tier 1.
  for (const k of ["stack", "inland"]) {
    const pile = g.market[k];
    if (!pile?.length) continue;
    let i = 0;
    while (i < pile.length) {
      const t = E.deckTier(E.def(g, pile[i]).deck);
      let j = i;
      while (j < pile.length && E.deckTier(E.def(g, pile[j]).deck) === t) j++;
      const run = sh(pile.slice(i, j));
      for (let x = i; x < j; x++) pile[x] = run[x - i];
      i = j;
    }
  }
  return g;
}

// --------------------------------------------------------------------------- //
// Opponent models
// --------------------------------------------------------------------------- //

/** A player's lean, read from the colours of the cards they own (weighted), plus one of each. */
export function inferPlan(st, pi) {
  const c = E.score(st, pi).counts;
  return plan({ early: LANES.map((l) => 1 + (c[l] || 0)) });
}

// --------------------------------------------------------------------------- //
// The fitted value (docs/better-bots.md step 2a)
// --------------------------------------------------------------------------- //

/** Raw facts about player pi's position. */
function facts(st, pi, link) {
  const p = st.players[pi], sc = E.score(st, pi);
  const lane = Object.fromEntries(sc.lanes.map((l) => [l.mult, l]));
  let canals = 0;
  for (const o of Object.values(st.dug)) if (o === pi) canals++;
  let buildings = 0, sources = 0, late = 0;
  for (const [hk, list] of Object.entries(st.buildings)) {
    list.forEach((b, i) => {
      if (b.p !== pi) return;
      buildings++;
      const bt = st.buildingTypes.find((x) => x.id === b.type);
      if (bt?.extracts && i === 0) sources++;
      if (bt && bt.vp !== "base" && bt.vp >= 3) late++;
    });
  }
  return {
    total: sc.total, money: p.money, income: p.income, pearls: p.pearls || 0, hand: p.handSize,
    deck: E.ownedCards(p).length, canals, buildings, sources, late, keys: p.keys,
    reach: lane.buy?.s || 0, bscore: lane.dig?.s || 0, deckvp: lane.build?.s || 0,
    cdig: sc.counts.dig || 0, cbuild: sc.counts.build || 0, cbuy: sc.counts.buy || 0, cspecial: sc.counts.special || 0,
    slots: (p.taken || []).length,
  };
}
export const FEATURE_KEYS = ["total", "money", "income", "pearls", "hand", "deck", "canals", "buildings", "sources", "late",
  "keys", "reach", "bscore", "deckvp", "cdig", "cbuild", "cbuy", "cspecial", "slots"];

/**
 * The features of pi's position: the game's progress, each fact as pi's
 * value less the strongest other player's, and the same again scaled by how
 * much of the game is left (so early income can be worth more than late).
 */
export function features(st, pi) {
  const link = E.linkedNetwork(st);
  const done = st.round - 1, f = done / Math.max(1, done + E.roundsLeft(st));
  const all = st.players.map((_, i) => facts(st, i, link));
  let best = -1, bestT = -Infinity;
  all.forEach((x, i) => { if (i !== pi && x.total > bestT) { bestT = x.total; best = i; } });
  const me = all[pi], op = best >= 0 ? all[best] : me;
  const diff = FEATURE_KEYS.map((k) => me[k] - op[k]);
  return [1, f, ...diff, ...diff.map((x) => x * (1 - f))];
}

let FIT = null;
/** Install a fit (bots/value-fit.json): { weights, mean, scale }. */
export function setValueFit(fit) { FIT = fit && fit.weights ? fit : null; }
export const hasValueFit = () => !!FIT;
export function fittedValue(st, pi) {
  const x = features(st, pi);
  let v = 0;
  for (let i = 0; i < x.length; i++) v += FIT.weights[i] * (i === 0 ? 1 : (x[i] - FIT.mean[i]) / FIT.scale[i]);
  return v;
}

/** Ridge regression on standardised features (column 0 is the intercept). */
export function ridge(X, y, lambda = 1) {
  const n = X.length, d = X[0].length;
  const mean = Array(d).fill(0), scale = Array(d).fill(1);
  for (let j = 1; j < d; j++) {
    let m = 0; for (const r of X) m += r[j]; m /= n;
    let v = 0; for (const r of X) v += (r[j] - m) ** 2; v = Math.sqrt(v / n) || 1;
    mean[j] = m; scale[j] = v;
  }
  const Z = X.map((r) => r.map((x, j) => (j === 0 ? 1 : (x - mean[j]) / scale[j])));
  const A = Array.from({ length: d }, () => Array(d).fill(0)), b = Array(d).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) { b[j] += Z[i][j] * y[i]; for (let k = 0; k < d; k++) A[j][k] += Z[i][j] * Z[i][k]; }
  for (let j = 1; j < d; j++) A[j][j] += lambda;
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < d; c++) {
    let piv = c; for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < d; r++) { const f = A[r][c] / A[c][c]; if (!f) continue; for (let k = c; k < d; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const w = Array(d).fill(0);
  for (let c = d - 1; c >= 0; c--) { let t = b[c]; for (let k = c + 1; k < d; k++) t -= A[c][k] * w[k]; w[c] = t / A[c][c]; }
  return { weights: w, mean, scale };
}

// --------------------------------------------------------------------------- //
// The planner
// --------------------------------------------------------------------------- //

export class PlannerBot extends SearchBot {
  /**
   * style: a plan or sliders, as SearchBot. opts: { budget (rollouts in all,
   * default rollouts × width of the style), targets (per card, default 3),
   * shuffle (hidden cards, default true), models (opponents by their own lean,
   * default true), fitted (use the fitted value when installed, default false:
   * the first fit, held-out R² 0.22, scored 14 points a game worse than without,
   * interval -37 to +8 in 16 mixed games) }.
   */
  constructor(name, style, seed = 1, search = null, opts = {}) {
    super(name, style, seed, search);
    this.opts = { targets: 3, shuffle: true, models: true, fitted: false, ...opts };
    this.models = null;
  }

  evaluate(st, pi) {
    if (this.opts.fitted && FIT) {
      const p = st.players[pi];
      // The fit scores the position; pearls on the track are not in it.
      return fittedValue(st, pi) + (st.config.pearls && st.config.pearlEarning === "track" ? (0.8 * (p.pearlTrack || 0)) / E.pearlNeed(st, p) : 0);
    }
    return super.evaluate(st, pi);
  }

  /** Candidates: the best card plays by prior, and for the best dig and build plays their best targets too. */
  candidates(st) {
    let moves = legalMoves(st);
    moves = moves.map((m) => [m, this.prior(st, m)]).sort((a, b) => b[1] - a[1]).slice(0, this.s.width).map(([m]) => m);
    const out = moves.map((m) => ({ m }));
    const k = this.opts.targets;
    if (!k) return out;
    let tried = 0;
    for (const m of moves) {
      if (tried >= 3 || m.opt === "forage") continue;
      const role = E.def(st, m.uid).role;
      if (role !== "dig" && role !== "build") continue;
      tried++;
      // Play the card in a copy to see which targets it opens.
      const g = E.cloneState(st, 1);
      const discards = m.opt === 0 || typeof m.opt === "string" ? [] : this.pickDiscards(g, m.uid, m.opt);
      if (!E.playCard(g, m.uid, discards).ok) continue;
      this.spendPearls(g);
      let targets = role === "dig" ? this.pickDig(g, k).map((ek) => ({ dig: ek })) : this.pickBuild(g, k).map((x) => ({ build: x }));
      if (role === "dig") {
        const all = Object.keys(g.board.edges).filter((ek) => E.canDig(g, ek).ok && !targets.some((t) => t.dig === ek));
        if (all.length) targets.push({ dig: all[Math.floor(this.rng() * all.length)] });
      }
      // The first target is what the formula would do anyway: it is the plain move.
      for (const t of targets.slice(1)) out.push({ m, forced: t });
    }
    return out;
  }

  /** One rollout of candidate c from st, for seat me, on the given seed. */
  playout(st, c, me, seed) {
    const g = E.cloneState(st, seed);
    const rr = makeRng(seed ^ 0x9e3779b9);
    if (this.opts.shuffle) determinize(g, me, rr);
    this.forced = c.forced || null;
    this.resolve(g, c.m);
    this.forced = null;
    const rounds = Math.min(this.s.horizon, Math.ceil(E.roundsLeft(g)));
    const stop = g.round + rounds;
    let guard = 0;
    while (!g.over && g.round < stop && guard++ < 600) {
      if (!E.currentPlayer(g).hand.length) { E.pass(g); continue; }
      const bot = g.current === me || !this.models ? this : this.models[g.current];
      if (bot !== this) bot.rng = rr;
      bot.phase(g);
      bot.resolve(g, bot.rolloutMove(g));
    }
    this.phase(st);
    return this.evaluate(g, me);
  }

  choose(st) {
    this.phase(st);
    const me = (this.seat = st.current);
    const cands = this.candidates(st);
    if (cands.length <= 1) return cands[0] || null;
    this.models = this.opts.models ? st.players.map((_, i) => (i === me ? null : new SearchBot("model", inferPlan(st, i), 1 + i, [1, 1]))) : null;
    // Sequential halving over the budget.
    const budget = this.opts.budget || this.s.rollouts * this.s.width;
    let alive = cands.map((c) => ({ c, sum: 0, n: 0 }));
    const rounds = Math.max(1, Math.ceil(Math.log2(alive.length)));
    while (alive.length > 1) {
      const per = Math.max(1, Math.floor(budget / (alive.length * rounds)));
      const seeds = Array.from({ length: per }, () => Math.floor(this.rng() * 4294967296));
      for (const a of alive) for (const sd of seeds) { a.sum += this.playout(st, a.c, me, sd); a.n++; }
      alive.sort((x, y) => y.sum / y.n - x.sum / x.n);
      alive = alive.slice(0, Math.ceil(alive.length / 2));
    }
    this.models = null;
    return alive[0].c;
  }

  playTurn(st) {
    if (st.turn?.phase === "harbour" || st.turn?.phase === "startTech" || !E.currentPlayer(st).hand.length) return super.playTurn(st);
    const c = this.choose(st);
    this.seat = st.current;
    this.forced = c.forced || null;
    return this.resolve(st, c.m);
  }
}

/** A planner on a named plan or preset: "planner" (the even plan), "planner:lean-reach", "planner:digger". */
export function makePlanner(name, seed = 1, search = null, opts = {}) {
  const base = name.includes(":") ? name.split(":")[1] : "lane-even";
  return new PlannerBot(base, PLANS[base] || preset(base), seed, search, opts);
}

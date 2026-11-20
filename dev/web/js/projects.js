// The project bot (docs/planning-bots.md): a computer player that plans in
// layers, as a person does.
//
// - Leaning, the whole game: which tale it means to win by (or none), chosen
//   at the start from what has paid before, and turned when the game says so.
// - Projects, a few turns long: befriend a village, open a source, raise a
//   late building, step a tale's multiplier, reach a find, empty a lodge
//   sector for its mastery, take a prize, gather shells, thin the deck, and
//   hasten or stave off the end. The bot holds one to three.
// - Tactics, every turn: the greedy bot's one-turn look-ahead, steered by an
//   intent (places to make for, buildings and card colours wanted, shells to
//   keep, a value for progress). No rollouts: a turn costs what greedy's does.
// - Planning, only at moments: it proposes projects, makes bundles of them,
//   and plays each bundle on for some rounds in sampled worlds (Monte Carlo
//   over projects, not over single plays). Rivals follow the projects their
//   play shows. It keeps its present bundle unless another beats it by more
//   than its commitment and the noise of the comparison.
// - Moments: its own milestones (a project done or late), the table's (a
//   tide, the end in sight), surprises (a site taken, a rival's canal at a
//   contested place), and a clock as fallback.
// - Knowledge: what a player at its level of memory could know. The worlds it
//   plans in are sampled from that (sampleWorld): an expert counts every card,
//   a regular player knows its own deck, a novice only what is in front of it.
// - Beliefs: how long each kind of project takes, how often it comes off, what
//   it is really worth, and which leanings pay. Shared by the bots of a level
//   and private to each bot; drawn from (Thompson sampling) at the start of a
//   game and updated at its end (finish). A novice starts from face values.
//
// It keeps a log of its plans: why it planned, what it dropped and took up,
// whether the cause was its own, the table's or another family's, and how
// each project went against what it expected.
import * as E from "./engine.js";
import { greedyTurn, value as greedyValue, borderGraph, makeRng } from "./agents.js";
import { parseEffects } from "./notation.js";
import { features as positionFeatures, makePlanner } from "./planner.js";
import { positionReward, finalReward } from "./reward.js";

export const MEMORIES = ["novice", "regular", "expert"];
export const LEANINGS = ["even", "dig", "build", "buy", "special"];

// --------------------------------------------------------------------------- //
// What a bot knows: a world it cannot tell from the real one
// --------------------------------------------------------------------------- //

const shuffle = (a, rnd) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/**
 * A copy of the game with everything player `me` cannot know made up afresh,
 * by its memory:
 *
 * - expert: every deck's contents and the market deck's remaining cards are
 *   known exactly; only orders, and how a rival's cards split between hand
 *   and draw pile, are shuffled.
 * - regular: its own deck exactly. A rival's hand could be any of the cards
 *   they own, and the market deck holds "cards of that tier", drawn from the
 *   game's full list for the tier and not from what is really left.
 * - novice: as regular, and it has not kept track of its own discards: its
 *   draw pile could hold any card it owns that is not in its hand.
 */
export function sampleWorld(st, me, memory, seed) {
  const g = E.cloneState(st, seed);
  const rnd = makeRng(seed ^ 0x9e3779b9);
  const expert = memory === "expert";
  g.players.forEach((p, i) => {
    if (i === me) {
      if (memory === "novice") {
        const all = shuffle([...p.draw, ...p.discard], rnd), n = p.draw.length;
        p.draw = all.slice(0, n); p.discard = all.slice(n);
      } else shuffle(p.draw, rnd);
      return;
    }
    const n = p.hand.length;
    if (expert) {
      const all = shuffle([...p.hand, ...p.draw], rnd);
      p.hand = all.slice(0, n); p.draw = all.slice(n);
    } else {
      const d = p.draw.length, all = shuffle([...p.hand, ...p.draw, ...p.discard], rnd);
      p.hand = all.slice(0, n); p.draw = all.slice(n, n + d); p.discard = all.slice(n + d);
    }
  });
  // The market decks. An expert knows what is left and shuffles within each tier.
  // The others deal the hidden cards afresh from the tier's full list.
  let pool = null;
  if (!expert) {
    g.cards = { ...g.cards };
    pool = {};
    for (const id of Object.values(st.cards)) { const d = st.defs[id]; if (d && !String(d.deck).startsWith("start")) (pool[d.deck] ||= []).push(id); }
  }
  for (const k of ["stack", "inland"]) {
    const pile = g.market[k];
    if (!pile?.length) continue;
    if (!expert) { for (const uid of pile) { const list = pool[E.def(st, uid).deck]; if (list?.length) g.cards[uid] = list[Math.floor(rnd() * list.length)]; } continue; }
    let i = 0;
    while (i < pile.length) {
      const t = E.deckTier(E.def(g, pile[i]).deck);
      let j = i;
      while (j < pile.length && E.deckTier(E.def(g, pile[j]).deck) === t) j++;
      const run = shuffle(pile.slice(i, j), rnd);
      for (let x = i; x < j; x++) pile[x] = run[x - i];
      i = j;
    }
  }
  return g;
}

// --------------------------------------------------------------------------- //
// Beliefs: what a bot expects, and how it learns
// --------------------------------------------------------------------------- //
// A stat is { n, sum, sum2 }. A kind's record: turns (taken / expected, for
// projects finished), gain (what a finished project brought / what it was
// expected to bring, where that can be measured), and how many were done,
// lost to another family and dropped. Shared beliefs (one file a level) hold
// the kinds and the table; private ones (one a bot) hold its own kinds and
// its leanings, by leaning and by leaning, cove and starting craft.

const stat = () => ({ n: 0, sum: 0, sum2: 0 });
const addStat = (x, v) => { x.n++; x.sum += v; x.sum2 += v * v; };
const kindRecord = () => ({ turns: stat(), gain: stat(), done: 0, lost: 0, dropped: 0 });
/** Fresh beliefs: shared ones for a level, or a bot's own. Face values everywhere. */
export const freshShared = (level = "novice") => ({ kind: "shared", level, games: 0, kinds: {}, table: { rounds: stat() } });
export const freshOwn = (name = "bot") => ({ kind: "own", name, games: 0, kinds: {}, leanings: {} });

// The novice's face values: a project takes as many turns as it has steps,
// comes off, and is worth what its formula says; each with this many games'
// weight of belief, and this spread.
const FACE = { turns: { m: 1, k: 2, sd: 0.5 }, gain: { m: 1, k: 2, sd: 0.5 }, done: 3, lost: 0.3, leaning: { m: 0, k: 1, sd: 40 } };
const statMean = (x, f) => (x.sum + f.m * f.k) / (x.n + f.k);
const statSd = (x, f) => {
  if (x.n < 2) return f.sd;
  const m = x.sum / x.n, v = Math.max(0, x.sum2 / x.n - m * m);
  return Math.sqrt((v * x.n + f.sd * f.sd * f.k) / (x.n + f.k));
};
/** A normal draw (Box-Muller). */
const gauss = (rnd) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
const clip = (x, a, b) => Math.max(a, Math.min(b, x));

/** One kind's belief, the shared and own records together; the own one weighs more as its games mount. */
function kindBelief(shared, own, k) {
  const s = shared?.kinds?.[k] || kindRecord(), o = own?.kinds?.[k] || kindRecord();
  const w = (o.turns.n + o.done + o.lost) / (o.turns.n + o.done + o.lost + 8);
  const mix = (f) => (sel) => (1 - w) * f(s[sel], FACE[sel]) + w * f(o[sel], FACE[sel]);
  const n = (sel) => s[sel].n + o[sel].n;
  return {
    turns: mix(statMean)("turns"), turnsSd: mix(statSd)("turns") / Math.sqrt(n("turns") + FACE.turns.k),
    gain: mix(statMean)("gain"), gainSd: mix(statSd)("gain") / Math.sqrt(n("gain") + FACE.gain.k),
    done: FACE.done + (1 - w) * s.done + w * o.done * 2, lost: FACE.lost + (1 - w) * s.lost + w * o.lost * 2,
  };
}

/** A belief drawn for one game (Thompson sampling): what this game will be played as if it were true. */
function drawBeliefs(shared, own, rnd, kinds) {
  const out = {};
  for (const k of kinds) {
    const b = kindBelief(shared, own, k);
    const pv = b.done / (b.done + b.lost), pn = b.done + b.lost;
    out[k] = {
      turns: clip(b.turns + b.turnsSd * gauss(rnd), 0.4, 3),
      gain: clip(b.gain + b.gainSd * gauss(rnd), 0.2, 3),
      success: clip(pv + Math.sqrt((pv * (1 - pv)) / (pn + 1)) * gauss(rnd), 0.05, 1),
    };
  }
  return out;
}

/** The leaning to start a game on: the best of a draw from each leaning's record here (Thompson sampling). */
function drawLeaning(own, key, rnd) {
  let best = "even", bestV = -Infinity;
  for (const L of LEANINGS) {
    const a = own?.leanings?.[L] || stat(), b = own?.leanings?.[`${L}|${key}`] || stat();
    // The record for this cove and craft counts double what the leaning's overall record says.
    const n = a.n + 2 * b.n, sum = a.sum + 2 * b.sum, sum2 = a.sum2 + 2 * b.sum2;
    const x = { n, sum, sum2 }, f = FACE.leaning;
    const v = statMean(x, f) + (statSd(x, f) / Math.sqrt(n + f.k)) * gauss(rnd);
    if (v > bestV) { bestV = v; best = L; }
  }
  return best;
}

// --------------------------------------------------------------------------- //
// Learned judgements, kept as sums (planning-bots.md 6.1; bot-campaigns.md 6)
// --------------------------------------------------------------------------- //
// Two regressions, each kept as its running sums (X'X, X'y, y'y, n), so games
// played apart add up exactly like every other belief:
//
// - judge: what a position is worth, as a correction to the hand-set
//   reckoning. Each of a learner's turns gives a row: the planner's 40
//   features of the position (its lead in each fact, and the same scaled by the
//   game still to come), and as target the game's final reward less the
//   reward the hand-set reckoning gave that position. Rows are weighted so a
//   game counts once, however many turns it had.
// - cards: what owning one more of an animal, bought in a tide, is worth in
//   final reward. One row a learner a game: counts by design and tide of what
//   it bought, and its final reward.
//
// Both are ridge regressions toward zero (that is, toward the hand-set
// judgement, and toward "an animal is worth what the formulas say"), so a few
// games cannot pull a bot far. At the start of a game the weights are drawn
// from their posterior (Thompson sampling), as the other beliefs are.

const FEATURE_SCALE = (() => {
  const s19 = [50, 5, 3, 2, 1, 5, 5, 3, 1, 1, 1, 5, 5, 5, 2, 2, 2, 2, 3];   // planner.js FEATURE_KEYS, in typical sizes
  return [1, 1, ...s19, ...s19];
})();
const JUDGE = { lambda: 30, minGames: 30 }, CARDS = { lambda: 20, minRows: 50, cap: 6, weight: 0.5 };
const scaledFeatures = (st, pi) => positionFeatures(st, pi).map((x, i) => x / FEATURE_SCALE[i]);
const freshSums = (d, keys = null) => ({ d, n: 0, yy: 0, xty: Array(d).fill(0), xtx: Array(d * d).fill(0), ...(keys ? { keys } : {}) });
function addRow(S, x, y, w = 1) {
  const d = S.d;
  for (let i = 0; i < d; i++) {
    if (!x[i]) continue;
    S.xty[i] += w * x[i] * y;
    for (let j = 0; j < d; j++) if (x[j]) S.xtx[i * d + j] += w * x[i] * x[j];
  }
  S.yy += w * y * y;
}
/** Cholesky factor of a d×d matrix (flat): lower L with A = L Lᵀ. */
function cholesky(A, d) {
  const L = Array(d * d).fill(0);
  for (let i = 0; i < d; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * d + j];
    for (let k = 0; k < j; k++) s -= L[i * d + k] * L[j * d + k];
    L[i * d + j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / L[j * d + j];
  }
  return L;
}
/**
 * The ridge weights and one draw from their posterior: w ~ N(ŵ, σ² (X'X + λI)⁻¹),
 * σ² the residual variance. rnd null: the mean, no draw.
 */
function ridgeDraw(S, lambda, rnd) {
  const d = S.d, A = S.xtx.slice();
  for (let i = 0; i < d; i++) A[i * d + i] += lambda;
  const L = cholesky(A, d);
  // ŵ: L z = X'y, Lᵀ ŵ = z.
  const z = Array(d).fill(0), w = Array(d).fill(0);
  for (let i = 0; i < d; i++) { let s = S.xty[i]; for (let k = 0; k < i; k++) s -= L[i * d + k] * z[k]; z[i] = s / L[i * d + i]; }
  for (let i = d - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < d; k++) s -= L[k * d + i] * w[k]; w[i] = s / L[i * d + i]; }
  if (!rnd) return w;
  let fit = 0; for (let i = 0; i < d; i++) fit += w[i] * S.xty[i];
  const sigma = Math.sqrt(Math.max(1, (S.yy - fit) / Math.max(1, S.n - 1)));
  // Lᵀ e = g, g standard normal: e ~ N(0, (L Lᵀ)⁻¹).
  const g = Array.from({ length: d }, () => gauss(rnd)), e = Array(d).fill(0);
  for (let i = d - 1; i >= 0; i--) { let s = g[i]; for (let k = i + 1; k < d; k++) s -= L[k * d + i] * e[k]; e[i] = s / L[i * d + i]; }
  return w.map((x, i) => x + sigma * e[i]);
}
/** The non-starting animals of this game, in a fixed order: the cards regression's columns. */
const cardKeys = (st) => [...new Set(Object.values(st.cards).filter((id) => !String(st.defs[id]?.deck).startsWith("start")))].sort()
  .flatMap((id) => [1, 2, 3].map((t) => `${id}|${t}`));

/** The ridge weights of a set of sums (for tests and reports). */
export const ridgeWeights = (S, lambda) => ridgeDraw(S, lambda, null);
export { freshSums, addRow };

/** What a level has learned of judging positions and animals, read as numbers (for reports). */
export function describeJudgements(shared) {
  const out = { judge: null, cards: null };
  const J = shared?.judge;
  if (J?.n) out.judge = { games: J.n, weights: ridgeDraw(J, JUDGE.lambda, null) };
  const C = shared?.cards;
  if (C?.n) {
    const w = ridgeDraw(C, CARDS.lambda, null);
    out.cards = { rows: C.n, values: C.keys.map((k, i) => ({ key: k, value: w[i + 1] })).filter((x) => x.value !== 0) };
  }
  return out;
}

// Shared beliefs by level, set by whoever loads them (the suite, the table).
const SHARED = {};
export function setSharedBeliefs(level, b) { SHARED[level] = b; }
export const sharedBeliefs = (level) => SHARED[level] || null;
// Private beliefs by bot name ("regular-A"), for seating a trained learner: "projects:regular@A".
const OWN = {};
export function setOwnBeliefs(name, b) { OWN[name] = b; }
export const ownBeliefs = (name) => OWN[name] || null;

// --------------------------------------------------------------------------- //
// The position, as a planner reads it
// --------------------------------------------------------------------------- //

const LANES = ["dig", "build", "buy", "special"];
const LATE = (bt) => bt.vp !== "base" && bt.vp >= 3;   // the buildings that score: Holt, Mill, Lock
const SOURCE_OF = { wood: "camp", stone: "quarry" };

/** Digs needed before a canal of the network (anyone's) can touch each hex; 0 where one does. */
function digsFromNetwork(st, link, limit = 14) {
  const adj = borderGraph(st), dist = {}, queue = [];
  for (const ek of Object.keys(st.board.edges)) {
    if (st.dug[ek] !== undefined) continue;
    if (E.extendsNetwork(st, ek, link)) { dist[ek] = 1; queue.push(ek); }
  }
  while (queue.length) {
    const ek = queue.shift();
    if (dist[ek] >= limit) continue;
    for (const n of adj[ek]) if (dist[n] === undefined && st.dug[n] === undefined) { dist[n] = dist[ek] + 1; queue.push(n); }
  }
  return dist;
}

/** Digs player pi needs before a canal of its own touches hex hk (0: one does; Infinity: out of sight). */
function digsToOwn(st, pi, hk, link, dist) {
  if (E.ownCanalAt(st, hk, pi, link)) return 0;
  let best = Infinity;
  for (const [ek, d] of Object.entries(dist)) {
    const e = st.board.edges[ek];
    if ((e.a === hk || e.b === hk) && d < best) best = d;
  }
  return best;
}

/** What the planner needs to know of the position, worked out once (the network's reach shared between seats). */
function read(st, pi, shared = null) {
  const link = shared?.link || E.linkedNetwork(st), sc = E.score(st, pi);
  const lane = Object.fromEntries(sc.lanes.map((l) => [l.mult, l]));
  const done = st.round - 1, left = E.roundsLeft(st);
  const p = st.players[pi];
  return { st, pi, link, sc, lane, left, share: done / Math.max(1, done + left), dist: shared?.dist || digsFromNetwork(st, link), p, o: shared?.o || { patience: 0.5 }, wait: waits(st, p) };
}

/**
 * Turns, on average, until a card that digs, builds or buys is in hand: the
 * deck's share of such cards, over a hand's draw. A project's steps are
 * counted in these, so a deck with two Build cards in fifteen knows a
 * building is slow to come.
 */
function waits(st, p) {
  const own = E.ownedCards(p), n = Math.max(1, own.length), h = Math.max(1, p.handSize || st.config.handSize || 3);
  const k = { dig: 0, build: 0, buy: 0 };
  for (const u of own) { const d = E.def(st, u); for (const a of Object.keys(k)) if ((d.base || []).some((e) => e.kind === a)) k[a]++; }
  const out = {};
  for (const a of Object.keys(k)) { const q = 1 - (1 - Math.min(1, k[a] / n)) ** h; out[a] = q > 0 ? Math.min(8, 1 / q) : 8; }
  return out;
}

const hasBuildingAt = (st, hk, pi) => (st.buildings[hk] || []).some((b) => b.p === pi);
const freeSlot = (st, hk) => { const h = st.board.hexes[hk]; return h.slots > 0 && (st.buildings[hk] || []).length < h.slots; };
const tokensLeft = (st, pi, type) => (E.techOn(st) ? E.buildSlots(st, pi, type).length : 1);
const multAt = (cfg, n) => E.multiplier(cfg, n);
const startersOwned = (st, p) => E.ownedCards(p).filter((u) => String(st.cards[u]).startsWith("start")).length;
const thins = (d) => [...(d.base || []), ...(d.boost || [])].some((e) => String(e.kind).startsWith("trash"));
/** My margin over the best other family, by the greedy bot's reckoning. */
function margin(st, me) {
  let best = -Infinity;
  for (let i = 0; i < st.players.length; i++) if (i !== me) best = Math.max(best, greedyValue(st, i));
  return greedyValue(st, me) - best;
}

/** What a find or a prize's effect is worth now, in rough points. */
function effectWorth(r, code) {
  let v = 0;
  for (const e of parseEffects(code)) {
    const n = e.n;
    v += { money: 0.8 * n, income: 0.5 * n * Math.min(r.left, 10), dig: 2.5 * n, build: 3 * n, buy: 3 * n, pearl: 1.8 * n, pearlTrack: 0.4 * n,
      trashAny: 1.5 * n, handSize: 6 * n, extraDraw: 1.5 * n, keys: (r.st.config.vpPerKey || 5) * n }[e.kind] ?? 1;
  }
  return v;
}

// --------------------------------------------------------------------------- //
// Projects
// --------------------------------------------------------------------------- //
// Each kind: propose(r) -> [project], status(st, pi, proj) -> { s: "live" |
// "done" | "dead", why, by: "other" | "self" | "table" }, steer(r, proj,
// intent), which adds the project's wishes to an intent, and, where it can be
// measured, gain(st, pi, proj): what it brought by the end, in points.
// A project's `worth` is its formula's estimate of points; `steps` the turns
// it should take.

/** The tale each kind feeds, for the leaning. */
const FEEDS = { befriend: "special", source: "dig", raise: "dig", hall: "dig", find: "buy", step: null, prize: null, gather: null, thin: null, end: null };

const KINDS = {
  // Make a friendship: bring a canal of your own to a spring village and build there.
  befriend: {
    propose(r) {
      const { st, pi } = r, out = [];
      for (const [hk, h] of Object.entries(st.board.hexes)) {
        if (!h.isKey || !freeSlot(st, hk) || hasBuildingAt(st, hk, pi)) continue;
        if (E.inlandClosed(st) && E.isInland(st, hk)) continue;
        const digs = digsToOwn(st, pi, hk, r.link, r.dist);
        if (digs > 9) continue;
        const worth = E.villageKeys(st, hk) * st.config.vpPerKey * Math.max(1, r.lane.special?.m || 1) + 4;
        out.push({ kind: "befriend", hex: hk, worth, steps: digs * r.wait.dig + r.wait.build, label: `befriend the village at ${hk}` });
      }
      return out;
    },
    status(st, pi, x) {
      if (hasBuildingAt(st, x.hex, pi)) return { s: "done" };
      if (!freeSlot(st, x.hex)) return { s: "dead", why: "the village is full", by: "other" };
      return { s: "live" };
    },
    steer(r, x, intent) {
      const digs = digsToOwn(r.st, r.pi, x.hex, r.link, r.dist);
      intent.hexBonus[x.hex] = (intent.hexBonus[x.hex] || 0) + 4 + 0.25 * x.worth;
      intent.build.push({ hex: x.hex, bonus: 0.4 * x.worth });
      if (digs <= 1) intent.reserve = Math.max(intent.reserve, 3);
      intent.goals.push({ hex: x.hex, per: Math.min(3, x.worth / (x.steps + 1)) });
    },
    gain(st, pi, x) { return E.villageKeys(st, x.hex) * st.config.vpPerKey * Math.max(1, E.score(st, pi).lanes.find((l) => l.mult === "special")?.m || 1) + 4; },
    contested(st, x) { const h = st.board.hexes[x.hex]; return h.slots - (st.buildings[x.hex] || []).length; },
  },

  // Open a source: a camp on a forest or a quarry on a stone hill, as the first building there.
  source: {
    propose(r) {
      const { st, pi } = r, out = [];
      const mine = { wood: 0, stone: 0 }, all = { wood: 0, stone: 0 };
      for (const hk of Object.keys(st.buildings)) {
        const m = st.board.hexes[hk].material, o = E.extractorOwner(st, hk);
        if (o === undefined || mine[m] === undefined) continue;
        all[m]++; if (o === pi) mine[m]++;
      }
      // What I still hold that will want loads of each material.
      const wants = { wood: 0, stone: 0 };
      for (const bt of st.buildingTypes) for (const need of bt.needs || []) if (wants[need] !== undefined) wants[need] += tokensLeft(st, pi, bt.id);
      const later = (1 - r.share) * (0.5 + r.o.patience);
      for (const [hk, h] of Object.entries(st.board.hexes)) {
        const type = SOURCE_OF[h.material];
        if (!type || (st.buildings[hk] || []).length || h.slots <= 0 || !tokensLeft(st, pi, type)) continue;
        if (E.inlandClosed(st) && E.isInland(st, hk)) continue;
        const digs = digsToOwn(st, pi, hk, r.link, r.dist);
        if (digs > 8) continue;
        const worth = 4 + (mine[h.material] ? 0.5 : 1.2) * Math.min(4, wants[h.material]) * later + (all[h.material] ? 0 : 3);
        out.push({ kind: "source", hex: hk, type, worth, steps: digs * r.wait.dig + r.wait.build, label: `open a ${type} at ${hk}` });
      }
      return out;
    },
    status(st, pi, x) {
      const o = E.extractorOwner(st, x.hex);
      if (o === pi) return { s: "done" };
      if ((st.buildings[x.hex] || []).length) return { s: "dead", why: "the site is built on", by: "other" };
      if (!tokensLeft(st, pi, x.type)) return { s: "dead", why: `no ${x.type} left on the board`, by: "self" };
      return { s: "live" };
    },
    steer(r, x, intent) {
      const digs = digsToOwn(r.st, r.pi, x.hex, r.link, r.dist);
      intent.hexBonus[x.hex] = (intent.hexBonus[x.hex] || 0) + 3 + 0.4 * x.worth;
      intent.build.push({ hex: x.hex, type: x.type, bonus: 0.6 * x.worth });
      if (digs <= 1) intent.reserve = Math.max(intent.reserve, 2);
      intent.goals.push({ hex: x.hex, per: Math.min(2.5, x.worth / (x.steps + 1)) });
    },
    contested: () => 1,
  },

  // Raise one of the buildings that score: save for it and take it when it can be had.
  raise: {
    propose(r) {
      const { st, pi } = r, out = [];
      const haul = st.config.materials ? E.hauls(st) : undefined;
      for (const bt of st.buildingTypes) {
        if (!LATE(bt) || !tokensLeft(st, pi, bt.id)) continue;
        // The cheapest place it could go now, whatever the shells in hand.
        let price = Infinity;
        for (const [hk, h] of Object.entries(st.board.hexes)) {
          if (!freeSlot(st, hk) || !E.ownCanalAt(st, hk, pi, r.link)) continue;
          if (E.canalsAround(st, hk) < bt.minCanals || (bt.site && h.material !== bt.site)) continue;
          if (E.inlandClosed(st) && E.isInland(st, hk)) continue;
          const pr = E.buildPrice(st, hk, bt.id, pi, haul);
          if (pr.ok && pr.total < price) price = pr.total;
        }
        if (price > 14) continue;
        const worth = bt.vp * Math.max(1, r.lane.dig?.m || 1) + 2;
        out.push({ kind: "raise", type: bt.id, worth, price, had: r.p.stats.builtByType?.[bt.id] || 0, steps: Math.max(r.wait.build, Math.ceil((price - r.p.money) / Math.max(2, r.p.income || 2))), label: `raise a ${bt.name}` });
      }
      return out;
    },
    status(st, pi, x) {
      if ((st.players[pi].stats.builtByType?.[x.type] || 0) > x.had) return { s: "done" };
      if (!tokensLeft(st, pi, x.type)) return { s: "dead", why: `no ${x.type} left on the board`, by: "self" };
      return { s: "live" };
    },
    steer(r, x, intent) {
      intent.build.push({ type: x.type, bonus: 0.35 * x.worth });
      // Keep the price back once it is in sight, so a turn's small buys do not eat it.
      if (r.p.money >= 0.5 * x.price) intent.reserve = Math.max(intent.reserve, Math.min(x.price, 9));
    },
    gain(st, pi, x) {
      let vp = 0;
      for (const [hk, list] of Object.entries(st.buildings)) for (const b of list) if (b.p === pi && b.type === x.type) vp = Math.max(vp, E.buildingVP(st, hk, b));
      return vp * Math.max(1, E.score(st, pi).lanes.find((l) => l.mult === "dig")?.m || 1) + 2;
    },
  },

  // Step a tale: the cards of one colour that bring its next multiplier.
  step: {
    propose(r) {
      const { st } = r, out = [];
      const later = (1 - r.share) * (0.5 + r.o.patience);
      for (const role of LANES) {
        const c = r.sc.counts[role] || 0, next = E.nextStep(st.config, c);
        if (!next) continue;
        const need = next.at - c, l = r.lane[role];
        // The tale's points now, and what the rest of the game should add to them.
        const worth = (next.m - (l?.m || 0)) * ((l?.s || 0) * (1 + 0.8 * later) + 6 * later);
        if (need > 3 || worth < 4) continue;
        out.push({ kind: "step", role, at: next.at, m0: l?.m || 0, m1: next.m, worth, steps: need * r.wait.buy, label: `bring the ${role} tale to ×${next.m}` });
      }
      return out;
    },
    status(st, pi, x) {
      return (E.score(st, pi).counts[x.role] || 0) >= x.at ? { s: "done" } : { s: "live" };
    },
    steer(r, x, intent) {
      intent.buyRole[x.role] = (intent.buyRole[x.role] || 0) + Math.min(6, 2 + 0.25 * x.worth);
    },
    gain(st, pi, x) { return (x.m1 - x.m0) * (E.score(st, pi).lanes.find((l) => l.mult === x.role)?.s || 0); },
  },

  // Reach a find: be the one whose dig opens a hex with a discovery on it.
  find: {
    propose(r) {
      const { st, pi } = r, out = [];
      const net = E.networkHexes(st, r.link);
      for (const [hk, h] of Object.entries(st.board.hexes)) {
        if (!h.bonus || st.claimed[hk] !== undefined || net.has(hk) || h.shore) continue;
        if (E.inlandClosed(st) && E.isInland(st, hk)) continue;
        const digs = digsToOwn(st, pi, hk, r.link, r.dist);
        if (digs > 5) continue;
        const worth = effectWorth(r, h.bonus) + Math.max(1, r.lane.buy?.m || 1) * E.hexReach(st, hk);
        out.push({ kind: "find", hex: hk, worth, steps: digs * r.wait.dig, label: `reach the find at ${hk}` });
      }
      return out;
    },
    status(st, pi, x) {
      const c = st.claimed[x.hex];
      if (c === pi) return { s: "done" };
      if (c !== undefined) return { s: "dead", why: "another family found it first", by: "other" };
      if (E.isOpened(st, x.hex)) return { s: "dead", why: "opened, the find gone", by: "other" };
      return { s: "live" };
    },
    steer(r, x, intent) {
      intent.hexBonus[x.hex] = (intent.hexBonus[x.hex] || 0) + 3 + 0.5 * x.worth;
      intent.goals.push({ hex: x.hex, per: Math.min(2.5, x.worth / (x.steps + 1)) });
    },
    contested: () => 1,
  },

  // Empty the three slots of a lodge sector, for its mastery.
  hall: {
    propose(r) {
      const { st, pi } = r, out = [];
      if (!st.tech || E.techLevel(st) < 3) return out;
      const p = r.p, limit = st.config.capstoneLimit || Infinity;
      if (E.capstonesOf(st, pi).length >= limit) return out;
      const taken = p.taken || [];
      for (const sector of st.tech.sectors) {
        if ((st.capstones || {})[sector] !== undefined) continue;
        const slots = st.tech.slots.filter((x) => x.sector === sector), left = slots.filter((x) => !taken.includes(x.id));
        if (!left.length || left.length > 2) continue;
        const worth = masteryWorth(r, sector) - 1.5 * left.length;
        if (worth < 4) continue;
        out.push({ kind: "hall", sector, slots: left.map((x) => ({ id: x.id, type: x.token })), worth, steps: left.length * r.wait.build, label: `empty the ${sector} sector for its mastery` });
      }
      return out;
    },
    status(st, pi, x) {
      const holder = (st.capstones || {})[x.sector];
      if (holder === pi) return { s: "done" };
      if (holder !== undefined) return { s: "dead", why: "another family took the mastery", by: "other" };
      if (E.capstonesOf(st, pi).length >= (st.config.capstoneLimit || Infinity)) return { s: "dead", why: "it holds all the masteries it may", by: "self" };
      return { s: "live" };
    },
    steer(r, x, intent) {
      const taken = r.p.taken || [];
      const left = x.slots.filter((y) => !taken.includes(y.id));
      for (const y of left) intent.build.push({ type: y.type, slot: y.id, bonus: 0.4 * x.worth / Math.max(1, left.length) });
    },
    gain(st, pi, x) {
      if ((st.capstones || {})[x.sector] !== pi) return 0;
      const without = { ...st, capstones: { ...st.capstones } };
      delete without.capstones[x.sector];
      return E.score(st, pi).total - E.score(without, pi).total;
    },
  },

  // Take a prize of the coast before the second tide.
  prize: {
    propose(r) {
      const { st, pi } = r, out = [];
      if (!st.config.firstActPrizes || !E.prizesOpen(st)) return out;
      const built = Object.values(st.buildings).flat().filter((b) => b.p === pi).length;
      for (const x of E.prizeList(st)) {
        if ((st.prizes || {})[x.id] !== undefined || !["builds3", "wharf", "marsh"].includes(x.id)) continue;
        const worth = effectWorth(r, x.code) + 1;
        if (x.id === "builds3") out.push({ kind: "prize", id: x.id, worth, steps: Math.max(1, 3 - built) * r.wait.build, label: `be first to three buildings` });
        else if (x.id === "wharf" && tokensLeft(st, pi, "wharf")) out.push({ kind: "prize", id: x.id, worth, steps: r.wait.build, label: "be first to a Wharf" });
        else if (x.id === "marsh") {
          let best = null, bd = Infinity;
          for (const [hk, h] of Object.entries(st.board.hexes)) {
            if (h.feature !== "marsh" || (E.inlandClosed(st) && E.isInland(st, hk))) continue;
            const d = digsToOwn(st, pi, hk, r.link, r.dist);
            if (d < bd) { bd = d; best = hk; }
          }
          if (best && bd <= 4) out.push({ kind: "prize", id: x.id, hex: best, worth, steps: bd * r.wait.dig, label: `be first beside a marsh (${best})` });
        }
      }
      return out;
    },
    status(st, pi, x) {
      const w = (st.prizes || {})[x.id];
      if (w === pi) return { s: "done" };
      if (w !== undefined) return { s: "dead", why: "another family took the prize", by: "other" };
      if (!E.prizesOpen(st)) return { s: "dead", why: "the second tide came", by: "table" };
      return { s: "live" };
    },
    steer(r, x, intent) {
      if (x.id === "wharf") intent.build.push({ type: "wharf", bonus: 0.6 * x.worth });
      else if (x.id === "builds3") intent.build.push({ bonus: 0.3 * x.worth });
      else if (x.id === "marsh") { intent.hexBonus[x.hex] = (intent.hexBonus[x.hex] || 0) + 3 + 0.5 * x.worth; intent.goals.push({ hex: x.hex, per: Math.min(2, x.worth / (x.steps + 1)) }); }
    },
    contested: () => 1,
  },

  // Gather shells for something dear: keep them back, and value each one more until the sum is there.
  gather: {
    propose(r, hint) {
      if (!hint || hint.price <= r.p.money + 1) return [];
      const target = Math.min(hint.price, r.p.money + 12);
      const steps = Math.ceil((target - r.p.money) / Math.max(2, r.p.income || 2));
      return [{ kind: "gather", target, by: r.st.round + 2 * steps + 2, worth: 0.3 * hint.worth + 1, steps, label: `gather ${target} shells` }];
    },
    status(st, pi, x) {
      if (st.players[pi].money >= x.target) return { s: "done" };
      if (st.round > x.by) return { s: "dead", why: "too slow coming", by: "self" };
      return { s: "live" };
    },
    steer(r, x, intent) {
      intent.reserve = Math.max(intent.reserve, Math.round(0.8 * x.target));
      intent.terms.push((s2, p2) => 0.3 * Math.min(s2.players[p2].money, x.target));
    },
  },

  // Thin the deck: throw out starting cards while there is time to draw the gain.
  thin: {
    propose(r) {
      const { st } = r, n = startersOwned(st, r.p);
      if (n < 3 || r.left < 12) return [];
      const can = E.marketCards(st).some((u) => thins(E.def(st, u))) || E.ownedCards(r.p).some((u) => thins(E.def(st, u)));
      if (!can) return [];
      return [{ kind: "thin", worth: 1.2 * (n - 2) * (1 - r.share) * (0.5 + r.o.patience) + 1, steps: 2 * (n - 2), label: `thin the deck (${n} starting cards)` }];
    },
    status(st, pi, x) {
      if (startersOwned(st, st.players[pi]) <= 2) return { s: "done" };
      if (E.roundsLeft(st) < 8) return { s: "dead", why: "too near the end to draw the gain", by: "table" };
      return { s: "live" };
    },
    steer(r, x, intent) { intent.thin = true; intent.buyTrash = Math.max(intent.buyTrash || 0, 3); },
  },

  // End it, or stave the end off: link the highland villages while ahead, keep away from them while behind.
  end: {
    propose(r) {
      const { st, pi } = r, cfg = st.config;
      if (!cfg.endOnKeys) return [];
      const band = cfg.endKeysBand || "";
      const villages = Object.keys(st.board.hexes).filter((hk) => st.board.hexes[hk].isKey && (!band || E.bandOf(st, hk) === band));
      const net = E.networkHexes(st, r.link);
      const need = Math.max(1, Math.ceil(villages.length * Math.min(1, Math.max(0, Number(cfg.endKeysShare ?? 1))) - 1e-9));
      const linked = villages.filter((hk) => net.has(hk)).length, open = villages.filter((hk) => !net.has(hk));
      if (!open.length || linked < need - 2) return [];
      const lead = margin(st, pi);
      if (lead > 6) {
        // The nearest unlinked villages, by digs from anyone's water.
        const near = open.map((hk) => ({ hk, d: digsToOwn(st, pi, hk, r.link, r.dist) })).filter((x) => x.d <= 6).sort((a, b) => a.d - b.d).slice(0, need - linked);
        if (!near.length) return [];
        return [{ kind: "end", mode: "hasten", hexes: near.map((x) => x.hk), worth: 4 + 0.3 * lead, steps: near.reduce((a, x) => a + x.d, 0) * r.wait.dig, label: `hasten the end (link ${near.map((x) => x.hk).join(", ")})` }];
      }
      if (lead < -8 && linked >= need - 1) return [{ kind: "end", mode: "stave", hexes: open, worth: 4 + 0.3 * -lead, steps: 4, label: "stave off the end" }];
      return [];
    },
    status(st, pi, x) {
      const lead = margin(st, pi);
      if (x.mode === "hasten" && lead < 0) return { s: "dead", why: "the lead went", by: "other" };
      if (x.mode === "stave" && lead > 0) return { s: "done" };
      if (x.mode === "hasten" && x.hexes.every((hk) => E.networkHexes(st).has(hk))) return { s: "done" };
      return { s: "live" };
    },
    steer(r, x, intent) {
      const net = E.networkHexes(r.st, r.link);
      for (const hk of x.hexes) {
        if (net.has(hk)) continue;
        if (x.mode === "hasten") { intent.hexBonus[hk] = (intent.hexBonus[hk] || 0) + 4 + 0.4 * x.worth; intent.goals.push({ hex: hk, per: Math.min(3, x.worth / (x.steps + 1)) }); }
        else intent.hexBonus[hk] = (intent.hexBonus[hk] || 0) - 8;   // a canal on its border would link it
      }
    },
  },
};
export const KIND_NAMES = Object.keys(KINDS);

/** What a sector's mastery is worth to pi now (engine.js CAPSTONES), in rough points. */
function masteryWorth(r, sector) {
  const { st, lane, sc } = r, cfg = st.config;
  const two = (role) => { const c = sc.counts[role] || 0, l = lane[role]; return (multAt(cfg, c + 2) - multAt(cfg, c)) * (l?.s || 0) * 1.3; };
  switch (sector) {
    case "Works": return 4 * Math.max(1, lane.dig?.m || 1);
    case "Barges": return two("buy");
    case "Market": return two("build");
    case "Stores": return Math.max(...["build", "buy", "special"].map(two));
    case "Channels": return 4 * Math.max(1, lane.buy?.m || 1);
    case "Pearls": return Math.min(4, r.p.pearls || 0) * Math.max(1, lane.buy?.m || 1);
    default: return 6;
  }
}

const sameProject = (a, b) => a.kind === b.kind && a.hex === b.hex && a.type === b.type && a.role === b.role && a.sector === b.sector && a.id === b.id && a.mode === b.mode;

/** The intent a set of live projects gives the tactics, in the present position. */
export function steer(st, pi, projects, temper = null, leaning = null, cardWorth = null) {
  if (!projects.length) return cardWorth ? { hexBonus: {}, build: [], buyRole: {}, reserve: 0, goals: [], terms: [], cardWorth } : null;
  const r = read(st, pi);
  const intent = { hexBonus: {}, build: [], buyRole: {}, reserve: 0, goals: [], terms: [] };
  for (const x of projects) KINDS[x.kind].steer(r, x, intent);
  // Temperament: an opportunist steers less hard; a cautious one keeps a little back.
  const scale = temper ? clip(1.2 - 0.7 * temper.opportunism, 0.4, 1.4) : 1;
  if (scale !== 1) {
    for (const k of Object.keys(intent.hexBonus)) intent.hexBonus[k] *= scale;
    for (const w of intent.build) w.bonus *= scale;
    for (const k of Object.keys(intent.buyRole)) intent.buyRole[k] *= scale;
    for (const g of intent.goals) g.per *= scale;
  }
  if (temper?.caution) intent.reserve = Math.max(intent.reserve, Math.round(4 * temper.caution));
  if (leaning && leaning !== "even") intent.buyRole[leaning] = (intent.buyRole[leaning] || 0) + 1.5;
  if (cardWorth) intent.cardWorth = cardWorth;
  const goals = intent.goals, terms = intent.terms;
  if (goals.length || terms.length) {
    // Progress: each dig nearer a place being made for is worth something this turn.
    const start = goals.map((g) => digsToOwn(st, pi, g.hex, r.link, r.dist));
    intent.progress = (s2, p2) => {
      let v = 0;
      if (goals.length) {
        const link = E.linkedNetwork(s2), dist = digsFromNetwork(s2, link);
        goals.forEach((g, i) => { const d = digsToOwn(s2, p2, g.hex, link, dist); if (Number.isFinite(start[i]) && Number.isFinite(d)) v += g.per * (start[i] - d); });
      }
      for (const t of terms) v += t(s2, p2);
      return v;
    };
  }
  return intent;
}

// --------------------------------------------------------------------------- //
// The bot
// --------------------------------------------------------------------------- //

const DEFAULTS = {
  memory: "expert",   // novice | regular | expert
  bundles: 8,         // candidate sets of projects at a planning moment
  worlds: 1,          // sampled worlds every candidate is played in
  more: 1,            // more worlds for the best three and the present set
  last: 2,            // and more again for the best and the present set
  horizon: 6,         // rounds played on in each
  hold: 3,            // most projects held at once
  clock: 8,           // rounds without a reason before it plans anyway
  rivals: true,       // read rivals' projects and let them follow them in rollouts (with regard > 0)
  learn: true,        // draw from its beliefs; finish() updates them
  steerOff: false,    // true: plans and logs, but plays plain greedy (for tests)
  useJudge: true,     // judge rollouts' ends with the learned correction, once learned
  useCards: true,     // let what it has learned of the animals steer its buys, once learned
  // Tactics: "greedy" plays the steered greedy turn; "search" puts it through the Strong seat's
  // search each turn (planner.js, anchored): the steered turn stands unless a rollout beats it.
  tactics: "greedy",
  searchBudget: 36,   // rollouts a turn for "search", as the Strong seat
  searchWinFirst: true,   // the search judges by the win-first reward
  // Temperament (planning-bots.md 4.5).
  commitment: 2,      // points another bundle must gain over the present one, beyond the noise, to replace it
  opportunism: 0.3,   // 0: steers hard; 1: barely, taking what comes
  regard: 0.5,        // 0: plans as if alone; 1: watches rivals' projects, races and gives way
  caution: 0.25,      // shells kept back while it has a project: 4 × caution
  patience: 0.5,      // weight on gains that come late in the game
};

export class ProjectBot {
  constructor(name = "projects", seed = 1, opts = {}) {
    this.name = name;
    this.o = { ...DEFAULTS, ...opts };
    this.rng = makeRng(seed);
    this.projects = [];
    this.history = [];            // the plan log
    this.records = [];            // every project held, and how it went
    this.seen = null;             // what it saw when it last planned
    this.leaning = null;
    this.rivalsRead = {};         // seat -> { projects, dist: { hex: digs } }
    this.shared = opts.shared !== undefined ? opts.shared : null;   // beliefs; null: by level, from setSharedBeliefs
    this.own = opts.own || null;
    this.belief = null;           // this game's draw
    this.tally = { plans: 0, self: 0, other: 0, table: 0, clock: 0, done: 0, blocked: 0, dropped: 0, changed: 0, late: 0, early: 0, leanings: 0 };
  }

  get beliefsShared() { return this.shared || sharedBeliefs(this.o.memory); }

  /** The game's draw from its beliefs, and its leaning to start on. */
  begin(st, me) {
    const rnd = this.rng;
    const learn = this.o.learn;
    this.belief = learn ? drawBeliefs(this.beliefsShared, this.own, rnd, KIND_NAMES) : null;
    const p = st.players[me];
    this.key = `${st.harbours?.[me] || "-"}|${p.startTech ? E.techSlot(st, p.startTech)?.tech : "-"}`;
    // Leanings are private experience: without its own file a bot starts even.
    this.leaning = this.o.leaning || (learn && this.own ? drawLeaning(this.own, this.key, rnd) : "even");
    this.startLeaning = this.leaning;
    // The learned judgements, drawn for this game once there is enough behind them.
    const sh = this.beliefsShared;
    this.judgeW = learn && this.o.useJudge && sh?.judge?.n >= (this.o.judgeMin ?? JUDGE.minGames) ? ridgeDraw(sh.judge, JUDGE.lambda, rnd) : null;
    this.cardW = null;
    if (learn && this.o.useCards && sh?.cards?.n >= (this.o.cardsMin ?? CARDS.minRows)) {
      const w = ridgeDraw(sh.cards, CARDS.lambda, rnd);
      this.cardW = Object.fromEntries(sh.cards.keys.map((k, i) => [k, clip(w[i + 1], -CARDS.cap, CARDS.cap)]));
    }
    this.positions = [];
    this.bought = {};
    this.ownedSeen = null;
  }

  /** A position's worth to me: the reward by the hand-set reckoning, and the learned correction to it. */
  judge(st, me) {
    const base = positionReward(st, me, margin(st, me));
    if (!this.judgeW || st.over) return base;
    const x = scaledFeatures(st, me);
    let c = 0; for (let i = 0; i < x.length; i++) c += this.judgeW[i] * x[i];
    return base + c;
  }

  /** What owning one more of this animal is worth now, by what this bot has learned (for its buys). */
  cardWorth(st) {
    if (!this.cardW) return null;
    const t = E.tideNow(st), w = this.cardW;
    return (uid) => CARDS.weight * (w[`${st.cards[uid]}|${t}`] || 0);
  }

  /** Each turn: the position, for learning to judge; and animals bought since last time, by tide. */
  observe(st, me, position = true) {
    if (!this.o.learn || !this.positions) return;
    if (position) this.positions.push({ x: scaledFeatures(st, me), base: positionReward(st, me, margin(st, me)) });
    const now = {};
    for (const u of E.ownedCards(st.players[me])) { const id = st.cards[u]; if (!String(st.defs[id]?.deck).startsWith("start")) now[id] = (now[id] || 0) + 1; }
    if (this.ownedSeen) for (const [id, n] of Object.entries(now)) {
      const more = n - (this.ownedSeen[id] || 0);
      if (more > 0) { const k = `${id}|${E.tideNow(st)}`; this.bought[k] = (this.bought[k] || 0) + more; }
    }
    this.ownedSeen = now;
  }

  /** A kind's belief this game: { turns, gain, success }. */
  bel(kind) { return this.belief?.[kind] || { turns: 1, gain: 1, success: 1 }; }

  /** Reasons to stop and think, largest first: [{ trigger, by, large }]. */
  reasons(st, me) {
    const out = [];
    if (!this.seen) return [{ trigger: "the game begins", by: "table", large: true }];
    const left = E.roundsLeft(st);
    if (E.tideNow(st) !== this.seen.tide) out.push({ trigger: `the tide turned (${E.tideNow(st)})`, by: "table", large: true });
    for (const mark of [10, 5]) if (this.seen.left > mark && left <= mark) out.push({ trigger: `the end is about ${mark} rounds off`, by: "table", large: mark === 10 });
    // Its projects: finished, or dead.
    const live = [];
    let deaths = 0;
    for (const x of this.projects) {
      const s = KINDS[x.kind].status(st, me, x);
      if (s.s === "done") { out.push({ trigger: `done: ${x.label}${this.timing(st, x)}`, by: "self" }); this.close(st, x, "done"); }
      else if (s.s === "dead") {
        deaths++;
        out.push({ trigger: `lost: ${x.label} (${s.why})`, by: s.by || "other" });
        this.close(st, x, s.by === "other" ? "lost" : "dropped");
      } else {
        live.push(x);
        // Late: well past what it expected. Worth a look once.
        if (!x.lateSeen && st.round - x.born > x.expect.turns + 3) { x.lateSeen = true; out.push({ trigger: `${x.label} is running late`, by: "self" }); }
      }
    }
    if (deaths >= 2) out.push({ trigger: "two projects gone at once", by: "self", large: true });
    this.projects = live;
    // A rival's canal has come to a place it is making for, and the place cannot take both.
    const link = E.linkedNetwork(st);
    for (const x of live) {
      if (!x.hex || !KINDS[x.kind].contested) continue;
      const rivals = st.players.map((_, i) => i).filter((i) => i !== me && E.ownCanalAt(st, x.hex, i, link)).length;
      if (rivals > (this.seen.rivals[x.hex] || 0) && rivals >= KINDS[x.kind].contested(st, x)) out.push({ trigger: `a rival's canal has reached ${x.hex}`, by: "other" });
    }
    // With nothing in hand it looks again sooner, but not every turn.
    const wait = live.length ? this.o.clock : Math.ceil(this.o.clock / 2);
    if (!out.length && st.round - this.seen.round >= wait) out.push({ trigger: live.length ? `${wait} rounds on` : "nothing in hand", by: "clock" });
    return out;
  }

  /** " (2 rounds late)" / " (on time)" / " (1 round early)". */
  timing(st, x) {
    const d = st.round - x.born - x.expect.turns;
    if (Math.abs(d) <= 1) return " (on time)";
    return ` (${Math.abs(d)} rounds ${d > 0 ? "late" : "early"})`;
  }

  /** A project ends: record how it went. */
  close(st, x, outcome) {
    const turns = st.round - x.born, d = turns - x.expect.turns;
    if (outcome === "done") { this.tally.done++; if (d > 1) this.tally.late++; else if (d < -1) this.tally.early++; }
    else if (outcome === "lost") this.tally.blocked++;
    this.records.push({ kind: x.kind, label: x.label, outcome, born: x.born, turns, expected: x.expect.turns, worth: x.worth0, project: x });
  }

  /** Projects proposed from pi's seat, rated: worth by belief and leaning, over the turns it should take. */
  proposals(st, me, r) {
    let props = [];
    for (const k of KIND_NAMES) if (k !== "gather") props.push(...KINDS[k].propose(r));
    const dear = props.filter((x) => x.kind === "raise").sort((a, b) => b.worth - a.worth)[0];
    props.push(...KINDS.gather.propose(r, dear));
    const lean = this.leaning;
    for (const x of props) {
      x.worth0 = x.worth;
      const b = this.bel(x.kind);
      const feeds = x.kind === "step" ? x.role : FEEDS[x.kind];
      const leanW = lean && lean !== "even" && feeds === lean ? 1.4 : 1;
      x.value = x.worth * b.gain * b.success * leanW * this.race(st, me, x, r);
      x.expectTurns = Math.max(1, Math.round(x.steps * b.turns));
      x.rate = x.value / (x.expectTurns + 1);
    }
    return props.sort((a, b) => b.rate - a.rate);
  }

  /**
   * Regard for others: a contested place a rival is making for, and nearer
   * to, is worth less to go for; one it is further from, a little more (a race
   * that can be won).
   */
  race(st, me, x, r) {
    const reg = this.o.regard;
    if (!reg || !x.hex || !KINDS[x.kind].contested) return 1;
    const mine = digsToOwn(st, me, x.hex, r.link, r.dist);
    let racing = 0, ahead = 0;
    for (const [seat, rd] of Object.entries(this.rivalsRead)) {
      if (!rd.projects.some((y) => y.hex === x.hex)) continue;
      racing++;
      if (digsToOwn(st, Number(seat), x.hex, r.link, r.dist) <= mine) ahead++;
    }
    if (!racing || racing < KINDS[x.kind].contested(st, x)) return 1;
    return ahead ? 1 - 0.6 * reg : 1 + 0.2 * reg;
  }

  /** What each rival appears to be making for: the projects that would suit it, favouring places it has been getting nearer to. */
  readRivals(st, me) {
    if (!this.o.rivals || !this.o.regard) { this.rivalsRead = {}; return; }
    const link = E.linkedNetwork(st), shared = { link, dist: digsFromNetwork(st, link), o: this.o };
    const out = {};
    for (let i = 0; i < st.players.length; i++) {
      if (i === me) continue;
      const r = read(st, i, shared), prev = this.rivalsRead[i]?.dist || {};
      const props = [];
      for (const k of ["befriend", "source", "find", "raise", "step"]) props.push(...KINDS[k].propose(r));
      const dist = {};
      for (const x of props) {
        x.rate = x.worth / (x.steps + 1);
        if (!x.hex) continue;
        const d = digsToOwn(st, i, x.hex, link, shared.dist);
        dist[x.hex] = d;
        if (prev[x.hex] !== undefined && d < prev[x.hex]) x.rate *= 1.6;   // it has been coming this way
      }
      props.sort((a, b) => b.rate - a.rate);
      const pick = [];
      for (const x of props) { if (pick.length >= 2) break; if (!pick.some((y) => y.kind === x.kind && x.kind !== "step")) pick.push(x); }
      out[i] = { projects: pick, dist };
    }
    this.rivalsRead = out;
  }

  /** The candidate sets: the present one, nothing, the best single projects, and pairs of them. */
  bundlesFor(st, me) {
    const r = read(st, me, { o: this.o });
    const props = this.proposals(st, me, r);
    // The best two of each kind, then the best seven of those.
    const per = {}, top = [];
    for (const x of props) { per[x.kind] = (per[x.kind] || 0) + 1; if (per[x.kind] <= 2) top.push(x); }
    const pick = top.slice(0, 7);
    const out = [];
    const add = (set) => { if (!out.some((o) => o.length === set.length && o.every((a) => set.some((b) => sameProject(a, b))))) out.push(set); };
    add(this.projects.slice());
    add([]);
    for (const x of pick.slice(0, 4)) add([x]);
    for (let i = 0; i < pick.length; i++) for (let j = i + 1; j < pick.length; j++) {
      if (pick[i].kind === pick[j].kind && pick[i].kind !== "step") continue;
      add([pick[i], pick[j]]);
    }
    // Carry on with what is in hand, plus one more.
    if (this.projects.length && this.projects.length < this.o.hold) for (const x of pick.slice(0, 3)) if (!this.projects.some((p) => sameProject(p, x))) add([...this.projects, x]);
    const rate = (set) => set.reduce((a, x) => a + (x.rate ?? 0), 0);
    const head = out.slice(0, 2), rest = out.slice(2).sort((a, b) => rate(b) - rate(a));
    return [...head, ...rest].slice(0, Math.max(2, this.o.bundles));
  }

  /** Play a bundle on from st in one sampled world; my margin at the end, by the greedy bot's value. */
  playout(st, me, bundle, seed) {
    const g = sampleWorld(st, me, this.o.memory, seed);
    let mine = bundle.slice();
    const theirs = {};
    for (const [i, rd] of Object.entries(this.rivalsRead)) theirs[i] = rd.projects.slice();
    const stop = g.round + Math.min(this.o.horizon, Math.ceil(E.roundsLeft(g)));
    let guard = 0;
    while (!g.over && g.round < stop && guard++ < 400) {
      const i = g.current;
      if (i === me) {
        mine = mine.filter((x) => KINDS[x.kind].status(g, me, x).s === "live");
        greedyTurn(g, null, steer(g, me, mine, this.o, this.leaning), { fast: true });
      } else if (theirs[i]?.length) {
        theirs[i] = theirs[i].filter((x) => KINDS[x.kind].status(g, i, x).s === "live");
        greedyTurn(g, null, steer(g, i, theirs[i]), { fast: true });
      } else greedyTurn(g, null, null, { fast: true });
    }
    return this.judge(g, me);
  }

  /**
   * Choose a bundle. Every candidate is played in one world; the best three
   * and the present set in more; the best and the present set in more again,
   * all on the same worlds, so the comparison is paired. The present set
   * stands unless the best beats it by the commitment plus the comparison's
   * own noise (its standard error).
   */
  plan(st, me, reasons) {
    if (!this.belief && this.o.learn) this.begin(st, me);
    if (!this.leaning) this.begin(st, me);
    const large = reasons.some((x) => x.large);
    const turnedFrom = large && this.seen ? this.reconsiderLeaning(st, me) : null;
    this.readRivals(st, me);
    const cands = this.bundlesFor(st, me).map((set) => ({ set, v: [] }));
    const now = cands[0];
    const seeds = [];
    const play = (list, k) => {
      for (let w = 0; w < k; w++) {
        const seed = Math.floor(this.rng() * 4294967296), at = seeds.length;
        seeds.push(seed);
        for (const c of list) c.v[at] = this.playout(st, me, c.set, seed);
      }
    };
    const mean = (c) => { const xs = c.v.filter((x) => x !== undefined); return xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length); };
    play(cands, Math.max(1, this.o.worlds));
    const fill = (list) => { for (const c of list) for (let w = 0; w < seeds.length; w++) if (c.v[w] === undefined) c.v[w] = this.playout(st, me, c.set, seeds[w]); };
    let alive = cands.slice().sort((a, b) => mean(b) - mean(a)).slice(0, 3);
    if (!alive.includes(now)) alive.push(now);
    if (this.o.more > 0 && cands.length > 1) play(alive, this.o.more);
    alive = alive.slice().sort((a, b) => mean(b) - mean(a)).slice(0, 1);
    if (!alive.includes(now)) alive.push(now);
    if (this.o.last > 0 && alive.length > 1) { fill(alive); play(alive, this.o.last); alive.sort((a, b) => mean(b) - mean(a)); }
    let best = alive[0];
    // Commitment: the present set stands unless the best clearly beats it.
    let kept = false;
    if (this.projects.length && best !== now) {
      const d = []; for (let w = 0; w < seeds.length; w++) if (best.v[w] !== undefined && now.v[w] !== undefined) d.push(best.v[w] - now.v[w]);
      const m = d.reduce((a, x) => a + x, 0) / Math.max(1, d.length);
      const sd = d.length > 1 ? Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1)) : Infinity;
      const se = sd / Math.sqrt(Math.max(1, d.length));
      if (!(m > this.o.commitment + se)) { best = now; kept = true; }
    }
    const had = this.projects.map((x) => x.label), took = best.set.map((x) => x.label);
    const dropped = this.projects.filter((x) => !best.set.some((y) => sameProject(x, y)));
    for (const x of dropped) this.close(st, x, "dropped");
    const changed = had.length !== took.length || dropped.length > 0;
    this.projects = best.set.slice(0, this.o.hold).map((x) => (x.born !== undefined ? x : { ...x, born: st.round, expect: { turns: x.expectTurns ?? x.steps } }));
    const by = reasons.some((x) => x.by === "other") ? "other" : reasons.some((x) => x.by === "table") ? "table" : reasons.some((x) => x.by === "self") ? "self" : "clock";
    this.tally.plans++; this.tally[by]++; this.tally.dropped += dropped.length; if (changed) this.tally.changed++;
    const nothing = cands.find((c) => !c.set.length);
    this.history.push({ round: st.round, why: reasons.map((x) => x.trigger), by, had, now: took, changed, kept, leaning: this.leaning, turnedFrom,
      expect: this.projects.map((x) => x.expect.turns), considered: cands.length, worlds: seeds.length,
      rivals: Object.fromEntries(Object.entries(this.rivalsRead).map(([i, rd]) => [i, rd.projects.map((x) => x.label)])),
      value: Number(mean(best).toFixed(1)), overNothing: nothing ? Number((mean(best) - mean(nothing)).toFixed(1)) : null });
    const link = E.linkedNetwork(st), sc = E.score(st, me);
    this.seen = { round: st.round, tide: E.tideNow(st), left: E.roundsLeft(st), mult: Object.fromEntries(sc.lanes.map((l) => [l.mult, l.m])), rivals: {} };
    for (const x of this.projects) if (x.hex) this.seen.rivals[x.hex] = st.players.map((_, i) => i).filter((i) => i !== me && E.ownCanalAt(st, x.hex, i, link)).length;
  }

  /**
   * The leaning, looked at again at a large moment: a tale whose expected
   * points have pulled clearly ahead of the one leaned on takes over (by its
   * commitment; an even leaning turns only for a tale that carries most of
   * the score).
   */
  reconsiderLeaning(st, me) {
    const sc = E.score(st, me), val = Object.fromEntries(sc.lanes.map((l) => [l.mult, l.m * l.s]));
    const total = Object.values(val).reduce((a, x) => a + x, 0);
    if (total <= 0) return null;
    const best = LANES.reduce((a, b) => (val[b] > val[a] ? b : a));
    const cur = this.leaning;
    const turn = cur === "even" ? val[best] > 0.45 * total : best !== cur && val[best] > (1.25 + 0.05 * this.o.commitment) * (val[cur] || 0);
    if (!turn || best === cur) return null;
    this.leaning = best; this.tally.leanings++;
    return cur;
  }

  playTurn(st) {
    if (st.turn?.phase !== "choose" || !E.currentPlayer(st).hand.length) return greedyTurn(st);
    const me = st.current;
    this.seat = me;
    const reasons = this.reasons(st, me);
    if (reasons.length) this.plan(st, me, reasons);
    this.observe(st, me);
    const cw = this.cardWorth(st);
    const steered = (g) => greedyTurn(g, null, this.o.steerOff ? null : steer(g, me, this.projects, this.o, this.leaning, cw), { fast: true });
    if (this.o.tactics !== "search") return steered(st);
    const search = makePlanner("planner", Math.floor(this.rng() * 1e9), [6, 4],
      { budget: this.o.searchBudget, anchor: true, margin: 0, anchorTurn: steered, winFirst: this.o.searchWinFirst });
    return search.playTurn(st);
  }

  /**
   * The game is over: close what is still held, measure what each finished
   * project brought, and update the beliefs (shared and own) in place.
   * Returns the game's lessons, for the learning report.
   */
  finish(st, me = this.seat) {
    if (me === undefined || me === null) return null;
    for (const x of this.projects) this.close(st, x, "dropped");
    this.projects = [];
    const fin = finalReward(st, me), m = fin.margin, R = fin.R;
    const lessons = { margin: m, won: fin.won, reward: R, leaning: this.startLeaning, key: this.key, kinds: {} };
    if (!this.o.learn) return lessons;
    const shared = this.beliefsShared, own = this.own;
    // The judgements: this game's positions against how it ended, and what was bought against how it ended.
    if (shared && this.positions?.length) {
      const J = (shared.judge ||= freshSums(FEATURE_SCALE.length)), w = 1 / this.positions.length;
      for (const x of this.positions) addRow(J, x.x, R - x.base, w);
      J.n++;
    }
    if (shared && this.bought) {
      this.observe(st, me, false);   // what was bought on the last turn
      const keys = cardKeys(st);
      const C = (shared.cards ||= freshSums(keys.length + 1, keys));
      if (C.keys.length === keys.length) {
        const x = [1, ...C.keys.map((k) => this.bought[k] || 0)];
        addRow(C, x, R);
        C.n++;
      }
    }
    for (const rec of this.records) {
      for (const b of [shared, own]) {
        if (!b) continue;
        const k = (b.kinds[rec.kind] ||= kindRecord());
        if (rec.outcome === "done") {
          k.done++;
          addStat(k.turns, clip(rec.turns / Math.max(1, rec.expected), 0, 5));
          const g = KINDS[rec.kind].gain;
          if (g && rec.worth > 0) addStat(k.gain, clip(g(st, me, rec.project) / rec.worth, 0, 5));
        } else if (rec.outcome === "lost") k.lost++;
        else k.dropped++;
      }
      const l = (lessons.kinds[rec.kind] ||= { done: 0, lost: 0, dropped: 0 });
      l[rec.outcome]++;
    }
    if (shared) { shared.games++; addStat(shared.table.rounds, st.round); }
    if (own) {
      own.games++;
      // Leanings are credited with the reward: a win counts for more than a high score.
      for (const key of [this.startLeaning, `${this.startLeaning}|${this.key}`]) addStat(own.leanings[key] ||= stat(), R);
    }
    return lessons;
  }

  /** The plan log in sentences, for a report. */
  story() {
    return this.history.map((h) => {
      const turned = h.turnedFrom ? ` Turns from leaning on ${h.turnedFrom} to leaning on ${h.leaning}.` : "";
      const what = h.changed ? (h.now.length ? `Now: ${h.now.join(", ")}` : "Now: no project, play as it comes") : h.now.length ? `Carries on with: ${h.now.join(", ")}` : "Still no project";
      return `Round ${h.round}: ${h.why.join("; ")}.${turned} ${what}.`;
    });
  }
}

/** "projects", "projects:novice", "projects:regular", "projects:expert"; opts as ProjectBot. */
export function makeProjectBot(name, seed = 1, opts = {}) {
  const [base, who] = name.split("@");
  const memory = base.includes(":") ? base.split(":")[1] : "expert";
  // "@A": a learner's own beliefs (a copy, so a game here does not change them).
  const own = who && ownBeliefs(`${memory}-${who}`) ? JSON.parse(JSON.stringify(ownBeliefs(`${memory}-${who}`))) : undefined;
  return new ProjectBot(name, seed, { ...(MEMORIES.includes(memory) ? { memory } : {}), ...(own ? { own } : {}), ...opts });
}

// --------------------------------------------------------------------------- //
// Beliefs between games: merging what parallel games learned, and reading them
// --------------------------------------------------------------------------- //

/** Add what a copy learned (after - before) into base, leaf by leaf: every belief is a sum of counts. */
export function addLearned(base, after, before) {
  for (const [k, v] of Object.entries(after || {})) {
    if (k === "d") { base.d ??= v; continue; }   // a regression's dimension: a size, not a count
    if (typeof v === "number") base[k] = (base[k] || 0) + v - (typeof before?.[k] === "number" ? before[k] : 0);
    else if (v && typeof v === "object") addLearned((base[k] ||= Array.isArray(v) ? [] : {}), v, before?.[k]);
    else if (base[k] === undefined) base[k] = v;
  }
  return base;
}

/** A level's beliefs in words-and-numbers, kind by kind, as a bot would act on them (no draw). */
export function describeBeliefs(shared, own = null) {
  const kinds = KIND_NAMES.map((k) => {
    const b = kindBelief(shared, own, k), s = shared?.kinds?.[k] || kindRecord(), o = own?.kinds?.[k];
    return { kind: k, turns: b.turns, gain: b.gain, success: b.done / (b.done + b.lost), seen: s.done + s.lost + s.dropped + (o ? o.done + o.lost + o.dropped : 0) };
  });
  const leanings = own ? LEANINGS.map((L) => { const x = own.leanings[L] || stat(); return { leaning: L, n: x.n, mean: x.n ? x.sum / x.n : null }; }) : [];
  const r = shared?.table?.rounds;
  return { games: shared?.games || 0, kinds, leanings, rounds: r?.n ? r.sum / r.n : null };
}

// Monte Carlo computer players with style sliders: the research bots, ported
// from sim/agent.py so the browser engine is the only rules engine
// (docs/simulation.md). Pure functions over engine state, no DOM.
//
// Each bot weighs its candidate plays (a card, and how many cards to discard
// for its boost) by playing each out a few rounds under a biased playout
// policy and scoring the result. The sliders shape the playout policy and the
// targets (where to dig, what to build, what to buy); the search decides which
// card to play. So sliders are style and the search is look-ahead.
//
//   const bot = new SearchBot("digger", preset("digger"), seed);
//   while (!s.over) bot.playTurn(s);        // or one bot per seat: playTurn(s) for the current seat
//
// Roles are lower case here ("dig"), as in the engine.

import * as E from "./engine.js";
import { makeRng, tokenValue } from "./agents.js";

// Weights for banked resources when a rollout stops short of the end, in VP.
const MONEY_VP = 0.3;
const INCOME_VP = 1.0;
const PEARL_VP = 0.8;   // a banked pearl: at least its cash, more as half an action
// A dig not linked to the sea: its hexes are credited as if about to open, so
// this outweighs that double count (sim/agent.py REMOTE_DIG).
const REMOTE_DIG = -6.0;
const LOOKAHEAD = 6;    // digs of steering toward a valuable hex

export const LANES = ["dig", "build", "buy", "special"];
const ROLES = ["dig", "build", "buy", "earn", "special"];

// --------------------------------------------------------------------------- //
// Sliders, plans and presets
// --------------------------------------------------------------------------- //

/** All in 0..1; 0.5 is neutral. rollouts/horizon/width are the search budget. */
export function sliders(o = {}) {
  return { dig: 0.5, build: 0.5, buy: 0.5, income: 0.5, special: 0.5, boost: 0.5, depth: 0.5, discovery: 0.5,
    thin: 0.5, hoard: 0.5, rollouts: 10, horizon: 4, width: 6, ...o };
}
const appetite = (s, role) => ({ dig: s.dig, build: s.build, buy: s.buy, earn: s.income, special: s.special })[role];

const norm = (w) => { const t = w.reduce((a, x) => a + x, 0) || 1; return w.map((x) => x / t); };

/**
 * A plan: weights on the four lanes (dig x buildings, build x deck VP,
 * buy x Reach, special x keys), optionally a second set from `switch` (a share
 * of the game) on, plus boost and hoard. The bot derives what to collect and do.
 */
export function plan({ early, late = null, switch: sw = 0.5, boost = 0.5, hoard = 0.5 }) {
  return { kind: "plan", early, late, switch: sw, boost, hoard };
}

function planWeights(p, frac) {
  const w = norm(p.late && frac >= p.switch ? p.late : p.early);
  return Object.fromEntries(LANES.map((l, i) => [l, w[i]]));
}

function planSliders(p, frac) {
  const w = planWeights(p, frac), clamp = (x) => Math.max(0.05, Math.min(0.95, x));
  return sliders({
    dig: clamp(0.3 + 0.65 * (w.buy + 0.4 * w.dig + 0.3 * w.special)),
    build: clamp(0.3 + 0.65 * (w.dig + 0.6 * w.special + 0.3 * w.build)),
    buy: clamp(0.45 + 0.45 * Math.max(...Object.values(w))),
    special: clamp(0.3 + 0.65 * (w.special + 0.6 * w.build)),
    income: 0.5, boost: p.boost, hoard: p.hoard, depth: clamp(0.35 + 0.6 * w.buy), discovery: 0.5, thin: 0.6,
  });
}

/** What owning one more card of each colour is worth to a plan, 0..1. */
function planOwn(p, frac) {
  const w = planWeights(p, frac);
  return { dig: w.dig, build: w.build, buy: w.buy, special: Math.min(1, w.special + 0.5 * w.build), earn: 0.15 };
}

export const PRESETS = {
  balanced: sliders(),
  digger: sliders({ dig: 0.95, build: 0.6, buy: 0.4, income: 0.45, depth: 0.85, discovery: 0.8, boost: 0.6 }),
  builder: sliders({ dig: 0.4, build: 0.95, buy: 0.4, income: 0.7, depth: 0.25, special: 0.6, hoard: 0.6 }),
  merchant: sliders({ dig: 0.35, build: 0.4, buy: 0.95, income: 0.6, special: 0.9, thin: 0.7, boost: 0.45 }),
  rusher: sliders({ dig: 0.7, build: 0.6, buy: 0.5, income: 0.3, boost: 0.95, hoard: 0.15, depth: 0.6 }),
  miser: sliders({ dig: 0.45, build: 0.6, buy: 0.3, income: 0.95, hoard: 0.9, boost: 0.3, thin: 0.8 }),
  prospector: sliders({ dig: 0.8, build: 0.35, buy: 0.45, income: 0.5, depth: 0.95, discovery: 0.95, boost: 0.7 }),
};

export const PLANS = {
  "lane-buildings": plan({ early: [1, 0, 0, 0] }),
  "lane-deck": plan({ early: [0, 1, 0, 0] }),
  "lane-reach": plan({ early: [0, 0, 1, 0] }),
  "lane-keys": plan({ early: [0, 0, 0, 1] }),
  "lane-even": plan({ early: [1, 1, 1, 1] }),
};

let ELITE = {};
/** Plans saved by tournaments (sim/presets/elite.json), as its `plans` object. */
export function setElite(plans) {
  ELITE = Object.fromEntries(Object.entries(plans || {}).map(([k, d]) =>
    [k, plan({ early: d.early, late: d.late || null, switch: d.switch ?? 0.5, boost: d.boost ?? 0.5, hoard: d.hoard ?? 0.5 })]));
}

export function preset(name) {
  if (PRESETS[name]) return { ...PRESETS[name] };
  if (PLANS[name]) return PLANS[name];
  if (ELITE[name]) return ELITE[name];
  throw new Error(`unknown preset ${name}; known: ${[...Object.keys(PRESETS), ...Object.keys(PLANS), ...Object.keys(ELITE)].join(", ")}`);
}
export const presetNames = () => [...Object.keys(PRESETS), ...Object.keys(PLANS), ...Object.keys(ELITE)];

// --------------------------------------------------------------------------- //
// Lane priors (bots/lane-priors.json, "search"; sim/agent.py read "python"):
// a bot's mean final count per scoring colour. It expects to end with its
// current count plus the growth still to come: count + (1 - f) * prior.
// --------------------------------------------------------------------------- //

const DEFAULT_PRIOR = { dig: 2, build: 2, buy: 2, special: 2 };
let PRIORS = {};
/** name -> { dig, build, buy, special } (keys in any case); "*" is every bot. */
export function setSearchPriors(table) {
  PRIORS = {};
  for (const [name, row] of Object.entries(table || {})) {
    if (!row || typeof row !== "object") continue;
    PRIORS[name] = {};
    for (const [k, v] of Object.entries(row)) if (LANES.includes(k.toLowerCase()) && Number.isFinite(v)) PRIORS[name][k.toLowerCase()] = v;
  }
}
export const priorFor = (name) => ({ ...DEFAULT_PRIOR, ...(PRIORS["*"] || {}), ...(PRIORS[name] || {}) });

// --------------------------------------------------------------------------- //
// Board geometry, worked out once per board
// --------------------------------------------------------------------------- //

const GEO = new WeakMap();
function geometry(board) {
  let g = GEO.get(board);
  if (g) return g;
  const edges = Object.keys(board.edges);
  const byCorner = {};
  for (const ek of edges) for (const c of E.edgeCorners(ek)) (byCorner[c] ||= []).push(ek);
  const adj = Object.fromEntries(edges.map((ek) => [ek, [...new Set(E.edgeCorners(ek).flatMap((c) => byCorner[c]))].filter((n) => n !== ek)]));
  const incident = {};
  for (const ek of edges) { const e = board.edges[ek]; (incident[e.a] ||= []).push(ek); (incident[e.b] ||= []).push(ek); }
  const water = (hk) => board.terrain[board.hexes[hk].terrain].water;
  // For each edge: [hex, digs still needed after it to reach one of the hex's borders], within LOOKAHEAD.
  const near = Object.fromEntries(edges.map((ek) => [ek, []]));
  for (const hk of Object.keys(board.hexes)) {
    if (water(hk) || !incident[hk]) continue;
    const dist = new Map(incident[hk].map((ek) => [ek, 0]));
    let frontier = [...dist.keys()];
    while (frontier.length) {
      const next = [];
      for (const ek of frontier) {
        if (dist.get(ek) >= LOOKAHEAD) continue;
        for (const n of adj[ek]) if (!dist.has(n)) { dist.set(n, dist.get(ek) + 1); next.push(n); }
      }
      frontier = next;
    }
    for (const [ek, d] of dist) if (d > 0) near[ek].push([hk, d]);
  }
  // Depth: hex steps from a harbour over land; a harbour is 1 (sim/content.py).
  const depth = {};
  const harbours = Object.values(board.hexes).filter((h) => h.harbour && !water(h.key));
  const queue = (harbours.length ? harbours : Object.values(board.hexes).filter((h) => h.shore)).map((h) => h.key);
  queue.forEach((hk) => (depth[hk] = 1));
  for (let i = 0; i < queue.length; i++) {
    const h = board.hexes[queue[i]];
    for (const [dq, dr] of E.NEIGHBOURS) {
      const k = E.hexKey(h.q + dq, h.r + dr);
      if (board.hexes[k] && !water(k) && depth[k] === undefined) { depth[k] = depth[queue[i]] + 1; queue.push(k); }
    }
  }
  g = { edges, near, depth, water };
  GEO.set(board, g);
  return g;
}

// --------------------------------------------------------------------------- //
// The bot
// --------------------------------------------------------------------------- //

const share = (s) => { const done = s.round - 1; return done / Math.max(1, done + E.roundsLeft(s)); };

/** Hexes beside this player's linked canals. */
function touched(s, pi, link) {
  const out = new Set();
  for (const [ek, o] of Object.entries(s.dug)) {
    if (o !== pi || !link.edges.has(ek)) continue;
    const e = s.board.edges[ek];
    out.add(e.a); out.add(e.b);
  }
  return out;
}

/** Discard counts (or a colour) that could pay this card's boost; 0 is no boost. */
function boostOptions(s, uid, rest) {
  const d = E.def(s, uid), bc = d.boostCost;
  if (bc.kind === "none" || !d.boost.length) return [0];
  if (bc.kind === "threshold") return rest.length >= bc.n ? [0, bc.n] : [0];
  if (bc.kind === "scalar") return [0, ...rest.map((_, i) => i + 1)];
  if (bc.kind === "colour") return rest.some((u) => E.def(s, u).role === bc.role) ? [0, bc.role] : [0];
  return [0];
}

export function legalMoves(s) {
  const hand = E.currentPlayer(s).hand;
  const moves = hand.flatMap((uid) => boostOptions(s, uid, hand.filter((u) => u !== uid)).map((opt) => ({ uid, opt })));
  // Forage (brainstorm-stage-3.md 6.3): one card of each design face down, or the whole hand.
  const seen = new Set();
  for (const uid of hand) {
    const id = s.cards[uid];
    if (seen.has(id) || !E.canForage(s, uid).ok) continue;
    seen.add(id);
    moves.push({ uid, opt: "forage" });
  }
  if (hand.length > 1 && E.canForage(s, "hand").ok) moves.push({ uid: "hand", opt: "forage" });
  return moves;
}

/**
 * A token's worth on the technology board: its slot's printed income, less a
 * leap's pearl, plus a little for the slots it opens (new types to build).
 */
export function techValue(st, pi, typeId, left) {
  const slot = E.pickSlot(st, pi, typeId);
  if (!slot) return 0;
  let v = INCOME_VP * E.techSlot(st, slot.id).income;
  if (slot.leap) v -= PEARL_VP * st.config.techLeapCost;
  const taken = st.players[pi].taken;
  const opens = st.tech.adj[slot.id].filter((n) => n !== "centre" && !taken.includes(n) && !E.slotReachable(st, pi, n));
  return v + 0.4 * opens.length * left;
}

export class SearchBot {
  /** name picks the lane prior; style is sliders(...) or plan(...); search = [rollouts, width] overrides the budget. */
  constructor(name, style, seed = 1, search = null) {
    this.name = name;
    this.plan = style.kind === "plan" ? style : null;
    this.search = search;
    this.s = this.plan ? planSliders(this.plan, 0) : sliders(style);
    this.owns = this.plan ? planOwn(this.plan, 0) : null;
    this.rng = makeRng(seed);
    this.lanePrior = priorFor(name);
    this.fieldPrior = priorFor("*");
    this.seat = null;
    this.budget();
  }

  budget() { if (this.search) this.s = { ...this.s, rollouts: this.search[0], width: this.search[1] }; }

  phase(st) {
    if (!this.plan) return;
    const f = share(st);
    this.s = planSliders(this.plan, f);
    this.owns = planOwn(this.plan, f);
    this.budget();
  }

  // ---- card values ------------------------------------------------------ //

  cardValue(st, uid, weight = E.cardWeights(st)) {
    const d = E.def(st, uid);
    const want = this.owns ? this.owns[d.role] : appetite(this.s, d.role);
    let v = d.vp * 0.6 + want * (1 + weight(d));
    if (d.role === "earn") v -= 0.8 * this.s.thin;   // yellow scores nothing: tempo only
    return v;
  }

  pickDiscards(st, played, opt) {
    const weight = E.cardWeights(st);
    const pool = E.currentPlayer(st).hand.filter((u) => u !== played && (typeof opt !== "string" || E.def(st, u).role === opt));
    pool.sort((a, b) => this.cardValue(st, a, weight) - this.cardValue(st, b, weight));
    return pool.slice(0, typeof opt === "string" ? 1 : opt);
  }

  expectedCounts(st, pi, counts = E.score(st, pi).counts) {
    // The expected multiplier: the count expected at the end, through the steps (smoothed).
    const f = share(st), prior = pi === this.seat ? this.lanePrior : this.fieldPrior;
    return Object.fromEntries(LANES.map((r) => [r, E.smoothMultiplier(st.config, counts[r] + (1 - f) * prior[r])]));
  }

  // ---- targets ---------------------------------------------------------- //

  pickDig(st) {
    const b = st.board, cfg = st.config, pi = st.current, sl = this.s, geo = geometry(b);
    const counts = this.expectedCounts(st, pi);
    const link = E.linkedNetwork(st), net = E.networkHexes(st, link), mine = touched(st, pi, link);
    // Reach is scored by band (hexReach); value a hex at its own band's points.
    const reachMul = Math.max(0.5, counts.buy) * (0.5 + sl.depth);
    const reachHex = (hk) => reachMul * E.hexReach(st, hk);
    const mp = cfg.inlandMilestone === "canals" && !st.inlandOpen && cfg.milestoneReward ? E.milestoneProgress(st, link) : null;
    const racing = mp && mp.have === mp.need - 1;
    const open = (hk) => b.hexes[hk].bonus && st.claimed[hk] === undefined;
    const worth = {};
    let any = false;
    for (const [hk, h] of Object.entries(b.hexes)) {
      if (geo.water(hk) || net.has(hk)) continue;
      let w = 0;
      if (!h.shore) w += reachHex(hk);
      if (open(hk)) w += 4 * sl.discovery;
      if (h.slots > 0) {
        w += 0.4 * (Math.max(0.5, counts.dig) * cfg.vpPerBuilding + cfg.incomePerBuilding) * (0.5 + sl.build);
        if (h.isKey) w += Math.max(0.5, counts.special) * cfg.vpPerKey * 0.6;
      }
      if (w >= 3) { worth[hk] = w; any = true; }
    }
    let best = null, bestV = -1e9;
    for (const ek of geo.edges) {
      if (!E.canDig(st, ek).ok) continue;   // includes the money
      const e = b.edges[ek], cost = E.digCost(st, ek), live = E.extendsNetwork(st, ek, link);
      let v = live ? 0 : REMOTE_DIG;
      if (racing && live && (E.isInland(st, e.a) || E.isInland(st, e.b))) v += 2 * sl.discovery + 1;
      for (const hk of [e.a, e.b]) {
        if (geo.water(hk)) continue;
        const h = b.hexes[hk];
        if (live && !h.shore && !mine.has(hk)) v += reachHex(hk);
        if (net.has(hk)) continue;
        v += 1;
        if (!h.shore) {
          v += ((geo.depth[hk] ?? 2) - 2) * (sl.depth - 0.5) * 1.2;
          if (open(hk)) v += 4 * sl.discovery;
        }
        if (h.isKey && h.slots > 0) v += 1.5 * sl.build;
      }
      if (live && any) {
        let pull = 0;
        for (const [hk, d] of geo.near[ek]) if (worth[hk] !== undefined) pull = Math.max(pull, worth[hk] / (1 + d));
        v += pull;
      }
      v -= cost * (0.4 + sl.hoard);
      v += this.rng() * 0.4;
      if (v > bestV) { best = ek; bestV = v; }
    }
    return bestV > -4 ? best : null;
  }

  pickBuild(st) {
    const b = st.board, cfg = st.config, pi = st.current, sl = this.s, p = E.currentPlayer(st);
    const left = Math.max(0, Math.min(1, E.roundsLeft(st) / 12));
    const haul = cfg.materials ? E.hauls(st) : undefined;
    const geo = geometry(b);
    let best = null, bestV = -1e9;
    for (const [hk, h] of Object.entries(b.hexes)) {
      if (h.slots <= 0 || (st.buildings[hk] || []).length >= h.slots || geo.water(hk)) continue;
      let baseV = 2 + (E.techOn(st) ? 0 : INCOME_VP * cfg.incomePerBuilding);
      if (h.isKey) baseV += 3 * (0.5 + sl.special);
      for (const bt of st.buildingTypes) {
        if (!E.canBuild(st, hk, bt.id, haul).ok) continue;   // includes the money
        const cost = E.buildPrice(st, hk, bt.id, pi, haul).total;
        let v = baseV + (bt.vp === "base" ? 0 : bt.vp - cfg.vpPerBuilding) + (E.featureOf(st, hk)?.vpBonus || 0) + tokenValue(st, hk, left);
        if (bt.vpPerNeighbour) {
          const nb = E.NEIGHBOURS.filter(([dq, dr]) => (st.buildings[E.hexKey(h.q + dq, h.r + dr)] || []).length).length;
          const bonus = bt.vpPerNeighbour * (nb + left);
          v += bt.neighbourCap ? Math.min(bonus, bt.neighbourCap) : bonus;
        }
        v += INCOME_VP * bt.income * left;
        if (E.techOn(st)) v += techValue(st, pi, bt.id, left);
        v += 0.5 * bt.moneyPerCanal * E.canalsAround(st, hk);
        if (cfg.materials && h.material && bt.extracts) v += cfg.hauling === "tolls" ? 1 + 2.5 * left : 1 + 0.3 * bt.yield * left;   // fees from others, cheap builds for you
        if (bt.lock) v += 0.6 * E.canalsAround(st, hk) * left;   // the bank pays for others' hauls through it
        if (bt.digDiscount) v += 2 * bt.digDiscount * left * (0.5 + sl.dig);
        if (bt.handSize) v += 6 * bt.handSize * left;
        if (bt.port && cfg.materials) v += (0.5 + 0.5 * left) * Math.min(4, Math.max(0, (geo.depth[hk] ?? 2) - 2));
        v -= cost * (0.4 + sl.hoard);
        v += this.rng() * 0.4;
        if (v > bestV) { best = [hk, bt.id]; bestV = v; }
      }
    }
    return best;
  }

  /** [slot, top]: the card to buy, and whether to pay to put it on top of the draw pile. */
  pickBuy(st) {
    const p = E.currentPlayer(st), weight = E.cardWeights(st);
    let best = null, bestV = -1e9;
    E.marketCards(st).forEach((uid, slot) => {
      const d = E.def(st, uid), cost = E.buyCost(st, uid);
      if (cost > p.money) return;
      let v = this.cardValue(st, uid, weight) + d.vp * 0.8 - cost * (0.5 + this.s.hoard);
      v += this.rng() * 0.4;
      if (v > bestV) { best = slot; bestV = v; }
    });
    if (best === null) return null;
    // On top: a dear action card (tier 2, a Special) is worth having next turn.
    const uid = E.marketCards(st)[best], d = E.def(st, uid), tc = E.topCost(st);
    const top = tc !== null && p.money >= E.buyCost(st, uid) + tc + 1 && d.role !== "earn"
      && (d.cost >= 5 || d.role === "special") && E.roundsLeft(st) > 2;
    return [best, top];
  }

  /** The least wanted card in the allowed piles; non-Earn cards only for a thinning bot. */
  pickTrash(st) {
    const p = E.currentPlayer(st), pool = st.turn.pool, weight = E.cardWeights(st);
    const piles = [];
    if ((pool.trashHand || 0) + (pool.trashAny || 0) > 0) piles.push("hand");
    if ((pool.trashDiscard || 0) + (pool.trashAny || 0) > 0) piles.push("discard");
    let best = null, bestV = 1e9;
    for (const src of piles) {
      for (const uid of src === "hand" ? p.hand : p.discard) {
        if (uid === st.turn.played || !E.canTrash(st, uid, src).ok) continue;
        let v = this.cardValue(st, uid, weight);
        if (E.def(st, uid).role === "earn") v -= 2 * this.s.thin;   // the designed late-game cleanup
        if (v < bestV) { best = [uid, src]; bestV = v; }
      }
    }
    if (!best) return null;
    if (E.def(st, best[0]).role !== "earn" && this.s.thin < 0.35) return null;
    return best;
  }

  /** Pearl menu, as sim/agent.py spend_pearls. */
  spendPearls(st) {
    const p = E.currentPlayer(st), cfg = st.config, sl = this.s;
    if (!cfg.pearls || !p.pearls) return;
    const role = E.def(st, st.turn.played).role;
    if (["dig", "build", "buy"].includes(role) && p.pearls >= cfg.pearlActionCost && p.money >= 4 && appetite(sl, role) >= 0.5) E.spendPearl(st, "action");
    const cashAt = cfg.pearlEarning === "track" ? Math.min(cfg.pearlCap, 2 + Math.round(3 * sl.hoard)) : cfg.pearlCap;
    if ((p.pearls || 0) >= cashAt) E.spendPearl(st, "money");
    if (p.pearls && p.money >= 12 && sl.thin >= 0.5) {
      const earn = p.hand.find((u) => E.def(st, u).role === "earn");
      if (earn !== undefined) E.spendPearl(st, "redraw", earn);
    }
  }

  /** Play a move, then take its actions by this bot's targets: digs, builds, buys, trashes. */
  resolve(st, move) {
    if (move.opt === "forage") return E.forage(st, move.uid);
    const discards = move.opt === 0 ? [] : this.pickDiscards(st, move.uid, move.opt);
    if (!E.playCard(st, move.uid, discards).ok) { E.playCard(st, move.uid, []); }
    this.spendPearls(st);
    const pool = st.turn.pool;
    for (let guard = 0; guard < 30 && pool.dig > 0; guard++) { const ek = this.pickDig(st); if (!ek || !E.dig(st, ek).ok) break; }
    for (let guard = 0; guard < 30 && pool.build > 0; guard++) { const x = this.pickBuild(st); if (!x || !E.build(st, ...x).ok) break; }
    for (let guard = 0; guard < 30 && pool.buy > 0; guard++) { const x = this.pickBuy(st); if (x === null || !E.buy(st, ...x).ok) break; }
    for (let guard = 0; guard < 10; guard++) { const x = this.pickTrash(st); if (!x || !E.trash(st, ...x).ok) break; }
    return E.endTurn(st);
  }

  // ---- move priors and rollouts ----------------------------------------- //

  prior(st, move) {
    const p = E.currentPlayer(st), cfg = st.config;
    if (move.opt === "forage") {
      // A lifeline: worth it when broke, and cheapest with a card you don't want.
      const broke = 1 - Math.min(p.money, 8) / 8;
      if (move.uid === "hand") return -2.5 + 2.2 * broke - 0.15 * p.hand.length;
      return -1.6 + 2.2 * broke - 0.25 * this.cardValue(st, move.uid);
    }
    const d = E.def(st, move.uid);
    let v = appetite(this.s, d.role) * 2;
    // Playing an action you cannot pay for wastes the turn outright.
    if (d.role === "dig") {
      const link = E.linkedNetwork(st);
      let cheapest = 99;
      for (const ek of geometry(st.board).edges) {
        if (st.dug[ek] !== undefined || !E.extendsNetwork(st, ek, link)) continue;
        cheapest = Math.min(cheapest, st.board.edges[ek].cost);
      }
      if (cheapest > p.money) v -= 4;
    } else if (d.role === "build") {
      const net = E.networkHexes(st);
      let cheapest = Infinity;
      const haul = cfg.materials ? E.hauls(st) : undefined;
      for (const [hk, h] of Object.entries(st.board.hexes)) {
        if (h.slots <= 0 || (st.buildings[hk] || []).length >= h.slots || E.isWater(st, hk)) continue;
        if (cfg.buildNeedsNetwork && !net.has(hk)) continue;
        if (E.inlandClosed(st) && E.isInland(st, hk)) continue;
        cheapest = Math.min(cheapest, E.buildPrice(st, hk, st.buildingTypes[0].id, st.current, haul).total);
        if (cheapest <= p.money) break;
      }
      if (cheapest > p.money) v -= 4;
    } else if (d.role === "buy") {
      const m = E.marketCards(st);
      if (!m.length || Math.min(...m.map((u) => E.def(st, u).cost)) > p.money) v -= 4;
    } else if (d.role === "earn") {
      v += (1 - Math.min(p.money, 10) / 10) * 1.6;
    }
    if (move.opt !== 0) {
      const n = typeof move.opt === "string" ? 1 : move.opt;
      v += (this.s.boost - 0.45) * 2.4 - 0.25 * Math.max(0, n - 1);
    }
    return v;
  }

  rolloutMove(st) {
    const moves = legalMoves(st);
    const w = moves.map((m) => Math.exp(this.prior(st, m)));
    let r = this.rng() * w.reduce((a, x) => a + x, 0);
    for (let i = 0; i < moves.length; i++) { r -= w[i]; if (r <= 0) return moves[i]; }
    return moves[moves.length - 1];
  }

  evaluate(st, pi) {
    const totals = st.players.map((_, i) => {
      const sc = E.score(st, i), exp = this.expectedCounts(st, i, sc.counts);
      return sc.lanes.reduce((a, l) => a + (exp[l.mult] ?? l.m) * l.s, 0);
    });
    const best = Math.max(...totals.filter((_, i) => i !== pi), 0);
    const p = st.players[pi], cfg = st.config;
    let banked = p.money * MONEY_VP + p.income * INCOME_VP + (p.pearls || 0) * PEARL_VP;
    if (cfg.pearls && cfg.pearlEarning === "track") banked += (PEARL_VP * (p.pearlTrack || 0)) / E.pearlNeed(st, p);
    return totals[pi] - best + banked;
  }

  /** Play on from st (the acting player has moved) for up to `horizon` round ends; score for pi. */
  rollout(st, pi) {
    const rounds = Math.min(this.s.horizon, Math.ceil(E.roundsLeft(st)));
    const stop = st.round + rounds;
    while (!st.over && st.round < stop) {
      if (!E.currentPlayer(st).hand.length) { E.pass(st); continue; }
      this.resolve(st, this.rolloutMove(st));
    }
    return this.evaluate(st, pi);
  }

  choose(st) {
    this.phase(st);
    this.seat = st.current;
    let moves = legalMoves(st);
    if (moves.length <= 1) return moves[0] || null;
    moves = moves.map((m) => [m, this.prior(st, m)]).sort((a, b) => b[1] - a[1]).slice(0, this.s.width).map(([m]) => m);
    let best = moves[0], bestV = -1e18;
    for (const m of moves) {
      let total = 0;
      for (let k = 0; k < this.s.rollouts; k++) {
        const g = E.cloneState(st, Math.floor(this.rng() * 4294967296));
        this.resolve(g, m);
        total += this.rollout(g, this.seat);
      }
      const avg = total / this.s.rollouts;
      if (avg > bestV) { best = m; bestV = avg; }
    }
    return best;
  }

  /** Take the current player's whole turn. */
  playTurn(st) {
    if (st.turn?.phase === "harbour") return E.chooseHarbour(st, E.bestHarbour(st, this.rng));
    if (!E.currentPlayer(st).hand.length) return E.pass(st);
    const m = this.choose(st);
    this.seat = st.current;
    return this.resolve(st, m);
  }
}

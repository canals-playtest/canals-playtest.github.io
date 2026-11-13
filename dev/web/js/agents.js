// Computer players for quick checks in JS. Pure functions over engine state, no
// DOM — used by web/test/sim.mjs. The research simulator is the Python one in
// sim/ (docs/simulation.md); these are cheaper and play the same rules.
//
//   random — plays a random card, random legal discards, random legal actions.
//            A floor: anything a card set does well here, it does without skill.
//   greedy — one-turn lookahead: tries each card and boost option, takes actions
//            by simple priorities, keeps the best-scoring result. Digs toward
//            whatever the network can open that is worth most to it: Reach,
//            discoveries, building sites and key tiles.

import * as E from "./engine.js";
import { legalDiscards, parseEffects } from "./notation.js";

/**
 * What an unclaimed site token on hk is worth to whoever builds there, in
 * rough VP (`left`: 0..1, how much game remains for income to pay).
 */
export function tokenValue(s, hk, left) {
  const tok = s.tokens?.[hk];
  if (!tok || s.tokenClaimed?.[hk] !== undefined) return 0;
  const per = { money: 0.3, income: 1.0 * left * 3, dig: 1, build: 1, buy: 1, trashAny: 0.8, trashHand: 0.6, trashDiscard: 0.6, pearl: 0.8, extraDraw: 0.5 };
  return parseEffects(tok.code).reduce((a, x) => a + (per[x.kind] ?? 0.5) * x.n, 0);
}

/**
 * A seeded random number generator (mulberry32, as the engine's shuffles).
 * It was a plain LCG, whose first draws from consecutive seeds were
 * correlated: seats and pools picked by seed g, g+1, ... were biased.
 */
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Discard choices that legally pay a card's boost: [] plus one representative per legal count. */
function boostChoices(s, uid, rest) {
  const d = E.def(s, uid), bc = d.boostCost;
  const cheapest = [...rest].sort((a, b) => E.def(s, a).cost - E.def(s, b).cost);
  const out = [[]];
  if (bc.kind === "threshold" && rest.length >= bc.n) out.push(cheapest.slice(0, bc.n));
  if (bc.kind === "scalar") for (let n = 1; n <= rest.length; n++) out.push(cheapest.slice(0, n));
  if (bc.kind === "colour") { const c = cheapest.find((u) => E.def(s, u).role === bc.role); if (c) out.push([c]); }
  return out.filter((ds) => legalDiscards(d, ds.map((u) => E.def(s, u))));
}

// --------------------------------------------------------------------------- //
// random
// --------------------------------------------------------------------------- //

export function randomTurn(s, rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  if (s.turn?.phase === "harbour") return E.chooseHarbour(s, pick(E.draftChoices(s)));
  const p = E.currentPlayer(s);
  if (!p.hand.length) return E.pass(s);
  if (rnd() < 0.05 && E.canForage(s, "hand").ok) return E.forage(s, rnd() < 0.5 ? "hand" : pick(p.hand));
  const uid = pick(p.hand);
  E.playCard(s, uid, pick(boostChoices(s, uid, p.hand.filter((u) => u !== uid))));
  for (let guard = 0; guard < 20; guard++) {
    const opts = [];
    for (const ek of Object.keys(s.board.edges)) if (E.canDig(s, ek).ok) opts.push(() => E.dig(s, ek));
    for (const hk of Object.keys(s.board.hexes)) for (const bt of s.buildingTypes) if (E.canBuild(s, hk, bt.id).ok) opts.push(() => E.build(s, hk, bt.id));
    E.marketCards(s).forEach((_, i) => E.canBuy(s, i).ok && opts.push(() => E.buy(s, i, rnd() < 0.3 && E.canBuy(s, i, true).ok)));
    for (const u of p.discard) if (E.canTrash(s, u, "discard").ok && rnd() < 0.3) opts.push(() => E.trash(s, u, "discard"));
    if (!opts.length) break;
    pick(opts)();
  }
  return E.endTurn(s);
}

// --------------------------------------------------------------------------- //
// greedy
// --------------------------------------------------------------------------- //

/** Greedy tuning. `lookahead`: furthest target, in digs along borders, worth steering toward. */
export const GREEDY_TUNING = { lookahead: 6, hubWorth: 20, remoteDig: 2 };  // lookahead: digs along borders

/** What reaching hex hk is worth to the current player, in rough VP. */
function hexWorth(s, hk, counts) {
  const h = s.board.hexes[hk], cfg = s.config;
  let w = 0;
  if (!h.shore && cfg.networkScore === "reach") w += Math.max(0.5, counts.buy) * E.hexReach(s, hk);
  if (h.bonus && s.claimed[hk] === undefined) w += 4;
  if (h.slots > (s.buildings[hk] || []).length && s.board.terrain[h.terrain].buildable) {
    w += 0.4 * (Math.max(0.5, counts.dig) * cfg.vpPerBuilding + cfg.incomePerBuilding);
    if (h.isKey) w += Math.max(0.5, counts.special) * cfg.vpPerKey * 0.6;
  }
  if (cfg.networkScore === "crossings" && s.hubs.includes(hk) && !s.crossings.some((c) => c.hub === hk)) w += GREEDY_TUNING.hubWorth;
  return w;
}

/** Borders that meet each border at a corner: the moves a canal can make next. */
function borderGraph(s) {
  const byCorner = {}, adj = {};
  for (const ek of Object.keys(s.board.edges)) for (const c of E.edgeCorners(ek)) (byCorner[c] ||= []).push(ek);
  for (const ek of Object.keys(s.board.edges)) adj[ek] = [...new Set(E.edgeCorners(ek).flatMap((c) => byCorner[c]))].filter((n) => n !== ek);
  return adj;
}

/** Digs still needed after each border to put a canal on one of hex hk's borders (0: it is one). */
function digsTo(s, adj, hk) {
  const dist = {}, queue = [];
  for (const ek of Object.keys(s.board.edges)) {
    const e = s.board.edges[ek];
    if (e.a === hk || e.b === hk) { dist[ek] = 0; queue.push(ek); }
  }
  while (queue.length) {
    const ek = queue.shift();
    for (const n of adj[ek]) if (dist[n] === undefined && dist[ek] < GREEDY_TUNING.lookahead) { dist[n] = dist[ek] + 1; queue.push(n); }
  }
  return dist;
}

function pickDig(s) {
  const link = E.linkedNetwork(s);
  const net = E.networkHexes(s, link);
  const counts = expectedCounts(s, s.current);
  const adj = borderGraph(s);
  // Targets: unreached hexes worth steering toward, a few digs out. Canals
  // join at corners, so distance is counted in digs along borders.
  const targets = Object.keys(s.board.hexes)
    .filter((k) => !net.has(k) && !E.isWater(s, k))
    .map((k) => ({ k, w: hexWorth(s, k, counts) }))
    .filter((t) => t.w >= 3)
    .map((t) => ({ ...t, dist: digsTo(s, adj, t.k) }));
  const pull = (ek) => {           // how strongly a canal here leads toward a target
    let best = 0;
    for (const t of targets) { const d = t.dist[ek]; if (d > 0) best = Math.max(best, t.w / (1 + d)); }
    return best;
  };
  let best = null, bestScore = 0;
  for (const ek of Object.keys(s.board.edges)) {
    if (!E.canDig(s, ek).ok) continue;
    const e = s.board.edges[ek];
    if (!E.extendsNetwork(s, ek, link)) {
      // A land animal's remote dig: worth only what it opens once linked, and
      // the linker, not the digger, claims the discoveries. Taken only for a
      // rich spot.
      const sc = 0.4 * (hexWorth(s, e.a, counts) + hexWorth(s, e.b, counts)) - 0.5 * E.digCost(s, ek) - GREEDY_TUNING.remoteDig;
      if (sc > bestScore) { bestScore = sc; best = ek; }
      continue;
    }
    const fresh = [e.a, e.b].filter((hk) => !net.has(hk));
    const sc = fresh.reduce((a, hk) => a + hexWorth(s, hk, counts), 0) + pull(ek) - 0.5 * E.digCost(s, ek);
    if (sc > bestScore) { bestScore = sc; best = ek; }
  }
  return best;
}

/** What a building type's own effect is worth here, in rough VP; as sim/agent.py. */
function typeExtras(s, hk, bt, left) {
  const fade = Math.min(1, left / 12), h = s.board.hexes[hk], cfg = s.config;
  let v = 0;
  if (bt.vpPerNeighbour) {
    const near = E.NEIGHBOURS.filter(([dq, dr]) => (s.buildings[E.hexKey(h.q + dq, h.r + dr)] || []).length).length;
    const bonus = bt.vpPerNeighbour * (near + fade);
    v += bt.neighbourCap ? Math.min(bonus, bt.neighbourCap) : bonus;
  }
  if (cfg.materials && h.material && bt.extracts) v += cfg.hauling === "tolls" ? 1 + 2.5 * fade : 1 + 0.3 * bt.yield * fade;   // fees from others, cheap builds for you
  if (bt.lock) v += 0.6 * E.canalsAround(s, hk) * fade;   // the bank pays for others' hauls through it
  if (bt.digDiscount) v += 2 * bt.digDiscount * fade;
  if (bt.handSize) v += 6 * bt.handSize * fade;
  if (bt.port && cfg.materials) v += (0.5 + 0.5 * fade) * Math.min(4, Math.max(0, (E.buildPrice(s, hk, bt.id).picks[0]?.edges ?? 0) - 1));
  return v;
}

/** Pearl menu, as sim/agent.py spend_pearls: an extra action of the played card's
 * kind when affordable; one pearl cashed when holding 3 (on the pearl track each
 * pearl held makes the next dearer), or at the cap. */
function spendPearls(s) {
  const p = E.currentPlayer(s), cfg = s.config;
  if (!cfg.pearls || !p.pearls) return;
  const role = E.def(s, s.turn.played).role;
  if (["dig", "build", "buy"].includes(role) && p.pearls >= cfg.pearlActionCost && p.money >= 4) E.spendPearl(s, "action");
  if (p.pearls >= (cfg.pearlEarning === "track" ? Math.min(3, cfg.pearlCap) : cfg.pearlCap)) E.spendPearl(s, "money");
}

function greedyActions(s) {
  const p = E.currentPlayer(s);
  spendPearls(s);
  for (let guard = 0; guard < 12; guard++) {
    const t = s.turn.pool;
    if (t.dig > 0) { const ek = pickDig(s); if (ek) { E.dig(s, ek); continue; } }
    // Build: key tiles first, then the building worth most in rough money terms.
    if (t.build > 0) {
      let best = null, bestScore = -Infinity;
      const left = E.roundsLeft(s);
      const counts = expectedCounts(s, s.current);
      for (const hk of Object.keys(s.board.hexes)) {
        const h = s.board.hexes[hk];
        for (const bt of s.buildingTypes) {
          if (!E.canBuild(s, hk, bt.id).ok) continue;
          const vp = E.buildingVP(s, hk, { p: s.current, type: bt.id });
          const sc = (h.isKey ? Math.max(0.5, counts.special) * s.config.vpPerKey : 0) + 1.2 * vp * Math.max(0.5, counts.dig)
            + 0.4 * (s.config.incomePerBuilding + bt.income) * Math.min(left, 8)
            + 0.8 * bt.moneyPerCanal * E.canalsAround(s, hk) - 0.8 * E.buildCost(s, hk, bt.id)
            + typeExtras(s, hk, bt, left) + tokenValue(s, hk, Math.min(1, left / 12));
          if (sc > bestScore) { bestScore = sc; best = [hk, bt.id]; }
        }
      }
      if (best) { E.build(s, ...best); continue; }
    }
    // Buy: specials first, then the priciest affordable card.
    if (t.buy > 0) {
      let best = null, bestScore = -Infinity;
      E.marketCards(s).forEach((uid, i) => {
        if (!E.canBuy(s, i).ok) return;
        const d = E.def(s, uid);
        const sc = d.cost + (d.role === "special" ? 5 : 0) + d.vp;
        if (sc > bestScore) { bestScore = sc; best = i; }
      });
      if (best !== null) {
        const d = E.def(s, E.marketCards(s)[best]);
        E.buy(s, best, (d.cost >= 5 || d.role === "special") && d.role !== "earn" && E.canBuy(s, best, true).ok && E.roundsLeft(s) > 2);
        continue;
      }
    }
    // Trash: starting Earn cards once the deck has another Earn card.
    const trashable = (src) => (src === "hand" ? p.hand : p.discard).find((u) => E.canTrash(s, u, src).ok && s.cards[u].startsWith("start-earn"));
    const tu = trashable("discard") ?? trashable("hand");
    if (tu && E.ownedCards(p).some((u) => E.def(s, u).role === "earn" && !s.cards[u].startsWith("start"))) {
      E.trash(s, tu, p.discard.includes(tu) ? "discard" : "hand");
      continue;
    }
    break;
  }
}

function value(s, pi) {
  const p = s.players[pi];
  const left = E.roundsLeft(s);
  // Each lane's score times its expected final multiplier (expectedCounts).
  const score = E.score(s, pi), exp = expectedCounts(s, pi, score.counts);
  const sc = score.lanes.reduce((a, l) => a + (exp[l.mult] ?? l.m) * l.s, 0);
  // Cards bought are future turns: value them near their price, less near the end.
  const deck = E.ownedCards(p).reduce((a, u) => a + E.def(s, u).cost, 0) * (left > 8 ? 1.0 : 0.3);
  // Income only pays when an Earn card is played, so it's worth less than cash.
  const incomeWorth = s.config.incomeMode === "earn" ? 0.25 : 0.5;
  const owned = Object.values(s.dug).filter((o) => o === pi).length;
  return sc + deck + 0.5 * owned + 0.8 * p.money + incomeWorth * p.income * Math.min(left, 10) + 3 * p.handSize + 0.3 * p.keys
    + 1.2 * (p.pearls || 0);
}

// Lane priors (bots/lane-priors.json, "browser"): the mean number of cards of
// each scoring colour (weighted, rule cardWeights) the greedy bot holds in its
// final deck. The bot expects to end with its current count plus the growth
// still to come, count + (1 - f) * prior, f the share of the game played: its
// usual final deck at the start, the real count at the end. Starting cards
// count 0, so without this every lane looks worthless early on. The table
// sets it from the shipped file and what it learns after each game (app.js).
export const LANE_ROLES = ["dig", "build", "buy", "special"];
let lanePrior = { dig: 2, build: 2, buy: 2, special: 2 };
export function setLanePrior(p) {
  for (const r of LANE_ROLES) if (Number.isFinite(p?.[r])) lanePrior[r] = p[r];
}
export const getLanePrior = () => ({ ...lanePrior });

/** Each scoring colour's expected final count for player pi. */
export function expectedCounts(s, pi, counts = E.score(s, pi).counts) {
  const done = s.round - 1, f = done / Math.max(1, done + E.roundsLeft(s));
  return Object.fromEntries(LANE_ROLES.map((r) => [r, E.smoothMultiplier(s.config, counts[r] + (1 - f) * lanePrior[r])]));
}

export function greedyTurn(s) {
  if (s.turn?.phase === "harbour") return E.chooseHarbour(s, E.bestHarbour(s));
  const p = E.currentPlayer(s);
  if (!p.hand.length) return E.pass(s);
  const me = s.current;
  const base = JSON.stringify({ ...s, log: [], history: [] });
  let best = null, bestVal = -Infinity;
  for (const uid of p.hand) {
    for (const disc of boostChoices(s, uid, p.hand.filter((u) => u !== uid))) {
      const c = JSON.parse(base);
      if (!E.playCard(c, uid, disc).ok) continue;
      greedyActions(c);
      // Holding cards has some option value, and kept cards earn pearls: on the
      // track each one is a share of the next pearl; under the earlier rule a
      // turn without discards banks one.
      const mine = c.players[me];
      const pearl = !c.config.pearls ? 0
        : c.config.pearlEarning === "track" ? 1.2 * mine.hand.length / E.pearlNeed(c, mine)
        : !disc.length && (mine.pearls || 0) < c.config.pearlCap ? 1.2 : 0;
      const v = value(c, me) - 0.4 * disc.length + pearl;
      if (v > bestVal) { bestVal = v; best = [uid, disc]; }
    }
  }
  // Forage (brainstorm-stage-3.md 6.3): one card face down, or the whole hand.
  // Only as a lifeline: one turn ahead, money looks better than what an action
  // builds, so greedy forages only when its best play gains nothing on standing still.
  let foraged = null;
  if (bestVal > value(JSON.parse(base), me) + 0.5) bestVal = Infinity;
  for (const uid of [...new Set(p.hand.map((u) => s.cards[u]))].map((id) => p.hand.find((u) => s.cards[u] === id)).concat(["hand"])) {
    if (!E.canForage(s, uid).ok) continue;
    const c = JSON.parse(base);
    E.forage(c, uid);
    const v = value(c, me);
    if (v > bestVal) { bestVal = v; foraged = uid; }
  }
  if (foraged !== null) return E.forage(s, foraged);
  E.playCard(s, ...best);
  greedyActions(s);
  return E.endTurn(s);
}

export const AGENTS = { random: randomTurn, greedy: greedyTurn };

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
import { legalDiscards } from "./notation.js";

export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
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
  const p = E.currentPlayer(s);
  if (!p.hand.length) return E.pass(s);
  const uid = pick(p.hand);
  E.playCard(s, uid, pick(boostChoices(s, uid, p.hand.filter((u) => u !== uid))));
  for (let guard = 0; guard < 20; guard++) {
    const opts = [];
    for (const ek of Object.keys(s.board.edges)) if (E.canDig(s, ek).ok) opts.push(() => E.dig(s, ek));
    for (const hk of Object.keys(s.board.hexes)) for (const bt of s.buildingTypes) if (E.canBuild(s, hk, bt.id).ok) opts.push(() => E.build(s, hk, bt.id));
    s.market.display.forEach((_, i) => E.canBuy(s, i).ok && opts.push(() => E.buy(s, i)));
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
  if (!h.shore && cfg.networkScore === "reach") w += Math.max(1, counts.buy) * cfg.vpPerReach;
  if (h.bonus && s.claimed[hk] === undefined) w += 4;
  if (h.slots > (s.buildings[hk] || []).length && s.board.terrain[h.terrain].buildable) {
    w += 0.4 * (Math.max(1, counts.dig) * cfg.vpPerBuilding + cfg.incomePerBuilding);
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
  const counts = E.score(s, s.current).counts;
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
  if (cfg.materials && h.material && bt.extracts) v += 1 + 0.3 * bt.yield * fade;   // cubes: fees from others, cheap builds for you
  if (bt.digDiscount) v += 2 * bt.digDiscount * fade;
  if (bt.handSize) v += 6 * bt.handSize * fade;
  if (bt.port && cfg.materials) v += (0.5 + 0.5 * fade) * Math.min(4, Math.max(0, (E.buildPrice(s, hk, bt.id).picks[0]?.edges ?? 0) - 1));
  return v;
}

/** Pearl menu, as sim/agent.py spend_pearls: an extra action of the played card's
 * kind when affordable; one pearl cashed when at the cap, so this turn's is not lost. */
function spendPearls(s) {
  const p = E.currentPlayer(s), cfg = s.config;
  if (!cfg.pearls || !p.pearls) return;
  const role = E.def(s, s.turn.played).role;
  if (["dig", "build", "buy"].includes(role) && p.pearls >= cfg.pearlActionCost && p.money >= 4) E.spendPearl(s, "action");
  if (p.pearls >= cfg.pearlCap) E.spendPearl(s, "money");
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
      const left = Math.max(0, s.config.rounds - s.round);
      const counts = E.score(s, s.current).counts;
      for (const hk of Object.keys(s.board.hexes)) {
        const h = s.board.hexes[hk];
        for (const bt of s.buildingTypes) {
          if (!E.canBuild(s, hk, bt.id).ok) continue;
          const vp = E.buildingVP(s, hk, { p: s.current, type: bt.id });
          const sc = (h.isKey ? Math.max(0.5, counts.special) * s.config.vpPerKey : 0) + 1.2 * vp * Math.max(1, counts.dig)
            + 0.4 * (s.config.incomePerBuilding + bt.income) * Math.min(left, 8)
            + 0.8 * bt.moneyPerCanal * E.canalsAround(s, hk) - 0.8 * E.buildCost(s, hk, bt.id)
            + typeExtras(s, hk, bt, left);
          if (sc > bestScore) { bestScore = sc; best = [hk, bt.id]; }
        }
      }
      if (best) { E.build(s, ...best); continue; }
    }
    // Buy: specials first, then the priciest affordable card.
    if (t.buy > 0) {
      let best = null, bestScore = -Infinity;
      s.market.display.forEach((uid, i) => {
        if (!E.canBuy(s, i).ok) return;
        const d = E.def(s, uid);
        const sc = d.cost + (d.role === "special" ? 5 : 0) + d.vp;
        if (sc > bestScore) { bestScore = sc; best = i; }
      });
      if (best !== null) { E.buy(s, best); continue; }
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
  const left = Math.max(0, s.config.rounds - s.round);
  const sc = E.score(s, pi).total;
  // Cards bought are future turns: value them near their price, less near the end.
  const deck = E.ownedCards(p).reduce((a, u) => a + E.def(s, u).cost, 0) * (left > 8 ? 1.0 : 0.3);
  // Income only pays when an Earn card is played, so it's worth less than cash.
  const incomeWorth = s.config.incomeMode === "earn" ? 0.25 : 0.5;
  const owned = Object.values(s.dug).filter((o) => o === pi).length;
  return sc + deck + 0.5 * owned + 0.8 * p.money + incomeWorth * p.income * Math.min(left, 10) + 3 * p.handSize + 0.3 * p.keys
    + 1.2 * (p.pearls || 0);
}

export function greedyTurn(s) {
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
      // Holding cards has some option value, and a turn without discards banks a pearl.
      const pearl = c.config.pearls && !disc.length && (c.players[me].pearls || 0) < c.config.pearlCap ? 1.2 : 0;
      const v = value(c, me) - 0.4 * disc.length + pearl;
      if (v > bestVal) { bestVal = v; best = [uid, disc]; }
    }
  }
  E.playCard(s, ...best);
  greedyActions(s);
  return E.endTurn(s);
}

export const AGENTS = { random: randomTurn, greedy: greedyTurn };

// Canals rules engine. Pure state + functions, no DOM: runs in the browser and
// in Node (see web/test/smoke.mjs), so a bot or batch simulator can drive it.
//
// It implements the settled rules as sim/rules.py does — keep the two in step.
// Rule *values* are shared with sim/rules.py through rules/defaults.json, so the
// numbers cannot drift; rule *logic* still lives in both places. Candidate rules
// from docs/alternatives.md are kept as options, all off by default.
//
// The state is plain JSON (RNG included), so undo and autosave are JSON copies.

import { cardDef, resolveEffects, legalDiscards, parseEffects, displayName, ROLES } from "./notation.js";
import SHARED from "../../rules/defaults.json" with { type: "json" };

// Every rule value lives in rules/defaults.json, shared with sim/rules.py.
// Do not add a literal default here: add the rule to the JSON instead, then
// run `python3 tools/check_rules.py`.

/** name -> { value, status: "settled" | "assumed" | "alternative", note } */
export const RULES = SHARED.rules;

export const DEFAULTS = {
  seed: 1, // runtime, not a rule
  ...Object.fromEntries(Object.entries(SHARED.rules).map(([k, r]) => [k, r.value])),
};

export const PLAYER_COLOURS = ["#d1495b", "#2e86ab", "#edae49", "#66a182", "#8d6a9f"];

// --------------------------------------------------------------------------- //
// RNG (mulberry32, state kept in the game state so it survives JSON copies)
// --------------------------------------------------------------------------- //

function rand(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle(state, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(state) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --------------------------------------------------------------------------- //
// Board
// --------------------------------------------------------------------------- //

const TRUEISH = new Set(["true", "yes", "y", "1", "t"]);
const truthy = (v) => TRUEISH.has(String(v || "").trim().toLowerCase());
export const NEIGHBOURS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const hexKey = (q, r) => `${q},${r}`;
export const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Canals run along hex borders, so they connect only where two borders share
// a corner, as roads do in Catan. A corner is named by the three hexes that
// meet there ("4,1/4,2/5,1"), whether or not they are all on the map. An edge
// is named by its two hexes, and a corner name depends only on coordinates,
// so it is cached by edge key.
const CORNERS = new Map();
const parseKey = (k) => k.split(",").map(Number);
const cornerName = (keys) => [...keys].sort().join("/");

/** The two corners of the border between adjacent hexes a and b. */
export function edgeCorners(ek) {
  let c = CORNERS.get(ek);
  if (c) return c;
  const [ka, kb] = ek.split("|");
  const [aq, ar] = parseKey(ka), [bq, br] = parseKey(kb);
  const i = NEIGHBOURS.findIndex(([dq, dr]) => aq + dq === bq && ar + dr === br);
  if (i < 0) throw new Error(`${ek} is not a border between neighbours`);
  const side = (j) => { const [dq, dr] = NEIGHBOURS[(j + 6) % 6]; return hexKey(aq + dq, ar + dr); };
  c = [cornerName([ka, kb, side(i - 1)]), cornerName([ka, kb, side(i + 1)])];
  CORNERS.set(ek, c);
  return c;
}

/** A corner where a harbour (any land, on a map without harbours) meets open water. */
function isMouth(corner, hexes, terrain, harbourMap) {
  const hs = corner.split("/").map((k) => hexes[k]);
  const wet = (h) => h && terrain[h.terrain].water && !terrain[h.terrain].band;   // the sea, not a lake
  return hs.some(wet) && hs.some((h) => h && !wet(h) && (!harbourMap || h.harbour));
}

/** Harbour mouths: where the network starts. Saved boards from before mouths were stored recompute them. */
export function harbourMouths(state) {
  const b = state.board;
  if (!b.mouths) {
    const m = new Set();
    for (const ek of Object.keys(b.edges)) for (const c of edgeCorners(ek)) if (isMouth(c, b.hexes, b.terrain, b.harbourMap)) m.add(c);
    b.mouths = [...m].sort();
  }
  return b.mouths;
}

/** The board for `players` players: hexes whose players column is above it are
 * left out, so the board grows with the player count. As sim/content.py. */
export function buildBoard(hexRows, terrainRows, players = Infinity) {
  const terrain = {}, features = {};
  for (const t of terrainRows) {
    if (!t.id) continue;
    if ((t.kind || "").trim().toLowerCase() === "feature") {
      // A feature (stage 2) sits on a band's terrain: hills, marsh.
      features[t.id] = { id: t.id, name: t.name || t.id, fill: t.fill || "", ink: t.ink || "#333",
        digMod: Number(t.dig_mod) || 0, site: truthy(t.buildable), vpBonus: Number(t.vp_bonus) || 0, reachBonus: Number(t.reach_bonus) || 0 };
      continue;
    }
    const water = truthy(t.water);
    terrain[t.id] = {
      id: t.id, name: t.name || t.id, fill: t.fill || "#ddd", ink: t.ink || "#333",
      water, buildable: truthy(t.buildable),
      digCost: Number(t.dig_cost) || 0, buildCost: Number(t.build_cost) || 0,
      // Band (stage 2): coast, inland or highland; blank for the sea. Older
      // terrain files have none: "inland" and "highland" are their own band.
      band: (t.band || "").trim().toLowerCase() || (["inland", "highland"].includes(t.id) ? t.id : water ? "" : "coast"),
      wall: truthy(t.wall),   // a crag: a border between two of these can't be dug
    };
  }
  const hexes = {};
  for (const h of hexRows) {
    const q = parseInt(h.q, 10), r = parseInt(h.r, 10);
    if (Number.isNaN(q) || Number.isNaN(r) || !terrain[h.terrain]) continue;
    if ((parseInt(h.players, 10) || 0) > players) continue;
    const t = terrain[h.terrain];
    hexes[hexKey(q, r)] = {
      key: hexKey(q, r), q, r, terrain: h.terrain, region: h.region || "",
      isKey: truthy(h.key), hub: truthy(h.hub), harbour: truthy(h.harbour), bonus: (h.bonus || "").trim(),
      material: ["clay", "wood", "stone"].includes((h.material || "").trim().toLowerCase()) ? h.material.trim().toLowerCase() : "",
      slots: h.slots !== undefined && h.slots !== "" ? parseInt(h.slots, 10) || 0 : t.buildable ? 1 : 0,
      feature: features[(h.feature || "").trim().toLowerCase()] ? (h.feature || "").trim().toLowerCase() : "",
      tokenSite: truthy(h.token) || (h.token || "").trim() === "?",
    };
    const f = features[hexes[hexKey(q, r)].feature];
    if (f && !f.site) hexes[hexKey(q, r)].slots = 0;   // marsh: no site
  }
  const water = (h) => terrain[h.terrain].water;
  const sea = (h) => water(h) && !terrain[h.terrain].band;   // open water; a lake has a band
  const around = (h) => NEIGHBOURS.map(([dq, dr]) => hexes[hexKey(h.q + dq, h.r + dr)]).filter(Boolean);
  for (const h of Object.values(hexes)) h.band = terrain[h.terrain].band;
  // Shore: land beside open water. Always reachable, so it never counts for Reach.
  for (const h of Object.values(hexes)) h.shore = !water(h) && around(h).some(sea);
  // Canals are dug on borders between two land hexes; the coastline itself is
  // not a canal. They join at corners, and the network starts at a harbour
  // mouth: a corner where a harbour meets open water. A map with no harbours
  // marked (e.g. board/alternatives/) makes every coastal corner a mouth.
  const harbourMap = Object.values(hexes).some((h) => h.harbour);
  const edges = {}, mouths = new Set();
  for (const h of Object.values(hexes)) {
    if (water(h)) continue;
    for (const n of around(h)) {
      if (water(n)) continue;
      if (terrain[h.terrain].wall && terrain[n.terrain].wall) continue;   // between two crags: no canal
      const k = edgeKey(h.key, n.key);
      if (edges[k]) continue;
      // A border costs the dearer of its two hexes: the band's cost plus its feature's (hills +1, marsh -1).
      const hexDig = (x) => Math.max(0, terrain[x.terrain].digCost + (features[x.feature]?.digMod || 0));
      edges[k] = { key: k, a: h.key, b: n.key, cost: Math.max(hexDig(h), hexDig(n)) };
      for (const c of edgeCorners(k)) if (isMouth(c, hexes, terrain, harbourMap)) mouths.add(c);
    }
  }
  return { terrain, features, hexes, edges, harbourMap, mouths: [...mouths].sort() };
}

export const isWater = (state, hk) => { const h = state.board.hexes[hk]; return !!h && state.board.terrain[h.terrain].water; };

/** "inland" if the edge touches an inland hex (it costs inland prices), else "coastal". */
export const edgeZone = (state, ek) => {
  const e = state.board.edges[ek];
  return [e.a, e.b].some((k) => isInland(state, k)) ? "inland" : "coastal";
};

/** A hex's band: "coast", "inland", "highland", or "" for the sea. */
export const bandOf = (state, hk) => state.board.hexes[hk]?.band ?? "";
const isLake = (state, hk) => { const h = state.board.hexes[hk]; return !!h && state.board.terrain[h.terrain].water && !!h.band; };

/** Reach points for an opened hex: by band (rule reachBands), else vpPerReach. */
export function hexReach(state, hk) {
  const bands = String(state.config.reachBands || "").split(",").map((x) => Number(x));
  if (bands.length < 3 || bands.some(Number.isNaN)) return state.config.vpPerReach + (featureOf(state, hk)?.reachBonus || 0);
  return bands[{ coast: 0, inland: 1, highland: 2 }[bandOf(state, hk)] ?? 0] + (featureOf(state, hk)?.reachBonus || 0);
}

/** A hex's feature (hills, marsh) or undefined. */
export const featureOf = (state, hk) => state.board.features?.[state.board.hexes[hk]?.feature];

/** Does this edge touch the highland? */
export const touchesHighland = (state, ek) => { const e = state.board.edges[ek]; return bandOf(state, e.a) === "highland" || bandOf(state, e.b) === "highland"; };

/** Does this edge start at a harbour mouth, or share a corner with a linked canal? */
export const extendsNetwork = (state, ek, link = linkedNetwork(state)) =>
  edgeCorners(ek).some((c) => link.corners.has(c));

/**
 * Own harbours: one harbour hex per player, spread along the coast (harbours
 * sorted by q, then r). On a coast with bays the harbours differ, so the
 * best of those chosen (fewest canals to the inland, then most ground within
 * four) goes to the last seat and the worst to the first, offsetting the
 * first player's head start. As Game.harbours in sim/rules.py, which (frozen at
 * stage 1, on a coast without bays) hands them out in seat order.
 */
export function assignHarbours(board, players) {
  const hb = Object.values(board.hexes).filter((h) => h.harbour).sort((a, b) => a.q - b.q || a.r - b.r).map((h) => h.key);
  if (!hb.length) return [];
  const k = hb.length;
  const chosen = Array.from({ length: players }, (_, i) => (players <= k ? hb[Math.floor(((i + 0.5) * k) / players)] : hb[i % k]));
  const rate = harbourRatings(board);
  const order = [...new Set(chosen)].sort((a, b) => rate[a].inland - rate[b].inland || rate[b].near - rate[a].near || a.localeCompare(b));
  // Distinct harbours: worst to seat 0, best to the last seat. (More players than harbours: seat order.)
  if (order.length < players) return chosen;
  return order.reverse();
}

/** For each harbour: canals from its mouths to the nearest inland border, and land hexes within four canals. */
export function harbourRatings(board) {
  const edges = Object.keys(board.edges), byCorner = {};
  for (const ek of edges) for (const c of edgeCorners(ek)) (byCorner[c] ||= []).push(ek);
  const out = {};
  for (const h of Object.values(board.hexes).filter((x) => x.harbour)) {
    const mouths = new Set(board.mouths.filter((c) => c.split("/").includes(h.key)));
    const dist = new Map(), q = [];
    for (const ek of edges) if (edgeCorners(ek).some((c) => mouths.has(c))) { dist.set(ek, 1); q.push(ek); }
    for (let i = 0; i < q.length; i++) for (const c of edgeCorners(q[i])) for (const n of byCorner[c] || []) if (!dist.has(n)) { dist.set(n, dist.get(q[i]) + 1); q.push(n); }
    let inland = 99;
    const near = new Set();
    for (const [ek, d] of dist) {
      const e = board.edges[ek];
      if ([e.a, e.b].some((x) => board.hexes[x].band === "inland" || board.hexes[x].band === "highland")) inland = Math.min(inland, d);
      if (d <= 4) { near.add(e.a); near.add(e.b); }
    }
    out[h.key] = { inland, near: near.size };
  }
  return out;
}

/** Where player pi's starting cards may dig from: their harbour's mouths and their own sea-linked canals' corners. */
export function ownCorners(state, pi, link = linkedNetwork(state)) {
  const e = netEntry(state);
  if (link === e.link) return ((e.own ||= {})[pi] ||= computeOwn(state, pi, link));
  return computeOwn(state, pi, link);
}

function computeOwn(state, pi, link) {
  const hk = state.harbours?.[pi];
  const out = new Set(harbourMouths(state).filter((c) => c.split("/").includes(hk)));
  for (const [ek, o] of Object.entries(state.dug)) if (o === pi && link.edges.has(ek)) for (const c of edgeCorners(ek)) out.add(c);
  return out;
}

export const extendsOwn = (state, ek, pi) => { const own = ownCorners(state, pi, linkedNetwork(state)); return edgeCorners(ek).some((c) => own.has(c)); };

/** Whether the card played this turn lets its diggers work away from the network here. */
export const remoteDigAllowed = (state, ek) => {
  const where = state.turn?.digAnywhere || "";
  return where === "any" || (where !== "" && where === edgeZone(state, ek));
};

/** Hubs = crossing destinations (alternative rules). `hub` column, else the land furthest from water. */
function pickHubs(board) {
  const marked = Object.values(board.hexes).filter((h) => h.hub);
  if (marked.length) return marked.map((h) => h.key);
  const dist = {};
  const queue = [];
  for (const h of Object.values(board.hexes)) if (board.terrain[h.terrain].water) { dist[h.key] = 0; queue.push(h); }
  while (queue.length) {
    const h = queue.shift();
    for (const [dq, dr] of NEIGHBOURS) {
      const n = board.hexes[hexKey(h.q + dq, h.r + dr)];
      if (n && dist[n.key] === undefined) { dist[n.key] = dist[h.key] + 1; queue.push(n); }
    }
  }
  const max = Math.max(...Object.values(dist));
  return Object.keys(dist).filter((k) => dist[k] === max && max > 0);
}

// --------------------------------------------------------------------------- //
// Building types (docs/buildings.md): nine, from board/buildings.csv, under
// the buildingTypes rule. Off, every building is the plain one.
// --------------------------------------------------------------------------- //

// With building types off, every building is this one: it needs clay, and any
// building on a clay bed, forest or mountain is its extractor. As sim/content.py PLAIN.
export const PLAIN_BUILDING = [{ id: "building", name: "Building", glyph: "■", extraCost: 0, vp: "base",
  vpPerNeighbour: 0, income: 0, moneyPerCanal: 0, minCanals: 0, supply: 0, site: "", extracts: true,
  yield: 3, needs: ["clay"], digDiscount: 0, handSize: 0, port: false, rules: "2 VP and +1 income." }];

export function buildingTypes(rows) {
  const types = (rows || []).filter((r) => r.id).map((r) => ({
    id: r.id, name: r.name || r.id, glyph: (r.glyph || r.id[0]).slice(0, 2),
    extraCost: Number(r.extra_cost) || 0,
    vp: ["base", "terrain", "", undefined, null].includes(r.vp) ? "base" : Number(r.vp) || 0,
    vpPerNeighbour: Number(r.vp_per_neighbour) || 0,
    neighbourCap: Number(r.neighbour_cap) || 0,   // most VP that bonus gives; 0 is uncapped
    income: Number(r.income) || 0, // on top of incomePerBuilding
    moneyPerCanal: Number(r.money_per_canal) || 0,
    minCanals: Number(r.min_canals) || 0,
    supply: Number(r.supply) || 0, // 0 = unlimited
    site: ["clay", "wood", "stone"].includes((r.site || "").trim().toLowerCase()) ? r.site.trim().toLowerCase() : "",
    extracts: truthy(r.extracts),   // a clay pit, logging camp or quarry: puts `yield` cubes on its hex
    yield: Number(r.yield) || 0,
    needs: (r.needs || "").split("+").map((x) => x.trim().toLowerCase()).filter((x) => ["clay", "wood", "stone"].includes(x)),
    digDiscount: Number(r.dig_discount) || 0,  // off the owner's digs that touch its hex
    handSize: Number(r.hand_size) || 0,
    port: truthy(r.port),           // an inland port: import cubes can be hauled from here
    lock: truthy(r.lock),           // hauls through canals on its borders pay its owner 1 (hauling "tolls")
    rules: r.rules || "",
  }));
  return types.length ? types : PLAIN_BUILDING;
}

export const btype = (state, id) => state.buildingTypes.find((b) => b.id === id) || state.buildingTypes[0];

// --------------------------------------------------------------------------- //
// Setup
// --------------------------------------------------------------------------- //

/**
 * data: { cards, hexes, terrain, buildings? } — each a list of CSV rows.
 *   Omit `buildings` for the settled plain building.
 * config: DEFAULTS overrides plus
 *   players: ["Ana", "Ben"]
 *   startingDeck: { cardId: copiesPerPlayer }   (default: 1 of each `starting` card)
 *   market: { cardId: copies }                   (default: `copies` column of non-starting cards)
 */
export const STATE_VERSION = 10;

export function createGame(data, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const defs = {};
  for (const row of data.cards) if (row.id) defs[row.id] = cardDef(row);

  const state = {
    version: STATE_VERSION,   // 10: split market, tiers, market clock, game end by trigger; 9: resource cubes and pearls; 8: board grows with players; 7: inland milestone; 6: building types; 5: building materials; 4: canals join at corners and start at harbour mouths
    config: cfg,
    rng: (Number(cfg.seed) >>> 0) || 1,
    defs,
    board: buildBoard(data.hexes, data.terrain, (cfg.players && cfg.players.length) || 2),
    dug: {},          // edgeKey -> player index
    buildings: {},    // hexKey -> [{ p: player index, type: building id }]
    // docs/buildings.md: board/buildings.csv when the rule is on.
    buildingTypes: buildingTypes(cfg.buildingTypes ? data.buildings : undefined),
    // The technology board (brainstorm-stage-3.md 5): board/tech.csv, under rule techBoard.
    tech: cfg.techBoard && cfg.techBoard !== "off" && data.tech?.length && cfg.buildingTypes ? techBoard(data.tech) : null,
    claimed: {},      // hexKey -> player who took its discovery
    cubes: {},        // hexKey -> resource cubes left on an extractor (docs/resources.md)
    supply: null,     // resource -> cubes left in the import market; set below
    crossings: [],    // { hub, edges: [edgeKey], round } (alternative rules)
    players: [],
    // stack: the coastal deck; display: its cards for sale (oldest first);
    // inland / inlandDisplay: the same for inland cards (rule inlandDisplay).
    // bought: whether anyone bought from each display this round (marketClock "unbought").
    market: { display: [], stack: [], inland: [], inlandDisplay: [], gone: [], bought: { coastal: false, inland: false } },
    inlandOpen: cfg.inlandMilestone === "none",   // deep digs, inland building, inland cards
    inlandRound: cfg.inlandMilestone === "none" ? 0 : null,
    cards: {},        // uid -> cardId
    trash: [],
    round: 1,
    current: 0,
    turnNumber: 0,
    turn: null,
    endTriggered: false,
    endReason: "",    // "market", "keys", "crossing" or "cap"
    over: false,
    log: [],
    history: [],      // per-turn records for analysis
    nextUid: 1,
  };
  const mint = (id) => { const uid = state.nextUid++; state.cards[uid] = id; return uid; };

  state.hubs = pickHubs(state.board);
  state.supply = Object.fromEntries(RESOURCES.map((r) => [r, marketTrack(state).length]));
  if (!Object.values(state.board.hexes).some((h) => h.isKey) && cfg.autoKeyTiles > 0) {
    const pool = Object.values(state.board.hexes)
      .filter((h) => state.board.terrain[h.terrain].buildable && !h.shore && !state.hubs.includes(h.key))
      .map((h) => h.key).sort();
    shuffle(state, pool).slice(0, cfg.autoKeyTiles).forEach((k) => (state.board.hexes[k].isKey = true));
  }

  const startingDeck = cfg.startingDeck ||
    Object.fromEntries(Object.values(defs).filter((d) => d.deck === "starting").map((d) => [d.id, 1]));
  const names = cfg.players && cfg.players.length ? cfg.players : ["Player 1", "Player 2"];
  state.harbours = cfg.ownHarbours ? assignHarbours(state.board, names.length) : [];   // own harbours, by seat
  dealTokens(state);
  names.forEach((name, i) => {
    const deck = [];
    for (const [id, n] of Object.entries(startingDeck)) for (let k = 0; k < n; k++) if (defs[id]) deck.push(mint(id));
    const p = {
      name, colour: PLAYER_COLOURS[i % PLAYER_COLOURS.length],
      draw: shuffle(state, deck), hand: [], discard: [], play: [],
      money: cfg.startingPurse, income: cfg.startingIncome, keys: 0, handSize: cfg.handSize, pearls: 0, pearlTrack: 0,
      taken: [],      // technology board slots emptied (their tokens built), in order
      stats: { turns: 0, boosted: 0, discarded: 0, digs: 0, builds: 0, buys: 0, earns: 0, trashed: 0,
        spent: 0, earned: 0, discoveries: 0, rent: 0, hauled: {}, playedByRole: {}, builtByType: {} },
    };
    state.players.push(p);
    drawTo(state, p, p.handSize);
  });

  // Market (docs/cards.md): a coastal and an inland deck, each tiered
  // (coastal-2 under coastal). The inland cards form their own display when
  // the inland opens (inlandDisplay), or shuffle into the coastal deck.
  const market = cfg.market || scaledMarket(defs, cfg.deckSizes, names.length);
  const piles = { coastal: [], inland: [] };
  for (const [id, n] of Object.entries(market)) {
    const d = defs[id];
    if (!d || n <= 0 || d.deck === "starting") continue;
    const pile = deckFamily(d.deck) === "inland" ? piles.inland : piles.coastal;
    for (let k = 0; k < n; k++) pile.push(mint(id));
  }
  state.market.stack = tiered(state, piles.coastal);
  state.market.inland = tiered(state, piles.inland);
  state.marketSize = state.market.stack.length + state.market.inland.length;
  if (state.inlandOpen && !cfg.inlandDisplay) {
    state.market.stack = tiered(state, [...state.market.stack, ...state.market.inland]);
    state.market.inland = [];
  }
  restock(state);

  log(state, `Game start: ${names.join(", ")}. Seed ${cfg.seed}.`);
  startTurn(state);
  // The harbour draft: the last seat chooses first, then back to the first seat.
  if (cfg.ownHarbours && cfg.harbourDraft && state.harbours.length) {
    state.harbours = names.map(() => null);
    state.draft = { order: names.map((_, i) => names.length - 1 - i) };
    state.current = state.draft.order[0];
    state.turn = { phase: "harbour", pool: {}, actions: [], discards: [] };
    log(state, `Harbour draft: ${state.players[state.current].name} chooses first.`);
  }
  return state;
}

/** Harbours still free in the draft. */
export const draftChoices = (state) => Object.values(state.board.hexes)
  .filter((h) => h.harbour && !state.harbours.includes(h.key)).map((h) => h.key);

/** What a harbour costs in the draft: harbourPremium for a deep one (2+ canals nearer the inland than the median). */
export function harbourPremium(state, hk) {
  const r = (state.board.ratings ||= harbourRatings(state.board));
  const ds = Object.values(r).map((x) => x.inland).sort((a, b) => a - b);
  const median = ds[Math.floor(ds.length / 2)];
  return r[hk] && r[hk].inland <= median - 2 ? state.config.harbourPremium : 0;
}

/** Choose a harbour in the draft. */
export function chooseHarbour(state, hk) {
  if (state.turn?.phase !== "harbour") return fail("not choosing harbours");
  if (!draftChoices(state).includes(hk)) return fail("not a free harbour");
  const p = currentPlayer(state), cost = harbourPremium(state, hk);
  state.harbours[state.current] = hk;
  p.money -= cost;
  log(state, `${p.name} takes the harbour at ${hk}${cost ? `, paying ${cost} of their starting money: it is a deep harbour` : ""}.`);
  const next = state.draft.order[state.draft.order.indexOf(state.current) + 1];
  if (next === undefined) {
    state.draft = null;
    state.current = 0;
    startTurn(state);
  } else state.current = next;
  return OK;
}

/** A computer player's harbour: nearest the inland, then most ground, less its premium. */
export function bestHarbour(state, rnd = null) {
  const r = (state.board.ratings ||= harbourRatings(state.board));
  const val = (hk) => -r[hk].inland + 0.15 * r[hk].near - 0.5 * harbourPremium(state, hk) + (rnd ? rnd() * 0.5 : 0);
  return draftChoices(state).sort((a, b) => val(b) - val(a))[0];
}

function log(state, msg) { if (!state.quiet) state.log.push({ round: state.round, msg }); }

/**
 * A copy for search (computer players' look-ahead): the mutable parts copied,
 * the board, card definitions and rules shared, and no log or history. Pass
 * `rng` to give the copy its own shuffles.
 */
export function cloneState(state, rng) {
  const c = { ...state, quiet: true, log: [], history: [] };
  const deep = structuredClone({ dug: state.dug, buildings: state.buildings, claimed: state.claimed, cubes: state.cubes,
    supply: state.supply, crossings: state.crossings, tokenClaimed: state.tokenClaimed, capstones: state.capstones || {}, players: state.players, market: state.market, trash: state.trash, turn: state.turn });
  Object.assign(c, deep);
  if (rng !== undefined) c.rng = (rng >>> 0) || 1;
  return c;
}

export const def = (state, uid) => state.defs[state.cards[uid]];
export const currentPlayer = (state) => state.players[state.current];

function drawTo(state, p, n) {
  while (p.hand.length < n) {
    if (!p.draw.length) {
      if (!p.discard.length) break;
      p.draw = shuffle(state, p.discard);
      p.discard = [];
    }
    p.hand.push(p.draw.pop());
  }
}

/**
 * The market's copies at this player count (rule deckSizes, "deck=2p/3p/4p/5p, ...").
 * Copies are cut, never designs: Earn first, then the design with the most
 * copies (ties by file order), each design keeping at least one.
 */
export function scaledMarket(defs, deckSizes, players) {
  const all = Object.values(defs).filter((d) => d.deck !== "starting");
  const market = Object.fromEntries(all.map((d) => [d.id, d.copies]));
  for (const part of String(deckSizes || "").split(",")) {
    const [deck, sizes] = part.split("=").map((x) => (x || "").trim());
    if (!deck || !sizes) continue;
    const list = sizes.split("/").map(Number);
    const target = list[Math.min(list.length - 1, Math.max(0, players - 2))];
    const designs = all.filter((d) => d.deck === deck);
    let total = designs.reduce((a, d) => a + market[d.id], 0);
    while (total > target) {
      const cuttable = designs.filter((d) => market[d.id] > 1);
      if (!cuttable.length) break;
      const earn = cuttable.filter((d) => d.role === "earn");
      const from = earn.length ? earn : cuttable;
      const d = from.reduce((a, b) => (market[b.id] > market[a.id] ? b : a));
      market[d.id]--; total--;
    }
  }
  return market;
}

// --------------------------------------------------------------------------- //
// The technology board (brainstorm-stage-3.md 5): each player's honeycomb of
// building tokens. An open centre, six inner slots (one a sector) and twelve
// outer ones; a building's token comes from a slot next to an open one (the
// centre, or a slot already emptied), or from anywhere for a pearl (the leap).
// Every building comes from the board: eighteen tokens, nothing beyond.
// Geometry: inner i touches the centre, inner i±1, corner i, edges i and i-1;
// corner i touches inner i and edges i-1 and i; edge i (between sectors i and
// i+1) touches inners i and i+1 and corners i and i+1.
// --------------------------------------------------------------------------- //

export function techBoard(rows) {
  const slots = rows.filter((r) => r.id).map((r) => ({
    id: r.id, sector: r.sector, ring: r.ring, token: r.token, income: Number(r.income) || 0,
    tech: r.tech, name: r.name, text: r.text,
  }));
  const at = (ring, i) => slots.find((x) => x.ring === ring && Number(x.id.slice(1)) === ((i % 6) + 6) % 6)?.id;
  const adj = {};
  for (const x of slots) {
    const i = Number(x.id.slice(1));
    adj[x.id] = (x.ring === "inner" ? ["centre", at("inner", i + 1), at("inner", i - 1), at("corner", i), at("edge", i), at("edge", i - 1)]
      : x.ring === "corner" ? [at("inner", i), at("edge", i - 1), at("edge", i)]
      : [at("inner", i), at("inner", i + 1), at("corner", i), at("corner", i + 1)]).filter(Boolean);
  }
  return { slots, adj, sectors: [...new Set(slots.map((x) => x.sector))] };
}

export const techOn = (state) => !!state.tech;
const TECH_LEVEL = { income: 0, level1: 1, level2: 2, full: 3 };
/** How far the board is played: 0 tokens and income, 1 inner technologies, 2 outer ones too, 3 capstones. */
export const techLevel = (state) => (state.tech ? TECH_LEVEL[state.config.techBoard] ?? 0 : -1);

/**
 * Capstones (brainstorm-stage-3.md 5.5): the first player to empty all three
 * slots of a sector takes its tile. "One more card" tiles count two, as
 * multipliers go in steps.
 */
export const CAPSTONES = {
  Channels: { name: "Navigator", text: "Highland and marsh hexes count 1 more in your Reach." },
  Works: { name: "Architect", text: "4 VP of building score." },
  Barges: { name: "Harbour master", text: "Counts as two more Buy cards." },
  Market: { name: "Patron", text: "Counts as two more Build cards." },
  Stores: { name: "Treasurer", text: "If you own two or more Earn cards, counts as two more cards of the colour that scores you most (not Dig)." },
  Pearls: { name: "Pearl diver", text: "Each pearl you hold at the end counts as 1 Reach, up to 4." },
};

/** The sectors whose capstone player pi holds. */
export const capstonesOf = (state, pi) => Object.keys(state.capstones || {}).filter((k) => state.capstones[k] === pi);

/** Has player pi this technology (its slot emptied, at a level that plays it)? */
export function hasTech(state, pi, tech) {
  if (!state.tech) return false;
  const lvl = techLevel(state);
  const x = state.tech.slots.find((y) => y.tech === tech);
  if (!x || lvl < (x.ring === "inner" ? 1 : 2)) return false;
  return (state.players[pi]?.taken || []).includes(x.id);
}

/** The most pearls this player may hold: pearlCap, 2 more with Diving. */
export function pearlCapOf(state, p) {
  return state.config.pearlCap + (hasTech(state, state.players.indexOf(p), "diving") ? 2 : 0);
}
export const techSlot = (state, id) => state.tech?.slots.find((x) => x.id === id);
export const techName = (state, tech) => state.tech?.slots.find((x) => x.tech === tech)?.name || tech;

/** Can this slot be reached without a leap: next to the centre or an emptied slot? */
export function slotReachable(state, pi, id) {
  const taken = state.players[pi].taken || [];
  return state.tech.adj[id].some((n) => n === "centre" || taken.includes(n));
}

/** Slots holding a token of this type for pi: [{ id, leap }], reachable ones first, inner before outer. */
export function buildSlots(state, pi, typeId) {
  if (!state.tech) return [];
  const taken = state.players[pi].taken || [];
  const ring = { inner: 0, corner: 1, edge: 1 };
  return state.tech.slots.filter((x) => x.token === typeId && !taken.includes(x.id))
    .map((x) => ({ id: x.id, leap: !slotReachable(state, pi, x.id), ring: ring[x.ring] }))
    .sort((a, b) => a.leap - b.leap || a.ring - b.ring)
    .map(({ id, leap }) => ({ id, leap }));
}

/** The slot a build would use: the one asked for if legal, else the first reachable, else a leap if affordable. */
export function pickSlot(state, pi, typeId, slotId) {
  const list = buildSlots(state, pi, typeId), p = state.players[pi];
  const leapOk = (p.pearls || 0) >= state.config.techLeapCost && state.config.techLeapCost >= 0;
  if (slotId) {
    const x = list.find((y) => y.id === slotId);
    return x && (!x.leap || leapOk) ? x : null;
  }
  return list.find((x) => !x.leap) || (leapOk ? list[0] : null) || null;
}

/** Income a building of this type gives: its slot's printed income on the board, else incomePerBuilding; plus the type's own. */
export function buildIncome(state, typeId, slotId) {
  const bt = btype(state, typeId);
  if (!state.tech) return state.config.incomePerBuilding + bt.income;
  const x = slotId ? techSlot(state, slotId) : null;
  return (x ? x.income + (x.tech === "granary" && techLevel(state) >= 1 ? 1 : 0) : 0) + bt.income;
}

/** The siteTokens rule: [{ name, code, copies, bands }]. */
export function tokenPool(cfg) {
  return String(cfg.siteTokens || "").split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [name, rest = ""] = x.split("=");
    const [code, copies, bands] = rest.split(":");
    return { name: name.trim(), code: (code || "").trim(), copies: Number(copies) || 1, bands: (bands || "").split("/").map((b) => b.trim()).filter(Boolean) };
  }).filter((t) => t.code);
}

/** Site tokens: each token site takes the first shuffled token allowed in its band, the most constrained sites first. */
function dealTokens(state) {
  state.tokens = {};
  state.tokenClaimed = {};
  const sites = Object.values(state.board.hexes).filter((h) => h.tokenSite);
  if (!sites.length) return;
  const bag = shuffle(state, tokenPool(state.config).flatMap((t) => Array.from({ length: t.copies }, () => t)));
  // The sites with fewest tokens allowed first (a highland site takes only a hoard), then board order.
  const fits = (h) => bag.filter((t) => !t.bands.length || t.bands.includes(h.band)).length;
  sites.sort((a, b) => fits(a) - fits(b));
  for (const h of sites) {
    const i = bag.findIndex((t) => !t.bands.length || t.bands.includes(h.band));
    if (i >= 0) { const t = bag.splice(i, 1)[0]; state.tokens[h.key] = { name: t.name, code: t.code }; }
  }
}

/** "coastal-2" -> "coastal": the market deck a card belongs to. */
export const deckFamily = (deck) => String(deck || "").toLowerCase().split("-")[0];
/** "coastal-2" -> 2; plain "coastal" is tier 1. */
export const deckTier = (deck) => { const t = String(deck || "").split("-")[1]; return /^\d+$/.test(t || "") ? Number(t) : 1; };

/** Shuffle each tier on its own and stack them, tier 1 on top (drawn first: the end). */
function tiered(state, pile) {
  const tiers = {};
  for (const uid of pile) (tiers[deckTier(def(state, uid).deck)] ||= []).push(uid);
  return Object.keys(tiers).map(Number).sort((a, b) => b - a).flatMap((t) => shuffle(state, tiers[t]));
}

function restock(state) {
  const m = state.market, size = state.config.displaySize;
  while (m.display.length < size && m.stack.length) m.display.push(m.stack.pop());
  if (state.config.inlandDisplay && state.inlandOpen) {
    while (m.inlandDisplay.length < size && m.inland.length) m.inlandDisplay.push(m.inland.pop());
  }
}

/** The cards for sale: buy slots number the coastal display, then the inland one. */
/** The cards the current player may buy: the displays, then any they reserved (Reserve). */
export const marketCards = (state) => [...state.market.display, ...state.market.inlandDisplay, ...(state.players[state.current]?.reserved || [])];

/** Both market decks are empty (the inland one too, open or not). */
export const marketExhausted = (state) => !state.market.stack.length && !state.market.inland.length;

/** Every key tile is on the sea-linked network. */
export function keysConnected(state) {
  const band = state.config.endKeysBand || "";
  const keys = Object.keys(state.board.hexes).filter((hk) => state.board.hexes[hk].isKey && (!band || bandOf(state, hk) === band));
  if (!keys.length) return false;
  const net = networkHexes(state, linkedNetwork(state));
  const need = Math.ceil(keys.length * Math.min(1, Math.max(0, Number(state.config.endKeysShare ?? 1))) - 1e-9);
  return keys.filter((hk) => net.has(hk)).length >= Math.max(1, need);
}

/**
 * An estimate of the rounds still to play, for computer players: the market
 * decks at the pace they have run down so far (a prior of one card a round
 * plus half a card a player, worth three rounds), within the cap. As
 * Game.rounds_left in sim/rules.py.
 */
export function roundsLeft(state) {
  const cfg = state.config, done = state.round - 1;
  const cap = Math.max(0, cfg.rounds - done);
  if (!cfg.endOnMarket) return cap;
  const m = state.market, left = m.stack.length + m.inland.length;
  const drawn = Math.max(0, state.marketSize - left - m.display.length - m.inlandDisplay.length);
  const prior = 1 + 0.5 * state.players.length;
  const pace = (drawn + 3 * prior) / (done + 3);
  return Math.min(cap, left / Math.max(0.5, pace) + 1);
}

function startTurn(state) {
  state.turn = { phase: "choose", played: null, discards: [], pool: {}, actions: [] };
}

function gain(p, n) { p.money += n; p.stats.earned += n; }

/** Earn: collect your income (settled), or N flat money under the passive-income alternative. */
function earn(state, p, times) {
  if (!times) return;
  const n = state.config.incomeMode === "earn" ? p.income * times : times;
  gain(p, n);
  p.stats.earns += times;
  log(state, `${p.name} earns ${n}.`);
}

const NEW_POOL = () => ({ dig: 0, build: 0, buy: 0, digDiscount: 0, buildDiscount: 0, buyDiscount: 0,
  trashAny: 0, trashHand: 0, trashDiscard: 0, extraDraw: 0 });

/** Apply an effect bundle: immediate parts now, actions into this turn's pool. */
function applyEffects(state, p, fx) {
  const pool = state.turn.pool;
  for (const [k, n] of Object.entries(fx)) {
    if (k === "money") gain(p, n);
    else if (k === "income") p.income += n;
    else if (k === "keys") p.keys += n;
    else if (k === "handSize") p.handSize = Math.min(state.config.handSizeCap || Infinity, p.handSize + n);
    else if (k === "earn") earn(state, p, n);
    else pool[k] = (pool[k] || 0) + n;
  }
}

// --------------------------------------------------------------------------- //
// Turn actions. Each returns { ok: true } or { ok: false, reason }.
// --------------------------------------------------------------------------- //

const fail = (reason) => ({ ok: false, reason });
const OK = { ok: true };

/**
 * Board boosts (technologies, brainstorm-stage-3.md 5.4): printed boosts for a
 * colour, used instead of the card's own boost, never both. need: the
 * discards' colour (null: any) and how many (0: one or more).
 */
export const BOARD_BOOSTS = {
  relay: { role: "dig", need: "dig", n: 1, fx: { dig: 1 }, text: "discard a Dig card for one more dig" },
  yard: { role: "build", need: "build", n: 1, fx: { build: 1 }, text: "discard a Build card for one more build" },
  barter: { role: "buy", need: "earn", n: 1, fx: { buyDiscount: 2 }, text: "discard an Earn card for 2 off" },
  larder: { role: "earn", need: null, n: 0, fx: { money: 2 }, perCard: true, text: "2 money per card discarded" },
};

/** The board boosts player pi may use on this card. */
export function boardBoosts(state, pi, d) {
  return Object.keys(BOARD_BOOSTS).filter((k) => BOARD_BOOSTS[k].role === d.role && hasTech(state, pi, k));
}

/** Do these discards (uids) pay board boost b? */
export function boardBoostLegal(state, b, uids) { return !!BOARD_BOOSTS[b] && boardBoostOk(state, b, uids.map((u) => def(state, u))); }

function boardBoostOk(state, b, discards) {
  const x = BOARD_BOOSTS[b];
  if (x.n ? discards.length !== x.n : !discards.length) return false;
  return !x.need || discards.every((dd) => dd.role === x.need);
}

/** Play a card from hand, discarding `discardUids` to boost it (or a board boost: `board`, a technology id). */
export function playCard(state, uid, discardUids = [], board = null) {
  const t = state.turn, p = currentPlayer(state);
  if (state.over || t.phase !== "choose") return fail("not choosing a card");
  if (!p.hand.includes(uid)) return fail("card not in hand");
  if (discardUids.includes(uid) || new Set(discardUids).size !== discardUids.length) return fail("bad discards");
  if (!discardUids.every((u) => p.hand.includes(u))) return fail("discard not in hand");
  const d = def(state, uid);
  if (board) {
    if (!boardBoosts(state, state.current, d).includes(board)) return fail(`no ${board} board boost for this card`);
    if (!boardBoostOk(state, board, discardUids.map((u) => def(state, u)))) return fail(`${board}: ${BOARD_BOOSTS[board].text}`);
  } else if (!legalDiscards(d, discardUids.map((u) => def(state, u)))) {
    return fail(`${d.boostCostText || "no boost"}: those discards don't pay it`);
  }

  // As sim/rules.py: the played card goes straight to the discard pile.
  p.hand = p.hand.filter((u) => u !== uid && !discardUids.includes(u));
  p.discard.push(uid, ...discardUids);

  t.phase = "resolve";
  t.played = uid;
  t.digAnywhere = d.digAnywhere || "";
  // Own harbours: a starting card's digs extend only its player's own canals.
  // Sluice (technology): your starting cards join anyone's canals.
  t.ownOnly = state.harbours?.length && d.deck === "starting" && !hasTech(state, state.current, "sluice") ? state.current : -1;
  t.starter = d.deck === "starting";
  t.discards = discardUids;
  // Second wind (technology): a second card adds to what is left of the first's pool.
  const carry = t.secondWind ? t.pool : null;
  t.secondWind = false;
  t.pool = NEW_POOL();
  if (carry) for (const [k, n] of Object.entries(carry)) t.pool[k] = (t.pool[k] || 0) + n;
  const fx = board ? { ...resolveEffects(d, 0) } : resolveEffects(d, discardUids.length);
  if (board) {
    const x = BOARD_BOOSTS[board];
    for (const [k, n] of Object.entries(x.fx)) fx[k] = (fx[k] || 0) + n * (x.perCard ? discardUids.length : 1);
    t.boardBoost = board;
  } else t.boardBoost = null;
  t.effects = fx;
  p.stats.turns++;
  p.stats.playedByRole[d.role] = (p.stats.playedByRole[d.role] || 0) + 1;
  if (discardUids.length) { p.stats.boosted++; p.stats.discarded += discardUids.length; }
  log(state, `${p.name} plays ${displayName(d)}${discardUids.length ? ` discarding ${discardUids.length}` : ""}${board ? ` (board boost: ${techName(state, board)})` : ""}.`);
  applyEffects(state, p, fx);
  return OK;
}

/**
 * The navigable canals (anyone's): every dug canal at a harbour mouth, and
 * every dug canal sharing a corner with one already linked. Returns the linked
 * edges and the corners the network reaches, mouths included.
 */
// The network depends only on which edges are dug (never undug), so it is
// cached per `dug` object and its size. Clones get their own `dug` object.
const NET_CACHE = new WeakMap();
function netEntry(state) {
  const n = Object.keys(state.dug).length;
  let e = NET_CACHE.get(state.dug);
  if (!e || e.n !== n) { e = { n, link: null, net: null }; NET_CACHE.set(state.dug, e); }
  return e;
}

export function linkedNetwork(state) {
  const e = netEntry(state);
  return e.link ||= computeLinked(state);
}

function computeLinked(state) {
  const byCorner = {};
  for (const ek of Object.keys(state.dug)) for (const c of edgeCorners(ek)) (byCorner[c] ||= []).push(ek);
  const edges = new Set(), corners = new Set(harbourMouths(state));
  const queue = Object.keys(state.dug).filter((ek) => edgeCorners(ek).some((c) => corners.has(c)));
  queue.forEach((ek) => edges.add(ek));
  // A lake: once a linked canal reaches one of its corners, all its corners are linked.
  const lakeCorners = {};
  for (const hk of Object.keys(state.board.hexes)) if (isLake(state, hk)) lakeCorners[hk] = hexCorners(hk);
  const lakes = Object.keys(lakeCorners).length > 0;
  const reach = (c) => {
    if (corners.has(c)) return;
    corners.add(c);
    for (const n of byCorner[c] || []) if (!edges.has(n)) { edges.add(n); queue.push(n); }
    if (lakes) for (const hk of c.split("/")) if (lakeCorners[hk]) for (const lc of lakeCorners[hk]) reach(lc);
  };
  // Mouths are linked from the start; a lake touching one links too.
  for (const c of [...corners]) { corners.delete(c); reach(c); }
  while (queue.length) for (const c of edgeCorners(queue.shift())) reach(c);
  return { edges, corners };
}

/** Hexes on the navigable network: water, and every hex bordered by a linked canal. */
export function networkHexes(state, link = linkedNetwork(state)) {
  const e = netEntry(state);
  if (link === e.link) return e.net ||= computeNet(state, link);
  return computeNet(state, link);
}

function computeNet(state, link) {
  const seen = new Set(Object.keys(state.board.hexes).filter((k) => isWater(state, k)));
  for (const ek of link.edges) { const e = state.board.edges[ek]; seen.add(e.a); seen.add(e.b); }
  return seen;
}

/** Opened: an inland hex (not beside open water) on the navigable network. */
export const isOpened = (state, hk, net = networkHexes(state)) =>
  net.has(hk) && !isWater(state, hk) && !state.board.hexes[hk].shore;

// --------------------------------------------------------------------------- //
// The inland milestone (docs/map-and-network.md). Until it is reached no canal
// may have inland on both sides, nothing is built inland, and the inland cards
// stay out of the market. As sim/rules.py.
// --------------------------------------------------------------------------- //

// Beyond the coast: the inland band, and the highland past it (stage 2 map).
export const isInland = (state, hk) => { const b = state.board.hexes[hk]?.band; return b === "inland" || b === "highland"; };
/** Is the inland closed to digging and building? Only a counted milestone
 * gates them; under "open" only the cards wait, as in the earlier rule. */
export const inlandClosed = (state) => !state.inlandOpen && ["canals", "keys"].includes(state.config.inlandMilestone);

/** Inland on both sides: closed until the milestone. */
export const isDeep = (state, ek) => { const e = state.board.edges[ek]; return isInland(state, e.a) && isInland(state, e.b); };

/** { have, need, what } towards the milestone. */
export function milestoneProgress(state, link = linkedNetwork(state)) {
  const mode = state.config.inlandMilestone;
  // Per player, rounded down (at least 1), as sim/rules.py milestone_need.
  const need = mode === "open" ? 1 : Math.max(1, Math.floor(state.config.inlandMilestonePerPlayer * state.players.length + 1e-9));
  if (mode === "canals") {
    const have = [...link.edges].filter((ek) => { const e = state.board.edges[ek]; return isInland(state, e.a) || isInland(state, e.b); }).length;
    return { have, need, what: `canals bordering inland hexes` };
  }
  const net = networkHexes(state, link);
  if (mode === "keys") return { have: [...net].filter((hk) => state.board.hexes[hk].isKey).length, need, what: "key tiles on the network" };
  return { have: [...net].filter((hk) => isOpened(state, hk, net)).length, need, what: "opened inland hexes" };
}

/** Open the inland once the milestone is reached, at once, so the rest of the turn may use it. */
export function checkInland(state, quiet = false) {
  if (state.inlandOpen) return;
  const { have, need, what } = milestoneProgress(state);
  if (have < need) return;
  state.inlandOpen = true;
  state.inlandRound = state.round;
  const m = state.market;
  if (state.config.inlandDisplay) restock(state);   // the inland display opens
  else if (quiet) { m.stack.push(...m.inland); m.inland = []; }
  else { m.stack = tiered(state, [...m.stack, ...m.inland]); m.inland = []; }
  if (!quiet) {
    log(state, `Milestone: ${need} ${what}. The inland is open: canals with inland on both sides, building inland, and the inland cards.`);
    // First-mover reward: the player whose dig reached it, resolved like a discovery.
    const p = currentPlayer(state), code = state.config.milestoneReward;
    p.stats.milestone = true;
    if (code) {
      log(state, `${p.name} reached it first: ${code}.`);
      const fx = {};
      for (const x of parseEffects(code)) fx[x.kind] = (fx[x.kind] || 0) + x.n;
      applyEffects(state, p, fx);
    }
  }
}

/** Discounts apply to every action of that kind this turn (sim/rules.py). */
export function digCost(state, ek, pi = state.current) {
  const [c1, c2] = edgeCorners(ek);
  let camp = 0;   // a digging camp of yours touching the edge; camps do not stack
  for (const [hk, list] of Object.entries(state.buildings)) {
    for (const b of list) {
      const d = btype(state, b.type).digDiscount;
      if (b.p === pi && d > camp) { const hc = hexCorners(hk); if (hc.includes(c1) || hc.includes(c2)) camp = d; }
    }
  }
  let cost = state.board.edges[ek].cost;
  // Tunnelling (technology): hills cost you nothing extra.
  if (state.tech && hasTech(state, pi, "tunnelling")) {
    const e = state.board.edges[ek], b = state.board;
    const dig = (h) => Math.max(0, b.terrain[h.terrain].digCost + (h.feature === "hills" ? 0 : b.features?.[h.feature]?.digMod || 0));
    cost = Math.max(dig(b.hexes[e.a]), dig(b.hexes[e.b]));
  }
  return Math.max(0, cost - (state.turn?.pool?.digDiscount || 0) - camp);
}

export function canDig(state, ek) {
  const t = state.turn, p = currentPlayer(state);
  const e = state.board.edges[ek];
  if (!e) return fail("no such edge");
  if (t.phase !== "resolve" || (t.pool.dig || 0) < 1) return fail("no dig available");
  if (state.dug[ek] !== undefined) return fail("already dug");
  if (inlandClosed(state) && isDeep(state, ek)) return fail("inland on both sides: closed until the inland milestone");
  if (state.config.highlandNeedsBought && t.starter && touchesHighland(state, ek) && !hasTech(state, state.current, "tunnelling") && !(state.tide >= 3)) return fail("a starting card can't dig in the highland: only bought dig cards reach it");
  if (state.config.connectionRequired && t.ownOnly >= 0 && state.harbours?.length) {
    if (!extendsOwn(state, ek, t.ownOnly)) return fail("a starting card digs only from your own harbour or your own canals");
  } else if (state.config.connectionRequired && !extendsNetwork(state, ek) && !remoteDigAllowed(state, ek)) {
    const where = t.digAnywhere;
    return fail(where ? `must join the sea network: this card digs away from it only on ${where} ground`
      : "must join the sea network (only land animals dig away from it)");
  }
  if (p.money < digCost(state, ek)) return fail("not enough money");
  return OK;
}

export function dig(state, ek) {
  const ok = canDig(state, ek);
  if (!ok.ok) return ok;
  const t = state.turn, p = currentPlayer(state), e = state.board.edges[ek];
  const cost = digCost(state, ek);
  const before = networkHexes(state);
  t.pool.dig--;
  p.money -= cost; p.stats.spent += cost; p.stats.digs++;
  state.dug[ek] = state.current;
  t.actions.push({ type: "dig", edge: ek, cost });
  log(state, `${p.name} digs the ${e.a}|${e.b} border for ${cost}.`);

  // Discoveries: taken by the dig that opens the hex, including hexes that
  // light up because this dig linked a stranded chain to the sea.
  const after = networkHexes(state);
  for (const hk of after) {
    if (before.has(hk) || !isOpened(state, hk, after)) continue;
    const h = state.board.hexes[hk];
    if (!h.bonus || state.claimed[hk] !== undefined) continue;
    state.claimed[hk] = state.current;
    p.stats.discoveries++;
    log(state, `${p.name} discovers ${h.bonus} at ${hk}.`);
    const fx = {};
    for (const x of parseEffects(h.bonus)) fx[x.kind] = (fx[x.kind] || 0) + x.n;
    applyEffects(state, p, fx);
  }
  checkInland(state);
  checkTides(state);
  if (state.config.networkScore === "crossings" || state.config.endOnCrossing) checkCrossings(state);
  return OK;
}

/**
 * Three tides (brainstorm-stage-3.md 10.2), rule tides. The second comes
 * with the inland milestone: the undrawn coastal tier-1 cards leave, so the
 * coastal deck is tier 2 from then. The third comes with the first highland
 * village on the network, or the coastal deck running out: the highland
 * opens to starting dig cards and the undrawn inland tier-1 cards leave.
 * The player whose turn turns a tide takes tideReward.
 */
export function checkTides(state) {
  const cfg = state.config, m = state.market;
  if (!cfg.tides || cfg.inlandMilestone === "none") return;
  state.tide ||= 1;
  const leave = (pile, family) => {
    const out = pile.filter((u) => { const d = def(state, u); return deckTier(d.deck) === 1 && deckFamily(d.deck) === family; });
    if (!out.length) return 0;
    const keep = pile.filter((u) => !out.includes(u));
    pile.length = 0; pile.push(...keep);
    m.gone.push(...out);
    return out.length;
  };
  const reward = (what) => {
    const p = currentPlayer(state), code = cfg.tideReward;
    if (!code || !state.turn || state.turn.phase === "over") return;
    log(state, `${p.name} turned the ${what} tide: ${code}.`);
    const fx = {};
    for (const x of parseEffects(code)) fx[x.kind] = (fx[x.kind] || 0) + x.n;
    applyEffects(state, p, fx);
  };
  if (state.tide === 1 && state.inlandOpen) {
    state.tide = 2;
    const n = leave(m.stack, "coastal");
    log(state, `The second tide: ${n} coastal tier-1 cards leave the game; the coastal deck is tier 2 from now.`);
  }
  if (state.tide === 2) {
    const net = networkHexes(state, linkedNetwork(state));
    const village = Object.values(state.board.hexes).some((h) => h.isKey && h.band === "highland" && net.has(h.key));
    if (village || !m.stack.length) {
      state.tide = 3;
      const n = leave(m.inland, "inland") + leave(m.stack, "inland");
      log(state, `The third tide${village ? ": a highland village is on the network" : ": the coastal deck is spent"}. The highland opens to starting dig cards; ${n} inland tier-1 cards leave the game.`);
      if (village) reward("third");
    }
  }
}

// --------------------------------------------------------------------------- //
// Resources (docs/resources.md): Brass-style cubes on the board, never held.
// A Clay pit, Logging camp or Quarry puts cubes of its hex's resource on the
// hex when built. A building type needs certain resources; each comes from the
// cheapest connected source: an extractor (haul, plus a price to its owner
// unless it is yours) or the import market (haul from the nearest harbour or
// Transport hub, plus the market price, which rises as the market empties).
// Haul is counted in canal edges along linked canals, anyone's. As sim/rules.py.
// --------------------------------------------------------------------------- //

export const RESOURCES = ["clay", "wood", "stone"];

/** The six corners of a hex, named as edgeCorners names them. */
export function hexCorners(hk) {
  const [q, r] = parseKey(hk);
  const at = (j) => { const [dq, dr] = NEIGHBOURS[j % 6]; return hexKey(q + dq, r + dr); };
  return NEIGHBOURS.map((_, i) => cornerName([hk, at(i), at(i + 1)]));
}

/** The owner of the extractor at hk (a building that extracts, on a resource hex), else undefined. */
export function extractorOwner(state, hk) {
  const b = (state.buildings[hk] || [])[0];
  return b && state.board.hexes[hk].material && btype(state, b.type).extracts ? b.p : undefined;
}

/** The owner of a transport hub at hk: an inland port for the import market. */
export function hubOwner(state, hk) {
  const b = (state.buildings[hk] || [])[0];
  return b && btype(state, b.type).port ? b.p : undefined;
}

const marketTrack = (state) => String(state.config.marketTrack).split(",").map(Number).filter((n) => !Number.isNaN(n));

/** The price of the next import cube of resource r: the track rises as the market empties. */
export function marketPrice(state, r) {
  const track = marketTrack(state), left = state.supply?.[r] ?? track.length;
  return left > 0 ? track[track.length - left] : state.config.marketEmptyPrice;
}

/**
 * Canal-edge distances over linked canals (anyone's), as corner -> edges maps:
 * { ports: [{ from, owner, dist }], sources: [{ hex, material, owner, dist }] }.
 * Ports are the harbours (together) then transport hubs; sources are the
 * extractors with cubes left. Both in hexes.csv order.
 */
export function hauls(state, link = linkedNetwork(state), pi = state.current) {
  if (state.config.hauling === "tolls") return tollRoutes(state, link, pi);
  const adj = new Map();
  for (const ek of link.edges) {
    const [c1, c2] = edgeCorners(ek);
    if (!adj.has(c1)) adj.set(c1, []);
    if (!adj.has(c2)) adj.set(c2, []);
    adj.get(c1).push(c2); adj.get(c2).push(c1);
  }
  const walk = (sources) => {
    const dist = new Map(sources.map((c) => [c, 0])), queue = [...sources];
    while (queue.length) {
      const x = queue.shift();
      for (const y of adj.get(x) || []) if (!dist.has(y)) { dist.set(y, dist.get(x) + 1); queue.push(y); }
    }
    return dist;
  };
  const { hexes } = state.board;
  const harbourMap = state.board.harbourMap ?? Object.values(hexes).some((h) => h.harbour);
  const portAt = (c) => c.split("/").some((k) => (harbourMap ? hexes[k]?.harbour : hexes[k]?.shore));
  const ports = [{ from: "harbour", owner: undefined, dist: walk([...adj.keys()].filter(portAt)) }];
  const sources = [];
  for (const hk of Object.keys(hexes)) {
    const seeds = () => hexCorners(hk).filter((c) => adj.has(c));
    if (extractorOwner(state, hk) !== undefined && (state.cubes?.[hk] || 0) > 0) {
      sources.push({ hex: hk, material: hexes[hk].material, owner: extractorOwner(state, hk), dist: walk(seeds()) });
    } else if (hubOwner(state, hk) !== undefined) {
      ports.push({ from: hk, owner: hubOwner(state, hk), dist: walk(seeds()) });
    }
  }
  return { ports, sources };
}

// --------------------------------------------------------------------------- //
// Hauling "tolls" (stage 2, docs/next-version.md section 2): sources never run
// out; each resource comes the cheapest way over linked canals, paying the
// owner of every canal of someone else's, and for stone the bank as well.
// --------------------------------------------------------------------------- //

/** Where each resource comes from: [{ hex, owner, fee }]. Clay: any shore hex, free. */
function tollSources(state, r, pi) {
  const out = [];
  for (const [hk, h] of Object.entries(state.board.hexes)) {
    if (r === "clay") { if (h.shore) out.push({ hex: hk, owner: undefined, fee: 0 }); continue; }
    const o = extractorOwner(state, hk);
    if (o !== undefined && h.material === r) out.push({ hex: hk, owner: o, fee: o === pi ? 0 : state.config.extractionFee });
  }
  return out;
}

/**
 * Cheapest routes for player pi, per resource: a search over corners along
 * linked canals, starting at every source's corners at its fee. A canal of
 * someone else's costs tollPerCanal (tollMode "owner": the route is chosen the
 * same way, then charged once per owner); stone pays stoneBankToll a canal more,
 * on your own canals too. Returns { tolls, pi, best(resource, siteHex) }.
 */
export function tollRoutes(state, link = linkedNetwork(state), pi = state.current) {
  const cfg = state.config;
  const adj = new Map();
  for (const ek of link.edges) {
    const [c1, c2] = edgeCorners(ek);
    (adj.get(c1) || adj.set(c1, []).get(c1)).push([c2, ek]);
    (adj.get(c2) || adj.set(c2, []).get(c2)).push([c1, ek]);
  }
  const cache = {};
  const search = (r) => {
    if (cache[r]) return cache[r];
    const stone = r === "stone" && !(state.tech && hasTech(state, pi, "stoneboats"));
    const w = (ek) => (state.dug[ek] === pi ? 0 : cfg.tollPerCanal) + (stone ? cfg.stoneBankToll : 0);
    const dist = new Map(), prev = new Map(), from = new Map();
    const open = [];
    for (const src of tollSources(state, r, pi)) {
      for (const c of hexCorners(src.hex)) {
        if (dist.has(c) && dist.get(c) <= src.fee) continue;
        dist.set(c, src.fee); from.set(c, src); prev.delete(c); open.push(c);
      }
    }
    // Small graphs and small weights: a simple label-correcting search is enough.
    while (open.length) {
      let i = 0;
      for (let j = 1; j < open.length; j++) if (dist.get(open[j]) < dist.get(open[i])) i = j;
      const c = open.splice(i, 1)[0], d = dist.get(c);
      for (const [n, ek] of adj.get(c) || []) {
        const nd = d + w(ek);
        if (!dist.has(n) || nd < dist.get(n)) { dist.set(n, nd); prev.set(n, [c, ek]); from.set(n, from.get(c)); open.push(n); }
      }
    }
    return (cache[r] = { dist, prev, from });
  };
  const best = (r, hk) => {
    const { dist, prev, from } = search(r);
    let end = null;
    for (const c of hexCorners(hk)) if (dist.has(c) && (end === null || dist.get(c) < dist.get(end))) end = c;
    if (end === null) return null;
    const edges = [];
    for (let c = end; prev.has(c); c = prev.get(c)[0]) edges.push(prev.get(c)[1]);
    const src = from.get(end), stone = r === "stone";
    const owed = {};   // other players -> tolls
    let bank = 0;
    for (const ek of edges) {
      const o = state.dug[ek];
      if (stone) bank += cfg.stoneBankToll;
      if (o !== pi) owed[o] = (owed[o] || 0) + cfg.tollPerCanal;
    }
    if (cfg.tollMode === "owner") for (const o of Object.keys(owed)) owed[o] = cfg.tollPerCanal;
    const tolls = Object.values(owed).reduce((a, x) => a + x, 0);
    return { resource: r, kind: "source", from: src.hex, owner: src.owner, fee: src.fee, edges, owed, bank, tolls, cost: src.fee + tolls + bank };
  };
  return { tolls: true, pi, best };
}

/** Pay for a build's hauls: fees to sources' owners, tolls to canals' owners, the bank; Locks earn from the bank. */
function payTolls(state, p, picks) {
  const pi = state.players.indexOf(p);
  const housed = new Set();   // Toll house (technology): once per build for each owner
  const credit = (o, n, what) => {
    const q = state.players[o]; q.money += n; q.stats.rent = (q.stats.rent || 0) + n; q.stats[what] = (q.stats[what] || 0) + n;
    if (n > 0 && !housed.has(o) && state.tech && hasTech(state, o, "tollhouse")) { housed.add(o); q.money += 1; q.stats.tollhouse = (q.stats.tollhouse || 0) + 1; }
  };
  for (const x of picks) {
    p.stats.hauled[x.resource] = (p.stats.hauled[x.resource] || 0) + 1;
    if (x.fee && x.owner !== undefined && x.owner !== pi) credit(x.owner, x.fee, "fees");
    for (const [o, n] of Object.entries(x.owed || {})) credit(Number(o), n, "tolls");
    // A Lock: every haul through a canal on its borders, its owner's included, pays its owner 1, from the bank.
    const paid = new Set();
    for (const ek of x.edges || []) {
      const e = state.board.edges[ek];
      for (const hk of [e.a, e.b]) {
        for (const b of state.buildings[hk] || []) {
          if (btype(state, b.type).lock && !paid.has(`${hk}|${ek}`)) { paid.add(`${hk}|${ek}`); credit(b.p, 1, "lockIncome"); }
        }
      }
    }
  }
}

/**
 * What a build at hk costs player pi:
 * { total, ok, picks: [{ resource, kind: "source" | "market", from, owner, edges, haul, price, fee }] }.
 * The terrain's build cost and the type's extra, plus for each resource the
 * type needs the cheapest connected cube: haul plus price. A source's price is
 * the extraction fee to its owner (nothing from your own); a market cube's is
 * the market price, plus the fee to a hub's owner if it comes through one. A
 * discount comes off the build and haul, never the prices. Ties go to sources
 * before the market, then hexes.csv order. Pass `haul` (from hauls()) to price
 * many sites at once.
 */
export function buildPrice(state, hk, typeId, pi = state.current, haul = undefined) {
  const h = state.board.hexes[hk];
  const cfg = state.config, bt = btype(state, typeId);
  const base = state.board.terrain[h.terrain].buildCost + bt.extraCost;
  const off = state.turn?.pool?.buildDiscount || 0;
  // Scaffolding (technology): every site 1 less, never below 1.
  const site = (n) => (state.tech && n > 1 && hasTech(state, pi, "scaffolding") ? n - 1 : n);
  if (!cfg.materials || !bt.needs.length) return { total: site(Math.max(0, base - off)), ok: true, picks: [] };
  if (cfg.hauling === "tolls") {
    // A discount comes off the build, never the tolls and fees others are owed.
    const routes = haul?.tolls && haul.pi === pi ? haul : tollRoutes(state, linkedNetwork(state), pi);
    const picks = [];
    for (const r of bt.needs) {
      const best = routes.best(r, hk);
      if (!best) return { total: Infinity, ok: false, picks };
      picks.push(best);
    }
    // Barge (technology): one toll fewer on each build, off the largest owed.
    if (state.tech && hasTech(state, pi, "barge")) {
      const i = picks.findIndex((x) => x.tolls > 0);
      if (i >= 0) {
        const x = picks[i], owed = { ...x.owed };
        const o = Object.keys(owed).reduce((a, b) => (owed[b] > owed[a] ? b : a));
        const less = Math.min(cfg.tollPerCanal, owed[o]);
        owed[o] -= less;
        if (!owed[o]) delete owed[o];
        picks[i] = { ...x, owed, tolls: x.tolls - less, cost: x.cost - less, barge: less };
      }
    }
    return { total: site(Math.max(0, base - off)) + picks.reduce((a, x) => a + x.cost, 0), ok: true, picks };
  }
  const { ports, sources } = haul || hauls(state);
  const corners = hexCorners(hk);
  const near = (dist) => {
    const ds = corners.filter((c) => dist.has(c)).map((c) => dist.get(c));
    return ds.length ? Math.min(...ds) : undefined;
  };
  const picks = [];
  for (const r of bt.needs) {
    let best = null;
    const offer = (o) => { if (!best || o.haul + o.price < best.haul + best.price) best = o; };
    for (const src of sources) {
      if (src.material !== r) continue;
      const d = near(src.dist);
      if (d === undefined) continue;
      const fee = src.owner === pi ? 0 : cfg.extractionFee;
      offer({ resource: r, kind: "source", from: src.hex, owner: src.owner, edges: d, haul: cfg.haulPerEdge * d, price: fee, fee });
    }
    for (const port of ports) {
      const d = near(port.dist);
      if (d === undefined) continue;
      const fee = port.owner === undefined || port.owner === pi ? 0 : cfg.extractionFee;
      offer({ resource: r, kind: "market", from: port.from, owner: port.owner, edges: d, haul: cfg.haulPerEdge * d, price: marketPrice(state, r) + fee, fee });
    }
    if (!best) return { total: Infinity, ok: false, picks };
    picks.push(best);
  }
  const haulSum = picks.reduce((a, x) => a + x.haul, 0), priceSum = picks.reduce((a, x) => a + x.price, 0);
  return { total: Math.max(0, base + haulSum - off) + priceSum, ok: true, picks };
}

export function buildCost(state, hk, typeId) {
  return buildPrice(state, hk, typeId).total;
}

export function canalsAround(state, hk) {
  return Object.keys(state.dug).filter((k) => { const e = state.board.edges[k]; return e.a === hk || e.b === hk; }).length;
}

export function builtCount(state, pi, typeId) {
  return Object.values(state.buildings).flat().filter((b) => b.p === pi && b.type === typeId).length;
}

/** `haul` (from hauls()) prices many sites at once, as buildPrice. */
export function canBuild(state, hk, typeId, haul = undefined, slotId = undefined) {
  const t = state.turn, p = currentPlayer(state), h = state.board.hexes[hk];
  const bt = btype(state, typeId);
  if (!h) return fail("no such hex");
  if (typeId !== undefined && !state.buildingTypes.some((b) => b.id === typeId)) return fail(`no building type ${typeId}`);
  if (t.phase !== "resolve" || (t.pool.build || 0) < 1) return fail("no build available");
  if (!state.board.terrain[h.terrain].buildable || h.slots <= 0) return fail("not a building site");
  const here = state.buildings[hk] || [];
  // Second storey (technology): one more building on a hex where you have one.
  const storey = state.tech && here.length === h.slots && h.slots > 0 && here.some((b) => b.p === state.current)
    && here.filter((b) => b.p === state.current).length < 2 && hasTech(state, state.current, "storey");
  if (here.length >= h.slots && !storey) return fail("no free slot");
  if (inlandClosed(state) && isInland(state, hk)) return fail("inland: closed until the inland milestone");
  if (state.config.buildNeedsNetwork && !networkHexes(state).has(hk)) return fail("must be on the canal network");
  if (bt.site && h.material !== bt.site) return fail(`a ${bt.name} goes only on a ${TERRAIN_WORD[bt.site]}`);
  if (canalsAround(state, hk) < bt.minCanals) return fail(`${bt.name} needs ${bt.minCanals}+ canals around it`);
  if (state.tech) {
    const list = buildSlots(state, state.current, bt.id);
    if (!list.length) return fail(`no ${bt.name} left on your board`);
    if (!pickSlot(state, state.current, bt.id, slotId)) {
      return fail(slotId && !list.some((x) => x.id === slotId) ? `no ${bt.name} in slot ${slotId}`
        : `no ${bt.name} next to an open slot: a leap costs ${state.config.techLeapCost} pearl`);
    }
  } else if (bt.supply && builtCount(state, state.current, bt.id) >= bt.supply) return fail(`no ${bt.name} left in your supply`);
  const price = buildPrice(state, hk, bt.id, state.current, haul);
  if (!price.ok) return fail(`no ${bt.needs.join(" or ")} can reach this site`);
  if (p.money < price.total) return fail("not enough money");
  return OK;
}

export function build(state, hk, typeId, slotId = undefined) {
  const ok = canBuild(state, hk, typeId, undefined, slotId);
  if (!ok.ok) return ok;
  const bt = btype(state, typeId);
  const t = state.turn, p = currentPlayer(state), h = state.board.hexes[hk];
  const slot = state.tech ? pickSlot(state, state.current, bt.id, slotId) : null;
  const price = buildPrice(state, hk, bt.id);
  const cost = price.total;
  t.pool.build--;
  p.money -= cost; p.stats.spent += cost; p.stats.builds++;
  // Hauling "tolls": pay each source's owner, each canal's owner and the bank; a Lock's owner earns from the bank.
  if (state.config.hauling === "tolls") payTolls(state, p, price.picks);
  // Take each cube: off its extractor, or from the import market; pay its price.
  else for (const x of price.picks) {
    p.stats.hauled[x.kind === "market" ? `${x.resource} (import)` : x.resource] = (p.stats.hauled[x.kind === "market" ? `${x.resource} (import)` : x.resource] || 0) + 1;
    if (x.kind === "source") state.cubes[x.from]--;
    else if (state.supply[x.resource] > 0) state.supply[x.resource]--;
    if (x.fee && x.owner !== undefined && x.owner !== state.current) {
      const o = state.players[x.owner];
      o.money += x.fee; o.stats.rent = (o.stats.rent || 0) + x.fee;
    }
  }
  (state.buildings[hk] ||= []).push({ p: state.current, type: bt.id });
  if (state.config.materials && bt.extracts && h.material) state.cubes[hk] = bt.yield;
  p.stats.builtByType[bt.id] = (p.stats.builtByType[bt.id] || 0) + 1;
  const inc = buildIncome(state, bt.id, slot?.id);
  p.income += inc;
  const extras = [`+${inc} income`];
  if (slot) {
    p.taken.push(slot.id);
    const sector = techSlot(state, slot.id).sector;
    if (techLevel(state) >= 3 && (state.capstones ||= {})[sector] === undefined
      && state.tech.slots.filter((x) => x.sector === sector).every((x) => p.taken.includes(x.id))) {
      state.capstones[sector] = state.current;
      extras.push(`the ${CAPSTONES[sector]?.name || sector} capstone`);
    }
    if (techSlot(state, slot.id).tech === "survey" && techLevel(state) >= 2) {
      p.handSize = Math.min(state.config.handSizeCap || Infinity, p.handSize + 1);
      extras.push(`Survey: hand size ${p.handSize}`);
    }
    if (slot.leap) { p.pearls -= state.config.techLeapCost; p.stats.pearlsSpent = (p.stats.pearlsSpent || 0) + state.config.techLeapCost; }
    extras.push(`from slot ${slot.id} (${techSlot(state, slot.id).sector})${slot.leap ? `, a leap for ${state.config.techLeapCost} pearl` : ""}`);
  }
  if (h.isKey && (state.buildings[hk] || []).filter((b) => b.p === state.current).length === 1) { p.keys++; extras.push("key tile: +1 key"); }
  const tok = state.tokens?.[hk];
  if (tok && state.tokenClaimed?.[hk] === undefined) {
    (state.tokenClaimed ||= {})[hk] = state.current;
    const fx = {};
    for (const x of parseEffects(tok.code)) fx[x.kind] = (fx[x.kind] || 0) + x.n;
    applyEffects(state, p, fx);
    extras.push(`${tok.name}: ${tok.code}`);
  }
  if (bt.moneyPerCanal) { const m = bt.moneyPerCanal * canalsAround(state, hk); gain(p, m); extras.push(`+${m} money`); }
  if (bt.handSize) {
    p.handSize = Math.min(state.config.handSizeCap, p.handSize + bt.handSize);
    extras.push(`hand size ${p.handSize}`);
  }
  if (price.picks.length) extras.unshift(price.picks.map((x) => cubeNote(state, x)).join("; "));
  if (state.config.materials && h.material) {
    extras.push(bt.extracts ? `${bt.yield} ${h.material} on the hex` : `the ${TERRAIN_WORD[h.material]} is used up`);
  }
  t.actions.push({ type: "build", hex: hk, building: bt.id, cost, cubes: price.picks.length ? price.picks.map((x) => `${x.resource}:${x.from}`) : undefined });
  log(state, `${p.name} builds ${state.buildingTypes.length > 1 ? `a ${bt.name} ` : ""}on ${hk} for ${cost} (${extras.join(", ")}).`);
  return OK;
}

export const TERRAIN_WORD = { clay: "clay bed", wood: "forest", stone: "mountain" };

/** "wood from 5,3: 2 edges, 1 to Ana" / "clay imported at 2 via the harbour: 3 edges" — logs and tooltips. */
export function cubeNote(state, x) {
  if (Array.isArray(x.edges)) {   // hauling "tolls"
    const parts = [];
    if (x.fee && x.owner !== undefined) parts.push(`${x.fee} to ${state.players[x.owner].name}`);
    for (const [o, n] of Object.entries(x.owed || {})) parts.push(`${n} toll${n === 1 ? "" : "s"} to ${state.players[o].name}`);
    if (x.bank) parts.push(`${x.bank} to the bank`);
    const n = x.edges.length;
    return `${x.resource} from ${x.from}, ${n} canal${n === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ", free"}`;
  }
  const edges = `${x.edges} edge${x.edges === 1 ? "" : "s"}`;
  const who = x.fee && x.owner !== undefined && x.owner !== state.current ? `, ${x.fee} to ${state.players[x.owner].name}` : "";
  if (x.kind === "market") {
    const via = x.from === "harbour" ? "the harbour" : `the hub at ${x.from}`;
    return `${x.resource} imported at ${x.price - (who ? x.fee : 0)} via ${via}: ${edges}${who}`;
  }
  return `${x.resource} from ${x.from}: ${edges}${who}`;
}

/** End-game VP of building `b` at hk. */
export function buildingVP(state, hk, b) {
  const bt = btype(state, b.type);
  const h = state.board.hexes[hk];
  let vp = (bt.vp === "base" ? state.config.vpPerBuilding : bt.vp) + (featureOf(state, hk)?.vpBonus || 0);
  if (bt.vpPerNeighbour) {
    let bonus = 0;
    for (const [dq, dr] of NEIGHBOURS) bonus += bt.vpPerNeighbour * (state.buildings[hexKey(h.q + dq, h.r + dr)] || []).length;
    vp += bt.neighbourCap ? Math.min(bonus, bt.neighbourCap) : bonus;
  }
  return vp;
}

export function buyCost(state, uid) {
  const d = def(state, uid);
  // Guild (technology): tier-2 cards cost you 2 less.
  const guild = state.tech && deckTier(d.deck) > 1 && hasTech(state, state.current, "guild") ? 2 : 0;
  return Math.max(0, d.cost - (state.turn?.pool?.buyDiscount || 0) - guild);
}

/** What putting a bought card on top of the draw pile adds (rule buyOnTopCost), or null if not allowed. */
export function topCost(state) {
  const c = state.config.buyOnTopCost;
  if (c === undefined || c === null || c < 0) return null;
  return state.turn?.pool?.freeTop ? 0 : c;
}

export function canBuy(state, slot, top = false) {
  const t = state.turn, p = currentPlayer(state);
  const uid = marketCards(state)[slot];
  if (!uid) return fail("empty slot");
  if (t.phase !== "resolve" || (t.pool.buy || 0) < 1) return fail("no buy available");
  if (top && topCost(state) === null) return fail("bought cards go to the discard pile");
  if (p.money < buyCost(state, uid) + (top ? topCost(state) : 0)) return fail("not enough money");
  return OK;
}

/** Buy the card in a market slot; `top`: pay topCost more and put it on top of your draw pile. */
export function buy(state, slot, top = false) {
  const ok = canBuy(state, slot, top);
  if (!ok.ok) return ok;
  const t = state.turn, p = currentPlayer(state);
  const m = state.market, uid = marketCards(state)[slot];
  const d = def(state, uid);
  const extra = top ? topCost(state) : 0;
  const cost = buyCost(state, uid) + extra;
  t.pool.buy--;
  p.money -= cost; p.stats.spent += cost; p.stats.buys++;
  if (top) { p.draw.push(uid); p.stats.onTop = (p.stats.onTop || 0) + 1; } else p.discard.push(uid);
  if (slot < m.display.length) { m.display.splice(slot, 1); m.bought.coastal = true; }
  else if (slot < m.display.length + m.inlandDisplay.length) { m.inlandDisplay.splice(slot - m.display.length, 1); m.bought.inland = true; }
  else p.reserved.splice(slot - m.display.length - m.inlandDisplay.length, 1);
  restock(state);
  checkTides(state);
  t.actions.push({ type: "buy", card: d.id, cost, ...(top ? { top: true } : {}) });
  log(state, `${p.name} buys ${displayName(d)} for ${cost}${top ? `, onto their draw pile (+${extra})` : ""}.`);
  return OK;
}

/** source: "hand" | "discard" */
export function canTrash(state, uid, source) {
  const t = state.turn, p = currentPlayer(state);
  if (t.phase !== "resolve") return fail("not resolving");
  const list = source === "hand" ? p.hand : p.discard;
  if (!list.includes(uid)) return fail("card not there");
  const specific = source === "hand" ? "trashHand" : "trashDiscard";
  if ((t.pool[specific] || 0) + (t.pool.trashAny || 0) < 1) return fail("no trash available");
  return OK;
}

export function trash(state, uid, source) {
  const ok = canTrash(state, uid, source);
  if (!ok.ok) return ok;
  const t = state.turn, p = currentPlayer(state);
  const specific = source === "hand" ? "trashHand" : "trashDiscard";
  if (t.pool[specific] > 0) t.pool[specific]--; else t.pool.trashAny--;
  if (source === "hand") p.hand = p.hand.filter((u) => u !== uid);
  else p.discard = p.discard.filter((u) => u !== uid);
  state.trash.push(uid);
  p.stats.trashed++;
  const d = def(state, uid);
  t.actions.push({ type: "trash", card: d.id, source });
  log(state, `${p.name} trashes ${displayName(d)} from ${source}.`);
  return OK;
}

/** Players with an empty hand (everything trashed) may pass. */
// --------------------------------------------------------------------------- //
// Pearls (docs/core-loop.md): a bonus for ending a turn without discarding,
// spent from a small menu on a later turn. As sim/rules.py spend_pearl.
// --------------------------------------------------------------------------- //

export const PEARL_ROLE_POOL = { dig: "dig", build: "build", buy: "buy" };

/** Pearls this menu choice costs. */
export const pearlCost = (state, kind) => (kind === "action" ? state.config.pearlActionCost : kind === "secondwind" ? 3 : 1);

/** Spaces for the next pearl: the base, plus pearls used / divisor, plus a
 * step per pearl held and per card of hand size above the start. As sim/rules.py pearl_need. */
export function pearlNeed(state, p) {
  const c = state.config;
  let need = c.pearlThreshold + c.pearlStoredStep * (p.pearls || 0) + c.pearlHandStep * Math.max(0, p.handSize - c.handSize);
  if (c.pearlUsedDivisor) need += Math.floor((p.stats?.pearlsSpent || 0) / c.pearlUsedDivisor);
  if (state.tech && hasTech(state, state.players.indexOf(p), "diving")) need -= 1;
  return Math.max(1, need);
}

/** One space per card kept; at the threshold a pearl, and the marker resets.
 * With no room for a pearl, the marker waits at the threshold. */
function advancePearlTrack(state, p, kept) {
  if (kept <= 0) return;
  const need = pearlNeed(state, p);
  p.pearlTrack = (p.pearlTrack || 0) + kept;
  if (p.pearlTrack >= need) {
    if ((p.pearls || 0) < pearlCapOf(state, p)) {
      p.pearls = (p.pearls || 0) + 1;
      p.pearlTrack = 0;
      log(state, `${p.name} keeps ${kept} card${kept === 1 ? "" : "s"}: the pearl track fills, a pearl (${p.pearls}).`);
      return;
    }
    p.pearlTrack = need;
  }
  log(state, `${p.name} keeps ${kept} card${kept === 1 ? "" : "s"}: pearl track ${p.pearlTrack}/${need}.`);
}

/**
 * Spend pearls while resolving: "money" (1 pearl: pearlMoney money), "redraw"
 * with a hand card's uid (1 pearl: that card to your discard pile, draw one),
 * or "action" (pearlActionCost pearls: one more of the played card's action).
 */
export function spendPearl(state, kind, uid) {
  const t = state.turn, p = currentPlayer(state), cfg = state.config;
  if (!cfg.pearls) return fail("no pearls in this game");
  if (t.phase !== "resolve") return fail("play a card first");
  const cost = pearlCost(state, kind);
  if ((p.pearls || 0) < cost) return fail(`needs ${cost} pearl${cost === 1 ? "" : "s"}`);
  if (kind === "money") {
    // Lustre (technology): a pearl is worth 3.
    const worth = hasTech(state, state.current, "lustre") ? Math.max(3, cfg.pearlMoney + 1) : cfg.pearlMoney;
    p.money += worth;
    log(state, `${p.name} cashes a pearl for ${worth}.`);
  } else if (kind === "secondwind") {
    if (!hasTech(state, state.current, "secondwind")) return fail("needs the Second wind technology");
    if (t.secondWindUsed) return fail("one second card a turn");
    if (!p.hand.length) return fail("no card left to play");
    t.secondWind = true; t.secondWindUsed = true;
    t.phase = "choose";
    log(state, `${p.name} spends ${cost} pearls for a second card (Second wind).`);
  } else if (kind === "action") {
    const role = def(state, t.played).role, pool = PEARL_ROLE_POOL[role];
    if (!pool) return fail("only a dig, build or buy card can take an extra action");
    t.pool[pool] = (t.pool[pool] || 0) + 1;
    log(state, `${p.name} spends ${cost} pearls for another ${role}.`);
  } else if (kind === "reserve") {
    // Reserve (technology): a display card set aside; only you may buy it. uid: its market slot.
    if (!hasTech(state, state.current, "reserve")) return fail("needs the Reserve technology");
    const m = state.market, slot = Number(uid);
    if (!(slot >= 0 && slot < m.display.length + m.inlandDisplay.length)) return fail("not a display card");
    const card = slot < m.display.length ? m.display.splice(slot, 1)[0] : m.inlandDisplay.splice(slot - m.display.length, 1)[0];
    (p.reserved ||= []).push(card);
    restock(state);
    log(state, `${p.name} spends a pearl to reserve ${displayName(def(state, card))}.`);
  } else if (kind === "redraw") {
    if (!p.hand.includes(uid)) return fail("that card is not in your hand");
    p.hand = p.hand.filter((u) => u !== uid);
    p.discard.push(uid);
    drawTo(state, p, p.hand.length + 1);
    log(state, `${p.name} spends a pearl to redraw a card.`);
  } else return fail(`no pearl choice ${kind}`);
  p.pearls -= cost;
  p.stats.pearlsSpent = (p.stats.pearlsSpent || 0) + cost;
  return OK;
}

/**
 * Forage instead of playing a card: discard one card face down for forageOne
 * money, or the whole hand (uid "hand") for forageHand. The turn ends; no
 * pearl track progress. brainstorm-stage-3.md 6.3
 */
export function canForage(state, uid) {
  const t = state.turn, p = currentPlayer(state), cfg = state.config;
  if (state.over || t?.phase !== "choose") return fail("not choosing a card");
  if (t.secondWind) return fail("play your second card");
  if (uid === "hand") return cfg.forageHand > 0 && p.hand.length ? OK : fail("no foraging with the whole hand");
  if (!(cfg.forageOne > 0)) return fail("no foraging");
  return p.hand.includes(uid) ? OK : fail("card not in hand");
}

export function forage(state, uid) {
  const ok = canForage(state, uid);
  if (!ok.ok) return ok;
  const t = state.turn, p = currentPlayer(state), cfg = state.config;
  const cards = uid === "hand" ? [...p.hand] : [uid];
  const amount = uid === "hand" ? cfg.forageHand : cfg.forageOne;
  p.hand = p.hand.filter((u) => !cards.includes(u));
  p.discard.push(...cards);
  gain(p, amount);
  p.stats.turns++;
  p.stats.forage = (p.stats.forage || 0) + 1;
  t.phase = "resolve";
  t.forage = true;
  t.discards = [];
  t.pool = NEW_POOL();
  t.actions.push({ type: "forage", cards: cards.length, money: amount });
  log(state, uid === "hand"
    ? `${p.name} forages with their whole hand (${cards.length} cards) for ${amount}.`
    : `${p.name} forages: a card face down for ${amount}.`);
  return endTurn(state);
}

export function pass(state) {
  const t = state.turn;
  if (t.phase !== "choose" || currentPlayer(state).hand.length) return fail("can only pass with an empty hand");
  t.phase = "resolve";
  t.pool = NEW_POOL();
  return endTurn(state);
}

export function endTurn(state) {
  const t = state.turn, p = currentPlayer(state);
  if (t.phase !== "resolve") return fail("play a card first");
  // Still in hand (not played, discarded or trashed), plus the card's +nPT.
  const kept = p.hand.length + (t.pool.pearlTrack || 0);
  p.discard.push(...p.play);
  p.play = [];
  drawTo(state, p, p.handSize + (t.pool.extraDraw || 0));
  // Pearls are earned at the end of the turn, so not spendable until the next (docs/core-loop.md).
  if (state.config.pearls) {
    if (t.forage) { /* foraging: no pearl progress */ }
    else if (state.config.pearlEarning === "track") advancePearlTrack(state, p, kept);
    else if (t.played && !t.discards.length && (p.pearls || 0) < pearlCapOf(state, p)) {
      p.pearls = (p.pearls || 0) + 1;
      log(state, `${p.name} kept their cards: a pearl (${p.pearls}).`);
    }
    // A card's +nP: after the track, up to the cap.
    const got = Math.min(t.pool.pearl || 0, Math.max(0, pearlCapOf(state, p) - (p.pearls || 0)));
    if (got > 0) {
      p.pearls = (p.pearls || 0) + got;
      log(state, `${p.name} takes ${got === 1 ? "a pearl" : `${got} pearls`} from ${displayName(def(state, t.played))} (${p.pearls}).`);
    }
  }
  if (!state.quiet) state.history.push({
    round: state.round, player: state.current, card: t.played ? state.cards[t.played] : null,
    discards: t.discards.length, actions: t.actions, unused: Object.fromEntries(
      Object.entries(t.pool).filter(([k, v]) => v > 0 && ["dig", "build", "buy"].includes(k))),
  });
  state.turnNumber++;
  state.current = (state.current + 1) % state.players.length;
  if (state.current === 0) {
    endRound(state);
    if (state.over) {
      state.turn = { phase: "over", pool: {}, actions: [], discards: [] };
      log(state, "Game over.");
      return OK;
    }
    state.round++;
    if (state.config.incomeMode === "round") for (const pl of state.players) gain(pl, pl.income);
  }
  startTurn(state);
  return OK;
}

/** The marketClock rule: "unbought", "always" or "off" (true/false from older setups). */
export const clockMode = (cfg) => (cfg.marketClock === true ? "always" : !cfg.marketClock ? "off" : String(cfg.marketClock));

/** The end of a round: the market clock, then the end triggers. As Game.end_round in sim/rules.py. */
function endRound(state) {
  const cfg = state.config, m = state.market;
  const clock = clockMode(cfg);
  if (clock !== "off") {
    for (const [disp, where] of [[m.display, "coastal"], [m.inlandDisplay, "inland"]]) {
      if (!disp.length || (clock === "unbought" && m.bought[where])) continue;
      const uid = disp.shift();     // the oldest card leaves the game
      m.gone.push(uid);
      log(state, `Market clock: ${displayName(def(state, uid))} leaves the ${where} display.`);
    }
    restock(state);
  }
  m.bought = { coastal: false, inland: false };
  checkTides(state);
  const trigger = (reason, msg) => {
    if (state.endTriggered) return;
    state.endTriggered = true; state.endReason = reason;
    log(state, `${msg} The game ends with this round.`);
  };
  if (cfg.endOnMarket && marketExhausted(state)) trigger("market", "The market decks have run out.");
  if (cfg.endOnKeys && keysConnected(state)) trigger("keys", "Every key tile is on the network.");
  if (state.endTriggered || state.round >= cfg.rounds) {
    state.over = true;
    state.endReason ||= "cap";
  }
}

// --------------------------------------------------------------------------- //
// Crossings (alternative rules): a canal route from open water to a hub.
// --------------------------------------------------------------------------- //

function checkCrossings(state) {
  const done = new Set(state.crossings.map((c) => c.hub));
  // Shortest chain of canals from the sea, walking corner to corner.
  const byCorner = {};
  for (const ek of Object.keys(state.dug)) for (const c of edgeCorners(ek)) (byCorner[c] ||= []).push(ek);
  const prevEdge = {};
  const mouths = new Set(harbourMouths(state));
  const queue = Object.keys(state.dug).filter((ek) => edgeCorners(ek).some((c) => mouths.has(c)));
  queue.forEach((ek) => (prevEdge[ek] = null));
  while (queue.length) {
    const ek = queue.shift();
    for (const c of edgeCorners(ek)) for (const n of byCorner[c] || []) if (prevEdge[n] === undefined) { prevEdge[n] = ek; queue.push(n); }
  }
  // The first edge reached that borders each hex, in BFS order.
  const prev = {};
  for (const ek of Object.keys(prevEdge)) {
    const e = state.board.edges[ek];
    for (const hk of [e.a, e.b]) if (prev[hk] === undefined) prev[hk] = ek;
  }
  for (const hub of state.hubs) {
    if (done.has(hub) || prev[hub] === undefined) continue;
    const edges = [];
    for (let ek = prev[hub]; ek; ek = prevEdge[ek]) edges.push(ek);
    state.crossings.push({ hub, edges, round: state.round });
    log(state, `Crossing completed to ${hub} (${edges.length} segments)!`);
    if (state.config.endOnCrossing && !state.endTriggered) {
      state.endTriggered = true;
      state.endReason = "crossing";
      log(state, "End triggered: the game ends after this round.");
    }
  }
}

// --------------------------------------------------------------------------- //
// Scoring — the four-way cycle (docs/scoring.md). Yellow has no lane.
// --------------------------------------------------------------------------- //

/** A card's weight toward its colour's multiplier, by deck (rule cardWeights); unlisted decks: 1. */
export function cardWeights(state) {
  const w = {};
  for (const part of String(state.config.cardWeights ?? "").split(",")) {
    const [k, v] = part.split("=");
    if (v !== undefined) w[k.trim().toLowerCase()] = Number(v);
  }
  return (d) => w[deckFamily(d.deck)] ?? 1;
}

export function ownedCards(p) { return [...p.draw, ...p.hand, ...p.discard, ...p.play]; }

/** Reach: opened hexes touched by this player's own segments. */
/** Opened hexes bordered by your own navigable (linked) canals. */
export function reach(state, pi, net = networkHexes(state), link = linkedNetwork(state)) {
  const touched = new Set();
  for (const [ek, o] of Object.entries(state.dug)) {
    if (o !== pi || !link.edges.has(ek)) continue;
    const e = state.board.edges[ek];
    touched.add(e.a); touched.add(e.b);
  }
  return [...touched].filter((hk) => isOpened(state, hk, net)).length;
}

/** Reach in points: each opened hex your linked canals touch, at its band's value (hexReach). */
export function reachPoints(state, pi, net = networkHexes(state), link = linkedNetwork(state)) {
  const touched = new Set();
  for (const [ek, o] of Object.entries(state.dug)) {
    if (o !== pi || !link.edges.has(ek)) continue;
    const e = state.board.edges[ek];
    touched.add(e.a); touched.add(e.b);
  }
  let pts = 0;
  for (const hk of touched) if (isOpened(state, hk, net)) pts += hexReach(state, hk);
  return pts;
}

/** The multiplierSteps rule as [[count, multiplier], ...] by count, or null. */
export function multiplierSteps(cfg) {
  const key = String(cfg.multiplierSteps || "");
  if (!key) return null;
  if (STEPS_CACHE.has(key)) return STEPS_CACHE.get(key);
  const steps = key.split(",").map((x) => x.split(":").map(Number)).filter(([a, m]) => Number.isFinite(a) && Number.isFinite(m)).sort((a, b) => a[0] - b[0]);
  STEPS_CACHE.set(key, steps.length ? steps : null);
  return STEPS_CACHE.get(key);
}
const STEPS_CACHE = new Map();

/** A colour's multiplier from its weighted count: by steps, else the count (up to multiplierCap). */
export function multiplier(cfg, count) {
  const steps = multiplierSteps(cfg);
  if (!steps) return cfg.multiplierCap > 0 ? Math.min(cfg.multiplierCap, count) : count;
  let m = steps[0][0] <= count ? steps[0][1] : 0;
  for (const [at, v] of steps) if (count >= at) m = v;
  return m;
}

/**
 * The same, smoothed for an expected (fractional) count: straight lines between
 * the steps, so a bot sees each card bring the next step nearer.
 */
export function smoothMultiplier(cfg, x) {
  const steps = multiplierSteps(cfg);
  if (!steps) return cfg.multiplierCap > 0 ? Math.min(cfg.multiplierCap, x) : x;
  if (x <= steps[0][0]) return steps[0][1];
  for (let i = 1; i < steps.length; i++) {
    const [a0, m0] = steps[i - 1], [a1, m1] = steps[i];
    if (x < a1) return m0 + ((x - a0) / (a1 - a0)) * (m1 - m0);
  }
  return steps[steps.length - 1][1];
}

/** The next step up for a colour: { at, m } (count needed, multiplier then), or null. */
export function nextStep(cfg, count) {
  const steps = multiplierSteps(cfg);
  const n = steps?.find(([at]) => at > count);
  return n ? { at: n[0], m: n[1] } : null;
}

/** Reach from capstones: Navigator (highland and marsh hexes 1 more), Pearl diver (pearls held, up to 4). */
function capReach(state, pi, caps) {
  let n = 0;
  if (caps.includes("Pearls")) n += Math.min(4, state.players[pi].pearls || 0);
  if (caps.includes("Channels")) {
    const link = linkedNetwork(state), net = networkHexes(state, link), touched = new Set();
    for (const [ek, o] of Object.entries(state.dug)) {
      if (o !== pi || !link.edges.has(ek)) continue;
      const e = state.board.edges[ek]; touched.add(e.a); touched.add(e.b);
    }
    for (const hk of touched) {
      const h = state.board.hexes[hk];
      if (isOpened(state, hk, net) && (h.band === "highland" || h.feature === "marsh")) n++;
    }
  }
  return n;
}

export function score(state, pi) {
  const p = state.players[pi];
  const cfg = state.config;
  const counts = Object.fromEntries(Object.keys(ROLES).map((r) => [r, 0]));
  let deckScore = 0;
  const weight = cardWeights(state);
  for (const uid of ownedCards(p)) { const d = def(state, uid); counts[d.role] += weight(d); deckScore += d.vp; }
  const caps = state.capstones ? capstonesOf(state, pi) : [];
  if (caps.includes("Barges")) counts.buy += 2;
  if (caps.includes("Market")) counts.build += 2;
  const m = (r) => multiplier(cfg, counts[r]);

  let buildingScore = caps.includes("Works") ? 4 : 0;
  for (const [hk, list] of Object.entries(state.buildings)) {
    for (const b of list) if (b.p === pi) buildingScore += buildingVP(state, hk, b);
  }
  const network = cfg.networkScore === "crossings"
    ? { score: "Crossings", s: state.crossings.reduce((a, c) => a + c.edges.filter((ek) => state.dug[ek] === pi).length, 0) }
    : { score: "Reach", s: reachPoints(state, pi) + capReach(state, pi, caps) };

  const lanes = [
    { mult: "dig", m: m("dig"), score: "Buildings", s: buildingScore },
    { mult: "build", m: m("build"), score: "Deck VP", s: deckScore },
    { mult: "buy", m: m("buy"), ...network },
    { mult: "special", m: m("special"), score: "Keys", s: p.keys * cfg.vpPerKey },
  ].map((l) => ({ ...l, total: l.m * l.s }));
  // Treasurer: two more cards of the colour that gains most, not Dig.
  if (caps.includes("Stores") && ownedCards(p).filter((u) => def(state, u).role === "earn").length >= 2) {
    let best = null, gainBest = 0;
    for (const l of lanes) {
      if (l.mult === "dig") continue;
      const g = multiplier(cfg, counts[l.mult] + 2) * l.s - l.total;
      if (g > gainBest || !best) { best = l; gainBest = g; }
    }
    counts[best.mult] += 2; best.m = multiplier(cfg, counts[best.mult]); best.total = best.m * best.s; best.treasurer = true;
  }
  return { counts, lanes, total: lanes.reduce((a, l) => a + l.total, 0), money: p.money };
}

export function ranking(state) {
  return state.players
    .map((p, i) => ({ i, name: p.name, ...score(state, i) }))
    .sort((a, b) => b.total - a.total || b.money - a.money);
}

/** Card-definition problems (unrecognised notation etc.), for the setup screen. */
export function defErrors(cardRows) {
  return cardRows.filter((r) => r.id).map(cardDef).filter((d) => d.errors.length)
    .map((d) => `${d.id}: ${d.errors.join("; ")}`);
}

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
  const terrain = {};
  for (const t of terrainRows) {
    if (!t.id) continue;
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
    };
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
      edges[k] = { key: k, a: h.key, b: n.key, cost: Math.max(terrain[h.terrain].digCost, terrain[n.terrain].digCost) };
      for (const c of edgeCorners(k)) if (isMouth(c, hexes, terrain, harbourMap)) mouths.add(c);
    }
  }
  return { terrain, hexes, edges, harbourMap, mouths: [...mouths].sort() };
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
  if (bands.length < 3 || bands.some(Number.isNaN)) return state.config.vpPerReach;
  return bands[{ coast: 0, inland: 1, highland: 2 }[bandOf(state, hk)] ?? 0];
}

/** Does this edge touch the highland? */
export const touchesHighland = (state, ek) => { const e = state.board.edges[ek]; return bandOf(state, e.a) === "highland" || bandOf(state, e.b) === "highland"; };

/** Does this edge start at a harbour mouth, or share a corner with a linked canal? */
export const extendsNetwork = (state, ek, link = linkedNetwork(state)) =>
  edgeCorners(ek).some((c) => link.corners.has(c));

/**
 * Own harbours: one harbour hex per player, spread along the coast in seat
 * order (harbours sorted by q, then r). As Game.harbours in sim/rules.py.
 */
export function assignHarbours(board, players) {
  const hb = Object.values(board.hexes).filter((h) => h.harbour).sort((a, b) => a.q - b.q || a.r - b.r).map((h) => h.key);
  if (!hb.length) return [];
  const k = hb.length;
  return Array.from({ length: players }, (_, i) => (players <= k ? hb[Math.floor(((i + 0.5) * k) / players)] : hb[i % k]));
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
  names.forEach((name, i) => {
    const deck = [];
    for (const [id, n] of Object.entries(startingDeck)) for (let k = 0; k < n; k++) if (defs[id]) deck.push(mint(id));
    const p = {
      name, colour: PLAYER_COLOURS[i % PLAYER_COLOURS.length],
      draw: shuffle(state, deck), hand: [], discard: [], play: [],
      money: cfg.startingPurse, income: cfg.startingIncome, keys: 0, handSize: cfg.handSize, pearls: 0, pearlTrack: 0,
      stats: { turns: 0, boosted: 0, discarded: 0, digs: 0, builds: 0, buys: 0, earns: 0, trashed: 0,
        spent: 0, earned: 0, discoveries: 0, rent: 0, hauled: {}, playedByRole: {}, builtByType: {} },
    };
    state.players.push(p);
    drawTo(state, p, p.handSize);
  });

  // Market (docs/cards.md): a coastal and an inland deck, each tiered
  // (coastal-2 under coastal). The inland cards form their own display when
  // the inland opens (inlandDisplay), or shuffle into the coastal deck.
  const market = cfg.market ||
    Object.fromEntries(Object.values(defs).filter((d) => d.deck !== "starting").map((d) => [d.id, d.copies]));
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
  return state;
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
    supply: state.supply, crossings: state.crossings, players: state.players, market: state.market, trash: state.trash, turn: state.turn });
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
export const marketCards = (state) => [...state.market.display, ...state.market.inlandDisplay];

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

/** Play a card from hand, discarding `discardUids` to boost it. */
export function playCard(state, uid, discardUids = []) {
  const t = state.turn, p = currentPlayer(state);
  if (state.over || t.phase !== "choose") return fail("not choosing a card");
  if (!p.hand.includes(uid)) return fail("card not in hand");
  if (discardUids.includes(uid) || new Set(discardUids).size !== discardUids.length) return fail("bad discards");
  if (!discardUids.every((u) => p.hand.includes(u))) return fail("discard not in hand");
  const d = def(state, uid);
  if (!legalDiscards(d, discardUids.map((u) => def(state, u)))) {
    return fail(`${d.boostCostText || "no boost"}: those discards don't pay it`);
  }

  // As sim/rules.py: the played card goes straight to the discard pile.
  p.hand = p.hand.filter((u) => u !== uid && !discardUids.includes(u));
  p.discard.push(uid, ...discardUids);

  t.phase = "resolve";
  t.played = uid;
  t.digAnywhere = d.digAnywhere || "";
  // Own harbours: a starting card's digs extend only its player's own canals.
  t.ownOnly = state.harbours?.length && d.deck === "starting" ? state.current : -1;
  t.starter = d.deck === "starting";
  t.discards = discardUids;
  t.pool = NEW_POOL();
  const fx = resolveEffects(d, discardUids.length);
  t.effects = fx;
  p.stats.turns++;
  p.stats.playedByRole[d.role] = (p.stats.playedByRole[d.role] || 0) + 1;
  if (discardUids.length) { p.stats.boosted++; p.stats.discarded += discardUids.length; }
  log(state, `${p.name} plays ${displayName(d)}${discardUids.length ? ` discarding ${discardUids.length}` : ""}.`);
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
  return Math.max(0, state.board.edges[ek].cost - (state.turn?.pool?.digDiscount || 0) - camp);
}

export function canDig(state, ek) {
  const t = state.turn, p = currentPlayer(state);
  const e = state.board.edges[ek];
  if (!e) return fail("no such edge");
  if (t.phase !== "resolve" || (t.pool.dig || 0) < 1) return fail("no dig available");
  if (state.dug[ek] !== undefined) return fail("already dug");
  if (inlandClosed(state) && isDeep(state, ek)) return fail("inland on both sides: closed until the inland milestone");
  if (state.config.highlandNeedsBought && t.starter && touchesHighland(state, ek)) return fail("a starting card can't dig in the highland: only bought dig cards reach it");
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
  if (state.config.networkScore === "crossings" || state.config.endOnCrossing) checkCrossings(state);
  return OK;
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
export function hauls(state, link = linkedNetwork(state)) {
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
  if (!cfg.materials || !bt.needs.length) return { total: Math.max(0, base - off), ok: true, picks: [] };
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
export function canBuild(state, hk, typeId, haul = undefined) {
  const t = state.turn, p = currentPlayer(state), h = state.board.hexes[hk];
  const bt = btype(state, typeId);
  if (!h) return fail("no such hex");
  if (typeId !== undefined && !state.buildingTypes.some((b) => b.id === typeId)) return fail(`no building type ${typeId}`);
  if (t.phase !== "resolve" || (t.pool.build || 0) < 1) return fail("no build available");
  if (!state.board.terrain[h.terrain].buildable || h.slots <= 0) return fail("not a building site");
  if ((state.buildings[hk] || []).length >= h.slots) return fail("no free slot");
  if (inlandClosed(state) && isInland(state, hk)) return fail("inland: closed until the inland milestone");
  if (state.config.buildNeedsNetwork && !networkHexes(state).has(hk)) return fail("must be on the canal network");
  if (bt.site && h.material !== bt.site) return fail(`a ${bt.name} goes only on a ${TERRAIN_WORD[bt.site]}`);
  if (canalsAround(state, hk) < bt.minCanals) return fail(`${bt.name} needs ${bt.minCanals}+ canals around it`);
  if (bt.supply && builtCount(state, state.current, bt.id) >= bt.supply) return fail(`no ${bt.name} left in your supply`);
  const price = buildPrice(state, hk, bt.id, state.current, haul);
  if (!price.ok) return fail(`no ${bt.needs.join(" or ")} can reach this site`);
  if (p.money < price.total) return fail("not enough money");
  return OK;
}

export function build(state, hk, typeId) {
  const ok = canBuild(state, hk, typeId);
  if (!ok.ok) return ok;
  const bt = btype(state, typeId);
  const t = state.turn, p = currentPlayer(state), h = state.board.hexes[hk];
  const price = buildPrice(state, hk, bt.id);
  const cost = price.total;
  t.pool.build--;
  p.money -= cost; p.stats.spent += cost; p.stats.builds++;
  // Take each cube: off its extractor, or from the import market; pay its price.
  for (const x of price.picks) {
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
  const inc = state.config.incomePerBuilding + bt.income;
  p.income += inc;
  const extras = [`+${inc} income`];
  if (h.isKey) { p.keys++; extras.push("key tile: +1 key"); }
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
  let vp = bt.vp === "base" ? state.config.vpPerBuilding : bt.vp;
  if (bt.vpPerNeighbour) {
    let bonus = 0;
    for (const [dq, dr] of NEIGHBOURS) bonus += bt.vpPerNeighbour * (state.buildings[hexKey(h.q + dq, h.r + dr)] || []).length;
    vp += bt.neighbourCap ? Math.min(bonus, bt.neighbourCap) : bonus;
  }
  return vp;
}

export function buyCost(state, uid) {
  return Math.max(0, def(state, uid).cost - (state.turn?.pool?.buyDiscount || 0));
}

export function canBuy(state, slot) {
  const t = state.turn, p = currentPlayer(state);
  const uid = marketCards(state)[slot];
  if (!uid) return fail("empty slot");
  if (t.phase !== "resolve" || (t.pool.buy || 0) < 1) return fail("no buy available");
  if (p.money < buyCost(state, uid)) return fail("not enough money");
  return OK;
}

export function buy(state, slot) {
  const ok = canBuy(state, slot);
  if (!ok.ok) return ok;
  const t = state.turn, p = currentPlayer(state);
  const m = state.market, uid = marketCards(state)[slot];
  const d = def(state, uid);
  const cost = buyCost(state, uid);
  t.pool.buy--;
  p.money -= cost; p.stats.spent += cost; p.stats.buys++;
  p.discard.push(uid);
  if (slot < m.display.length) { m.display.splice(slot, 1); m.bought.coastal = true; }
  else { m.inlandDisplay.splice(slot - m.display.length, 1); m.bought.inland = true; }
  restock(state);
  t.actions.push({ type: "buy", card: d.id, cost });
  log(state, `${p.name} buys ${displayName(d)} for ${cost}.`);
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
export const pearlCost = (state, kind) => (kind === "action" ? state.config.pearlActionCost : 1);

/** Spaces for the next pearl: the base, plus pearls used / divisor, plus a
 * step per pearl held and per card of hand size above the start. As sim/rules.py pearl_need. */
export function pearlNeed(state, p) {
  const c = state.config;
  let need = c.pearlThreshold + c.pearlStoredStep * (p.pearls || 0) + c.pearlHandStep * Math.max(0, p.handSize - c.handSize);
  if (c.pearlUsedDivisor) need += Math.floor((p.stats?.pearlsSpent || 0) / c.pearlUsedDivisor);
  return Math.max(1, need);
}

/** One space per card kept; at the threshold a pearl, and the marker resets.
 * With no room for a pearl, the marker waits at the threshold. */
function advancePearlTrack(state, p, kept) {
  if (kept <= 0) return;
  const need = pearlNeed(state, p);
  p.pearlTrack = (p.pearlTrack || 0) + kept;
  if (p.pearlTrack >= need) {
    if ((p.pearls || 0) < state.config.pearlCap) {
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
    p.money += cfg.pearlMoney;
    log(state, `${p.name} cashes a pearl for ${cfg.pearlMoney}.`);
  } else if (kind === "action") {
    const role = def(state, t.played).role, pool = PEARL_ROLE_POOL[role];
    if (!pool) return fail("only a dig, build or buy card can take an extra action");
    t.pool[pool] = (t.pool[pool] || 0) + 1;
    log(state, `${p.name} spends ${cost} pearls for another ${role}.`);
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
    if (state.config.pearlEarning === "track") advancePearlTrack(state, p, kept);
    else if (t.played && !t.discards.length && (p.pearls || 0) < state.config.pearlCap) {
      p.pearls = (p.pearls || 0) + 1;
      log(state, `${p.name} kept their cards: a pearl (${p.pearls}).`);
    }
    // A card's +nP: after the track, up to the cap.
    const got = Math.min(t.pool.pearl || 0, Math.max(0, state.config.pearlCap - (p.pearls || 0)));
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

export function score(state, pi) {
  const p = state.players[pi];
  const cfg = state.config;
  const counts = Object.fromEntries(Object.keys(ROLES).map((r) => [r, 0]));
  let deckScore = 0;
  const weight = cardWeights(state);
  for (const uid of ownedCards(p)) { const d = def(state, uid); counts[d.role] += weight(d); deckScore += d.vp; }
  const m = (r) => (cfg.multiplierCap > 0 ? Math.min(cfg.multiplierCap, counts[r]) : counts[r]);

  let buildingScore = 0;
  for (const [hk, list] of Object.entries(state.buildings)) {
    for (const b of list) if (b.p === pi) buildingScore += buildingVP(state, hk, b);
  }
  const network = cfg.networkScore === "crossings"
    ? { score: "Crossings", s: state.crossings.reduce((a, c) => a + c.edges.filter((ek) => state.dug[ek] === pi).length, 0) }
    : { score: "Reach", s: reachPoints(state, pi) };

  const lanes = [
    { mult: "dig", m: m("dig"), score: "Buildings", s: buildingScore },
    { mult: "build", m: m("build"), score: "Deck VP", s: deckScore },
    { mult: "buy", m: m("buy"), ...network },
    { mult: "special", m: m("special"), score: "Keys", s: p.keys * cfg.vpPerKey },
  ].map((l) => ({ ...l, total: l.m * l.s }));
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

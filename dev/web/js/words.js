// The table's words (docs/state-of-play.md 4 and 5.2): card effects in plain
// English instead of notation, places by name instead of coordinates, and the
// story's vocabulary (springs, friendships, open water, guides, the lodge,
// masteries, currents) over the engine's (key tiles, keys, Reach, Special,
// the technology board, capstones, lanes). Rules and ids are unchanged: this
// is presentation only.
import { parseEffects } from "./notation.js";

// --------------------------------------------------------------------------- //
// Vocabulary
// --------------------------------------------------------------------------- //

export const W = {
  village: "spring village", villages: "spring villages",
  key: "friendship", keys: "friendships", Keys: "Friendships",
  reach: "open water", Reach: "Open water",
  lodge: "lodge", Lodge: "Lodge", craft: "craft", crafts: "crafts",
  mastery: "mastery", masteries: "masteries", Mastery: "Mastery",
  lanes: "currents", lane: "current",
  seasoned: "seasoned",
};

/** Role labels as players read them (ROLES keeps the engine's). */
export const ROLE_WORD = { dig: "Dig", build: "Build", buy: "Buy", earn: "Earn", special: "Guide" };

/** The scoring currents: which colour multiplies what. */
export const CURRENTS = {
  dig: { name: "Building", what: "buildings", desc: "Dig cards × your building score" },
  build: { name: "Deck", what: "card VP", desc: "Build cards × the VP printed on your cards" },
  buy: { name: "Open water", what: "open water", desc: "Buy cards × the hexes your canals opened" },
  special: { name: "Friendship", what: "friendships", desc: "Guide cards × your friendships with spring villages" },
};

/** Riverbank names for the lodge's offices (engine names on the left). */
export const RENAME = {
  "Harbour master": "Pilot", Patron: "Elder", Treasurer: "Hoard-keeper", Guild: "Gathering",
  Navigator: "Wayfinder", Architect: "Builder of halls", "Pearl diver": "Pearl diver",
  Inn: "Holt", inn: "holt",
};
export const rename = (s) => RENAME[s] || s;

// --------------------------------------------------------------------------- //
// Cards in words
// --------------------------------------------------------------------------- //

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n) => (n === 1 ? "" : n === 2 ? " twice" : ` ${n} times`);

/** One effect as a phrase. `lead`: it is the card's main action ("Dig 1" reads "Dig 1 canal"). */
function phrase(e, lead) {
  const n = e.n, each = e.perDiscard ? " for each card discarded" : "";
  switch (e.kind) {
    case "dig": return (lead ? `Dig ${plural(n, "canal")}` : `${plural(n, "more dig")}`) + each;
    case "build": return (lead ? `Build ${n}` : `${plural(n, "more build")}`) + each;
    case "buy": return (lead ? `Buy ${plural(n, "card")}` : `${plural(n, "more buy", "more buys")}`) + each;
    case "earn": return `collect your income${times(n)}` + each;
    case "money": return `+${n} money` + each;
    case "income": return `+${n} income` + each;
    case "keys": return `+${plural(n, "friendship")}` + each;
    case "pearl": return `+${plural(n, "pearl")}` + each;
    case "pearlTrack": return `${plural(n, "step")} on your pearl track` + each;
    case "handSize": return `hand size ${n > 0 ? "+" : ""}${n}, for good` + each;
    case "extraDraw": return `draw ${plural(n, "more card")} at the end of the turn` + each;
    case "digDiscount": return `${n} less to dig` + each;
    case "buildDiscount": return `${n} less to build` + each;
    case "buyDiscount": return `${n} off a card` + each;
    case "trashAny": return `remove ${plural(n, "card")} from your deck` + each;
    case "trashHand": return `remove ${plural(n, "card")} in your hand from your deck` + each;
    case "trashDiscard": return `remove ${plural(n, "card")} in your discard pile from your deck` + each;
    default: return `${e.kind} ${n}`;
  }
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Dig 1 canal" / "Hand size +1, for good" for a card's base line. */
export function baseWords(d) {
  const fx = d.base || parseEffects(d.baseText);
  return fx.map((e, i) => cap(phrase(e, i === 0 && ["dig", "build", "buy"].includes(e.kind)))).join(". ") + (fx.length ? "." : "");
}

/** "Discard 2 cards" / "Discard an Earn card" / "Discard any number", or "" for no boost. */
export function boostCostWords(d) {
  const bc = d.boostCost;
  if (!bc || bc.kind === "none") return "";
  if (bc.kind === "scalar") return "Discard any number";
  if (bc.kind === "colour") return `Discard ${bc.role === "earn" ? "an" : "a"} ${ROLE_WORD[bc.role]} card`;
  return `Discard ${plural(bc.n, "card")}`;
}

export function boostWords(d) {
  const fx = d.boost || parseEffects(d.boostText);
  return fx.map((e) => phrase(e, false)).join(", ");
}

/** A bare effect code in words: "+1P" -> "+1 pearl". */
export function codeWords(code) {
  return parseEffects(code).map((e) => phrase(e, false)).join(", ") || code;
}

export const WHERE_WORDS = {
  coastal: "Digs anywhere on the coast, even away from the water",
  inland: "Digs anywhere inland, even away from the water",
  any: "Digs anywhere, even away from the water",
};

// --------------------------------------------------------------------------- //
// Animals: a silhouette for each card (placeholder art, drawn from the
// system's emoji in a single ink colour so they read as one set).
// --------------------------------------------------------------------------- //

const ANIMAL = {
  "Hermit Crab": "🦀", Seal: "🦭", Crayfish: "🦞", Otter: "🦦", "Water Vole": "🐀", Oyster: "🦪",
  Rabbit: "🐇", Earthworm: "🪱", Swallow: "🐦", "Mason Bee": "🐝", Jackdaw: "🐦", Magpie: "🐦",
  "Harvest Mouse": "🐁", Dormouse: "🐭", Honeybee: "🐝", Kestrel: "🦅", Jay: "🐦",
  Mole: "🐀", Badger: "🦡", Boar: "🐗", Beaver: "🦫", Termite: "🐜", Raven: "🐦", Squirrel: "🐿",
  Hamster: "🐹", Owl: "🦉", Fox: "🦊", Stag: "🦌",
  Cormorant: "🦆", Lobster: "🦞", Kingfisher: "🐦", Wren: "🐦", Pelican: "🦢", Heron: "🦩",
  Puffin: "🐧", Gannet: "🕊", Dipper: "🐦",
  Marmot: "🦫", "Mole Cricket": "🦗", "Wood Ant": "🐜", Weaver: "🐦", Rook: "🐦", Chipmunk: "🐿",
  Hedgehog: "🦔", "Golden Eagle": "🦅", Elk: "🦌", Lynx: "🐈",
};
export const animalGlyph = (name) => ANIMAL[name] || null;

// --------------------------------------------------------------------------- //
// Places
// --------------------------------------------------------------------------- //

const HARBOUR_NAMES = ["Gull Cove", "Kelp Haven", "Seal Point", "Heron Bay", "Crab Strand", "Tern Harbour", "Otter Reach"];

/** The board's x extent, cached per board. */
const extent = new WeakMap();
function xOf(q, r) { return q + r / 2; }   // axial, pointy-top (board.js)
function span(board) {
  let e = extent.get(board);
  if (!e) {
    const xs = Object.values(board.hexes).filter((h) => !board.terrain[h.terrain]?.water).map((h) => xOf(h.q, h.r));
    e = { min: Math.min(...xs), max: Math.max(...xs) };
    extent.set(board, e);
  }
  return e;
}

/** Harbours by name, west to east. */
export function harbourName(state, hk) {
  const hs = Object.values(state.board.hexes).filter((h) => h.harbour).sort((a, b) => xOf(a.q, a.r) - xOf(b.q, b.r) || a.r - b.r);
  const i = hs.findIndex((h) => h.key === hk);
  return i < 0 ? hk : HARBOUR_NAMES[i % HARBOUR_NAMES.length];
}

const BAND = { coast: "coast", inland: "meadows", highland: "highland" };

/** "the forest in the western meadows" */
export function placeName(state, hk) {
  const h = state.board.hexes[hk];
  if (!h) return hk;
  const t = state.board.terrain[h.terrain] || {};
  if (h.harbour) return harbourName(state, hk);
  if (t.water) return h.terrain === "lake" ? "the lake" : "the sea";
  const { min, max } = span(state.board);
  const f = (xOf(h.q, h.r) - min) / Math.max(1, max - min);
  const side = f < 0.34 ? "western" : f > 0.66 ? "eastern" : "middle";
  const band = BAND[h.band || t.band] || "land";
  const what = h.isKey ? "the spring village" : h.feature === "marsh" ? "the marsh" : h.feature === "hills" ? "the hills"
    : h.material === "wood" ? "the forest" : h.material === "stone" ? "the stony hills" : h.terrain === "crag" ? "the crags" : null;
  const where = `the ${side} ${band}`;
  return what ? `${what} in ${where}` : where;
}

/** A border "a|b" by its land side. */
export function borderName(state, ek) {
  const [a, b] = ek.split("|");
  const land = [a, b].filter((k) => !state.board.terrain[state.board.hexes[k]?.terrain]?.water);
  return land.length ? placeName(state, land[0]) : placeName(state, a);
}

// --------------------------------------------------------------------------- //
// The log in the table's words
// --------------------------------------------------------------------------- //

/** Rewrite an engine log line: places by name, the story's vocabulary, no slot ids. */
export function themeLog(state, msg) {
  let s = String(msg);
  s = s.replace(/digs the (-?\d+,-?\d+)\|(-?\d+,-?\d+) border/g, (_, a, b) => `digs a canal by ${borderName(state, `${a}|${b}`)}`);
  s = s.replace(/(-?\d+,-?\d+)\|(-?\d+,-?\d+)/g, (_, a, b) => borderName(state, `${a}|${b}`));
  s = s.replace(/\b(on|at) (-?\d+,-?\d+)\b/g, (_, w, k) => `${state.board.hexes[k] ? "in" : w} ${state.board.hexes[k] ? placeName(state, k) : k}`);
  s = s.replace(/\bthe harbour (-?\d+,-?\d+)\b/g, (_, k) => harbourName(state, k));
  s = s.replace(/\b(-?\d+,-?\d+)\b/g, (m) => (state.board.hexes[m] ? placeName(state, m) : m));
  s = s.replace(/, from slot [A-Z]\d \([^)]*\)/g, "");
  s = s.replace(/key tiles?/g, (m) => (m.endsWith("s") ? "spring villages" : "spring village"))
    .replace(/\+(\d+) keys?\b/g, (_, n) => `+${n} friendship${n === "1" ? "" : "s"}`)
    .replace(/\bcapstones?\b/g, (m) => (m.endsWith("s") ? "masteries" : "mastery"))
    .replace(/\bReach\b/g, "open water")
    .replace(/\b(Harbour master|Patron|Treasurer|Guild|Navigator|Architect)\b/g, (m) => RENAME[m])
    .replace(/\bInn\b/g, "Holt")
    .replace(/tier-1/g, "first").replace(/tier 2/g, "seasoned");
  return s;
}

// Turns card text ("Dig 1. -1DC", boost "D" + "-1BC/D") into structured effects.
// Codes follow cards/notation.csv. Anything unrecognised is reported, not guessed.

export const ROLES = {
  dig: { colour: "brown", glyph: "▼", label: "Dig" },
  build: { colour: "green", glyph: "■", label: "Build" },
  buy: { colour: "blue", glyph: "●", label: "Buy" },
  earn: { colour: "yellow", glyph: "◆", label: "Earn" },
  special: { colour: "purple", glyph: "★", label: "Special" },
};

// "Earn 1" means "collect income once" (docs/economy.md), the same grammar as "Dig 1".
const ACTION_WORDS = { dig: "dig", build: "build", buy: "buy", earn: "earn" };
const ROLE_LETTER = { D: "dig", B: "build", C: "buy", E: "earn", S: "special" };

// code suffix -> effect kind
const PLUS = { M: "money", I: "income", H: "extraDraw", S: "handSize", C: "buy", D: "dig", B: "build", K: "keys", E: "earn" };
const MINUS = { CC: "buyDiscount", DC: "digDiscount", BC: "buildDiscount" };
const TRASH = { T: "trashAny", TH: "trashHand", TD: "trashDiscard" };

function tokens(text) {
  return (text || "")
    .split(/\s+/)
    .map((t) => t.replace(/^[([]+/, "").replace(/[.,:;)\]]+$/, ""))
    .filter(Boolean);
}

/** Parse an effect string into [{kind, n, perDiscard}], collecting errors. */
export function parseEffects(text, errors = []) {
  const out = [];
  const toks = tokens(text);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const word = ACTION_WORDS[t.toLowerCase()];
    if (word && /^\d+$/.test(toks[i + 1] || "")) {
      out.push({ kind: word, n: Number(toks[++i]), perDiscard: false });
      continue;
    }
    let m = t.match(/^([+-])(\d+)([A-Z]+)(\/D)?$/);
    if (m) {
      const kind = (m[1] === "+" ? PLUS : MINUS)[m[3]];
      if (kind) { out.push({ kind, n: Number(m[2]), perDiscard: !!m[4] }); continue; }
    }
    m = t.match(/^(\d+)(T|TH|TD)(\/D)?$/);
    if (m) { out.push({ kind: TRASH[m[2]], n: Number(m[1]), perDiscard: !!m[3] }); continue; }
    errors.push(`unrecognised '${t}' in "${text}"`);
  }
  return out;
}

/**
 * Boost cost: "" = no boost, "D2" = discard exactly 2, "D" = scalar (any number),
 * "XD" = discard one card of that colour (XD dig, XB build, XC buy, XE earn, XS special).
 */
export function parseBoostCost(text, errors = []) {
  const t = (text || "").trim();
  if (!t) return { kind: "none", n: 0 };
  if (t === "D") return { kind: "scalar", n: 0 };
  const m = t.match(/^D(\d+)$/);
  if (m) return { kind: "threshold", n: Number(m[1]) };
  const x = t.match(/^X([DBCES])$/);
  if (x) return { kind: "colour", n: 1, role: ROLE_LETTER[x[1]] };
  errors.push(`unrecognised boost cost '${t}'`);
  return { kind: "none", n: 0 };
}

/** Build a card definition from a CSV row. */
export function cardDef(row) {
  const errors = [];
  const role = (row.role || "").toLowerCase();
  if (!ROLES[role]) errors.push(`unknown role '${row.role}'`);
  const def = {
    id: row.id,
    deck: (row.deck || "").toLowerCase(),
    name: row.name || "",
    role: ROLES[role] ? role : "special",
    baseText: row.base || "",
    boostCostText: row.boost_cost || "",
    boostText: row.boost || "",
    cost: Number(row.cost) || 0,
    vp: Number(row.vp) || 0,
    copies: row.copies === "" || row.copies == null ? 1 : Number(row.copies) || 0,
    flavour: row.flavour || "",
    // Land animals may dig away from the sea-linked network: "coastal",
    // "inland" or "any". Blank: the card only extends the network.
    digAnywhere: (row.dig_anywhere || "").trim().toLowerCase(),
  };
  if (!["", "coastal", "inland", "any"].includes(def.digAnywhere)) {
    errors.push(`dig_anywhere '${row.dig_anywhere}' must be coastal, inland, any or blank`);
  }
  def.base = parseEffects(def.baseText, errors);
  def.boostCost = parseBoostCost(def.boostCostText, errors);
  def.boost = parseEffects(def.boostText, errors);
  def.errors = errors;
  return def;
}

/** How many times the boost fires for a given number of discards (0 = inactive). */
export function boostMultiplier(def, discards) {
  const bc = def.boostCost;
  if (bc.kind === "threshold" || bc.kind === "colour") return discards === bc.n ? 1 : 0;
  if (bc.kind === "scalar") return discards;
  return 0;
}

/** Whether these discards (card defs) legally pay the card's boost. */
export function legalDiscards(def, discardDefs) {
  const n = discardDefs.length;
  if (n === 0) return true;
  const bc = def.boostCost;
  if (bc.kind === "threshold") return n === bc.n;
  if (bc.kind === "colour") return n === 1 && discardDefs[0].role === bc.role;
  return bc.kind === "scalar";
}

/** Count-only check, for callers that don't know which cards (colour boosts need one card). */
export function legalDiscardCount(def, discards) {
  if (discards === 0) return true;
  const bc = def.boostCost;
  if (bc.kind === "threshold" || bc.kind === "colour") return discards === bc.n;
  return bc.kind === "scalar";
}

/** Total effects of playing a card with `discards` cards discarded. */
export function resolveEffects(def, discards) {
  const total = {};
  const add = (k, n) => { total[k] = (total[k] || 0) + n; };
  // As sim/rules.py: a /D code scales by discards wherever it appears.
  for (const e of def.base) add(e.kind, e.perDiscard ? e.n * discards : e.n);
  const mult = boostMultiplier(def, discards);
  if (mult > 0) {
    for (const e of def.boost) {
      // A threshold boost fires once. A scalar boost multiplies its /D codes;
      // codes without /D on a scalar boost fire once if anything was discarded.
      add(e.kind, e.perDiscard ? e.n * discards : e.n);
    }
  }
  return total;
}

export function displayName(def) {
  return def.name || ROLES[def.role].label;
}

// UI: setup screen (rules + deck composition), hot-seat game with optional
// computer opponents, end-of-game report.
import { parseCSV } from "./csv.js";
import * as E from "./engine.js";
import { cardDef, ROLES, displayName, legalDiscardCount, resolveEffects } from "./notation.js";
import { renderBoard, renderTechBoard } from "./board.js";
import { AGENTS, makeRng, setLanePrior, LANE_ROLES } from "./agents.js";
import { installSprites, icon, crest, ROLE_ICON, hasSymbol } from "./sprites.js";
import { showRules } from "./rules.js";
import { applyCommand } from "./commands.js";
import { W, ROLE_WORD, CURRENTS, rename, baseWords, boostCostWords, boostWords, WHERE_WORDS, animalGlyph, harbourName, placeName, themeLog } from "./words.js";
import { hostTable, joinTable, makeCode, cleanCode, shareLink } from "./net.js";
import { submitReport, flushReports, sharing, setSharing, reportingAvailable, siteVersion, siteInfo, reportStatus } from "./reports.js";

const $ = (sel) => document.querySelector(sel);
const app = $("#app");

// Resolved against this module rather than the page, so the table works
// wherever its page is served from (web/index.html locally, or a page at the
// root of a published copy), as long as the repo layout below it is kept.
const repo = (path) => new URL(`../../${path}`, import.meta.url).href;
const SOURCES = {
  cards: [repo("cards/cards.csv")],
  hexes: [repo("board/hexes.csv")],
  terrain: [repo("board/terrain.csv")],
  buildings: [repo("board/buildings.csv")],
  tech: [repo("board/tech.csv")],
  // Alternatives (docs/alternatives.md), loaded but only used when chosen in setup.
  altHexes: [repo("board/alternatives/hexes-12x11-hubs.csv")],
  classicHexes: [repo("board/alternatives/hexes-classic-9x6.csv")],
  stage1Hexes: [repo("board/alternatives/hexes-stage1.csv")],
  altMarket: [repo("cards/alternatives/market-sample.csv")],
  notation: [repo("cards/notation.csv")],
};

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

// Finished games are kept in this browser, newest first, so their reports and
// logs can be reopened from the setup screen.
const FINISHED = "canals.finished";
const KEEP_FINISHED = 20;

function finishedGames() { const l = store.get(FINISHED); return Array.isArray(l) ? l : []; }

/** Save `list`, dropping the oldest games if the browser runs out of room. */
function saveFinished(list) {
  for (let l = list.slice(0, KEEP_FINISHED); ; l = l.slice(0, -1)) {
    try { localStorage.setItem(FINISHED, JSON.stringify(l)); return l.length; } catch { if (!l.length) return 0; }
  }
}

function keepFinished(g) {
  if (!g.finishedAt) g.finishedAt = Date.now();
  const list = finishedGames().filter((x) => x.finishedAt !== g.finishedAt);
  return saveFinished([{ finishedAt: g.finishedAt, state: g }, ...list]) > 0;
}

let data = null;          // { cards, hexes, terrain, notation } as CSV rows
let notation = {};        // code -> meaning
let setup = null;         // setup-screen config
let state = null;         // engine state
let undo = [];            // JSON snapshots within the current turn
let sel = { play: null, discards: new Set() };
let buildType = null;     // building type chosen in the picker
let buyTop = false;       // put the next bought card on top of the draw pile (rule buyOnTopCost)
let redrawing = false;    // a pearl redraw is waiting for a hand card
let aiTimer = null;       // pending computer turn
let aiFailed = null;      // why the last computer turn could not be played, if it couldn't

// Who sits in each seat. The computer players are the JS agents in agents.js,
// the same ones web/test/sim.mjs uses; they play the rules exactly as you do.
const SEATS = {
  human: "Human, this device",
  remote: "Online player",
  greedy: "Computer (greedy)",
  random: "Computer (random)",
};
const SEAT_HINT = "An online player joins from their own device with the table's invite link. Greedy looks one turn ahead and steers its digs toward Reach, discoveries and building sites. Random plays any legal move: a floor, not an opponent.";
// Delay before each computer turn, so you can watch the board change.
const PACES = { fast: ["Fast", 150], normal: ["Normal", 800], slow: ["Slow", 1800] };

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}

/** Offer `text` as a file, and always show it with a Copy button as well:
 * some hosts (an embedded or sandboxed page) block downloads silently. */
function download(name, text, type = "application/json") {
  try {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
  } catch { /* downloads unavailable: the panel below still works */ }
  showExport(name, text);
}

function showExport(name, text) {
  document.querySelector(".export")?.remove();
  const area = h("textarea", { id: "export-text", readonly: true, rows: 10, spellcheck: "false" });
  area.value = text;
  const status = h("span", { class: "muted", role: "status" });
  const copy = h("button", { class: "primary", onclick: async () => {
    try { await navigator.clipboard.writeText(text); status.textContent = "Copied."; }
    catch { area.focus(); area.select(); status.textContent = "Selected. Press Ctrl+C (Cmd+C on a Mac) to copy."; }
  } }, "Copy");
  const panel = h("div", { class: "export", role: "dialog", "aria-label": name },
    h("div", { class: "export-box" },
      h("h2", {}, name),
      h("p", { class: "muted" }, "If no file was saved, copy this text and save it as ", h("code", {}, name), ". Load it back with the matching Load button."),
      area,
      h("div", { class: "row" }, copy, h("button", { class: "ghost", onclick: () => panel.remove() }, "Close"), status)));
  document.body.append(panel);
  copy.focus();
}

/** A button that needs a second click within 4 seconds, in place of confirm(),
 * which some hosts never show. */
function confirmButton(label, ask, act) {
  let armed = null;
  const b = h("button", { class: "ghost", onclick: () => {
    if (armed) { clearTimeout(armed); act(); return; }
    b.textContent = ask; b.classList.add("armed");
    armed = setTimeout(() => { armed = null; b.textContent = label; b.classList.remove("armed"); }, 4000);
  } }, label);
  return b;
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const i = h("input", { type: "file", accept });
    i.addEventListener("change", () => i.files[0] ? i.files[0].text().then(resolve) : resolve(null));
    i.click();
  });
}

// --------------------------------------------------------------------------- //
// Loading
// --------------------------------------------------------------------------- //

async function loadRepoData() {
  const out = {};
  for (const [k, urls] of Object.entries(SOURCES)) {
    out[k] = [];
    for (const u of urls) {
      const res = await fetch(u).catch(() => null);
      if (k.startsWith("alt") && !res?.ok) continue; // alternatives are optional
      if (!res?.ok) throw new Error(`${u}: ${res ? `HTTP ${res.status}` : "unreachable"}`);
      out[k].push(...parseCSV(await res.text()));
    }
  }
  return out;
}

function setData(d) {
  data = d;
  notation = Object.fromEntries((d.notation || []).map((r) => [r.code, r.meaning]));
  setup = defaultSetup(store.get("canals.setup"));
}

// Bumped when a default changes, so a setup saved in this browser earlier
// picks up the new value instead of silently keeping the old one.
const SETUP_VERSION = 13;
// The connection rule became settled (2); building types became the working rule (3);
// the inland milestone replaced the first-opened-hex unlock (4); the game ends by
// trigger, with rounds a cap, and the pearl track came in (6).
const RESET_AT = { 2: ["connectionRequired"], 3: ["buildingTypes"], 4: ["inlandMilestone"], 5: ["milestoneReward"],
  6: ["rounds", "pearlEarning", "pearlCap", "vpPerReach"], 7: ["marketClock"], 8: ["ownHarbours"] };

const END_REASON = { market: "the market ran dry", keys: "the waters reached the high springs",
  crossing: "ended by the first crossing", cap: "reached the round cap" };

const SETUP_EXTRAS = { players: ["You", "Greedy AI"], seats: ["human", "greedy"], aiPace: "normal", map: "settled" };

/** One seat per player name. Setups saved before seats existed were all hot-seat. */
function fixSeats(cfg) {
  cfg.seats = cfg.players.map((_, i) => (SEATS[cfg.seats?.[i]] ? cfg.seats[i] : "human"));
  if (!PACES[cfg.aiPace]) cfg.aiPace = "normal";
  return cfg;
}

function defaultSetup(saved) {
  const cfg = { ...E.DEFAULTS, ...structuredClone(SETUP_EXTRAS), startingDeck: {}, market: {} };
  for (const row of data.cards) {
    if (!row.id) continue;
    const d = cardDef(row);
    if (d.deck === "starting") cfg.startingDeck[d.id] = 1;
    else cfg.market[d.id] = d.copies;
  }
  cfg.setupVersion = SETUP_VERSION;
  if (!saved) return fixSeats(cfg);
  // Keep saved choices that still mean something: known rule fields, and cards that still exist.
  const merged = { ...cfg };
  for (const key of Object.keys(cfg)) if (key in saved && !["startingDeck", "market"].includes(key)) merged[key] = saved[key];
  merged.startingDeck = { ...cfg.startingDeck };
  merged.market = { ...cfg.market };
  for (const id of Object.keys(saved.startingDeck || {})) if (id in cfg.startingDeck || id in cfg.market) merged.startingDeck[id] = saved.startingDeck[id];
  for (const id of Object.keys(saved.market || {})) if (id in cfg.startingDeck || id in cfg.market) merged.market[id] = saved.market[id];
  if (!("seats" in saved)) merged.seats = [];
  for (let v = (saved.setupVersion || 1) + 1; v <= SETUP_VERSION; v++) for (const k of RESET_AT[v] || []) merged[k] = cfg[k];
  merged.setupVersion = SETUP_VERSION;
  return fixSeats(merged);
}

// --------------------------------------------------------------------------- //
// Rules
// --------------------------------------------------------------------------- //

/** Open "How to play" for the game in progress, or for the setup being edited. */
function openRules() {
  let game = state && app.querySelector(".game") ? state : null;
  // A guest waiting in the lobby reads the host's settings, not their own.
  const cfg = net.role === "guest" && net.lobby?.setup ? net.lobby.setup : setup;
  try { game ||= E.createGame(gameData(cfg), structuredClone(cfg)); } catch { /* fall back below */ }
  if (!game) { toast("Can't show the rules for this setup"); return; }
  const counts = {};
  for (const [id, n] of Object.entries(game.config.startingDeck || setup?.startingDeck || {})) {
    const row = data.cards.find((r) => r.id === id);
    if (row && n) { const d = cardDef(row); counts[d.role] = (counts[d.role] || 0) + n; }
  }
  showRules(game, {
    startingDeck: ["dig", "build", "buy", "earn", "special"].map((r) => [r, counts[r] || 0]),
    notation: data.notation || [],
    closeLabel: app.querySelector(".game") ? "Back to the game" : "Close",
  });
  if (!location.hash.startsWith("#join=") && location.hash !== "#rules") history.replaceState(null, "", "#rules");
}
const rulesButton = (label = "How to play") => h("button", { class: "ghost rules-btn", onclick: openRules }, icon("i-reach"), " ", label);
const brand = (text) => h("h1", { class: "brand" }, icon("i-reach"), text);

// --------------------------------------------------------------------------- //
// Cards
// --------------------------------------------------------------------------- //

function chips(text) {
  return (text || "").split(/(\s+)/).map((tok) => {
    const core = tok.replace(/[.,:;]+$/, "");
    if (notation[core]) return h("span", { class: "chip", title: notation[core] }, core, tok.slice(core.length));
    return tok;
  });
}

/** Show the notation codes on cards (a preference kept in this browser). */
let showCodes = !!store.get("canals.codes");

function cardView(d, opts = {}) {
  const r = ROLES[d.role];
  const glyph = animalGlyph(d.name);
  const boostCost = boostCostWords(d);
  const tip = [d.flavour, showCodes ? null : `${d.baseText}${d.boostCostText ? ` · ${d.boostCostText}: ${d.boostText}` : ""}`].filter(Boolean).join("\n");
  return h("div", {
    class: `card c-${r.colour}${opts.cls ? " " + opts.cls : ""}`, "data-key": opts.key || null,
    title: tip || null, onclick: opts.onclick || null,
  },
    h("div", { class: "card-band" }, icon(ROLE_ICON[d.role] || "i-special"), h("span", { class: "card-name" }, displayName(d)),
      d.cost ? h("span", { class: "card-cost", title: `costs ${d.cost}` }, icon("i-coin"), h("b", {}, d.cost)) : null),
    h("div", { class: "card-art", "aria-hidden": "true" },
      glyph ? h("span", { class: "animal" }, glyph) : icon(ROLE_ICON[d.role] || "i-special"),
      h("span", { class: "card-role" }, ROLE_WORD[d.role])),
    h("div", { class: "card-body" },
      showCodes ? h("div", { class: "card-base" }, chips(d.baseText)) : h("div", { class: "card-base" }, baseWords(d)),
      d.digAnywhere ? h("div", { class: "card-where", title: "A land animal: may also dig away from the sea-linked network on this ground. Such a canal stays cut off until someone links it to the sea." },
        WHERE_WORDS[d.digAnywhere]) : null,
      d.boostCostText ? h("div", { class: "card-boost" }, showCodes
        ? [chips(d.boostCostText), ": ", chips(d.boostText)]
        : [h("span", { class: "boost-cost" }, boostCost), " → ", boostWords(d)]) : null,
      d.flavour && !opts.compact ? h("div", { class: "card-flavour" }, d.flavour) : null),
    h("div", { class: "card-foot" }, h("span", {}, showCodes ? d.id : deckWord(d.deck)), d.vp ? h("span", { class: "vp", title: `${d.vp} VP: the Deck current counts it` }, icon("i-vp"), d.vp) : null),
    opts.badge ? h("span", { class: "badge" }, opts.badge) : null);
}

const deckWord = (deck) => ({ starting: "your own", coastal: "coast", "coastal-2": "coast · seasoned", inland: "meadows", "inland-2": "meadows · seasoned" }[deck] || deck);

// --------------------------------------------------------------------------- //
// Setup screen
// --------------------------------------------------------------------------- //

function num(label, key, attrs = {}, obj = setup) {
  return h("label", { class: "field" }, h("span", {}, label),
    h("input", { type: "number", value: obj[key], ...attrs, onchange: (e) => { obj[key] = Number(e.target.value); saveSetup(); } }));
}
/** A checkbox for a boolean setup field; `invert` ticks it when the field is false. */
function check(label, key, hint, invert = false) {
  return h("label", { class: "field check", title: hint || null },
    h("input", { type: "checkbox", checked: !!setup[key] !== invert, onchange: (e) => { setup[key] = e.target.checked !== invert; saveSetup(); } }),
    h("span", {}, label));
}
function select(label, key, options) {
  return h("label", { class: "field" }, h("span", {}, label),
    h("select", { onchange: (e) => { setup[key] = e.target.value; saveSetup(); } },
      options.map(([v, l]) => h("option", { value: v, selected: setup[key] === v }, l))));
}
let refreshPreview = null;  // redraws the setup screen's map preview
function saveSetup() { store.set("canals.setup", setup); refreshPreview?.(); }

function renderSetup() {
  stopAi();
  if (net.role === "guest") leaveTable(false);
  if (net.role === "host") net.started = false;
  document.title = "Canals";
  const errors = E.defErrors(data.cards);
  let saved = store.get("canals.game");
  if (saved && saved.version !== E.STATE_VERSION) { store.del("canals.game"); saved = null; }
  const defs = data.cards.filter((r) => r.id).map(cardDef);
  const groups = {};
  for (const d of defs) (groups[d.deck || "other"] ||= []).push(d);

  const deckRow = (d) => h("tr", { class: d.errors.length ? "bad" : "" },
    h("td", {}, h("span", { class: `dot c-${ROLES[d.role].colour}` }, icon(ROLE_ICON[d.role])), " ", displayName(d)),
    h("td", { class: "mono" }, d.id),
    h("td", {}, chips(d.baseText), d.boostCostText ? [" · ", chips(d.boostCostText), ": ", chips(d.boostText)] : null),
    h("td", { class: "n" }, d.cost || ""), h("td", { class: "n" }, d.vp || ""),
    h("td", {}, h("input", { type: "number", min: 0, class: "small", value: setup.startingDeck[d.id] || 0,
      onchange: (e) => { setup.startingDeck[d.id] = Number(e.target.value); saveSetup(); renderSummary(); } })),
    h("td", {}, h("input", { type: "number", min: 0, class: "small", value: setup.market[d.id] || 0,
      onchange: (e) => { setup.market[d.id] = Number(e.target.value); saveSetup(); renderSummary(); } })));

  const summary = h("div", { class: "summary" });
  function renderSummary() {
    const tally = (map) => {
      const c = {}; let n = 0;
      for (const [id, k] of Object.entries(map)) { const d = defs.find((x) => x.id === id); if (!d || !k) continue; c[d.role] = (c[d.role] || 0) + k; n += k; }
      return [h("b", {}, n), " cards: ", Object.entries(c).map(([r, k]) => h("span", { class: `pill c-${ROLES[r].colour}` }, icon(ROLE_ICON[r]), ` ${k}`))];
    };
    summary.replaceChildren(h("div", {}, "Starting deck (per player): ", tally(setup.startingDeck)),
      h("div", {}, "Market: ", tally(setup.market)));
  }
  renderSummary();

  const seatsEl = h("div", {}, playersBlock());
  refreshSeats = () => seatsEl.replaceChildren(playersBlock());

  app.replaceChildren(h("div", { class: "setup" },
    h("header", { class: "top" }, h("div", { class: "row wrap" }, brand("Canals"), h("span", { class: "muted" }, "· designer settings"), versionBadge()),
      h("div", { class: "row wrap" }, h("button", { class: "ghost", onclick: renderHome }, "← Front door"), rulesButton(),
        saved ? h("button", { onclick: () => resume(saved) }, `Resume saved game (round ${saved.round})`) : null)),
    errors.length ? h("div", { class: "errors" }, h("b", {}, "Card notation problems:"), h("ul", {}, errors.map((e) => h("li", {}, e)))) : null,

    h("section", {}, h("h2", {}, "Players"), seatsEl),

    finishedList(),

    mapPreview(),

    h("section", {}, h("h2", {}, "Rules"),
      h("p", { class: "hint" }, "Defaults come from rules/defaults.json, which the Python simulator reads too."),
      h("div", { class: "grid" },
        h("label", { class: "field" }, h("span", {}, "Seed"),
          h("span", { class: "row" }, h("input", { type: "number", value: setup.seed, onchange: (e) => { setup.seed = Number(e.target.value); saveSetup(); } }),
            h("button", { class: "ghost", title: "random seed", onclick: () => { setup.seed = Math.floor(Math.random() * 1e6); saveSetup(); renderSetup(); } }, "↻"))),
        num("Most rounds (a cap)", "rounds", { min: 1 }),
        check("The game ends when the market decks run out", "endOnMarket", "At the end of that round"),
        check("The game ends when every key tile is on the network", "endOnKeys", "At the end of that round"),
        select("Market clock (end of each round)", "marketClock", [["unbought", "the oldest card leaves a display nobody bought from"], ["always", "the oldest card leaves every display"], ["off", "off"]]),
        check("Own harbours", "ownHarbours", "Each player has a harbour; starting dig cards dig only from it or along your own canals"),
        check("Inland cards in their own display", "inlandDisplay", "Off: they shuffle into the coastal deck when the inland opens (playtest-v1)"),
        num("Hand size", "handSize", { min: 1 }),
        num("Hand size cap (+1S)", "handSizeCap", { min: 1 }),
        num("Starting purse", "startingPurse", { min: 0 }),
        num("Starting income", "startingIncome", { min: 0 }),
        num("Income per building", "incomePerBuilding", { min: 0 }),
        num("Market display", "displaySize", { min: 1 }),
        num("VP per building", "vpPerBuilding", { min: 0 }),
        num("VP per key", "vpPerKey", { min: 0 }),
        num("VP per Reach hex", "vpPerReach", { min: 0 }),
        num("Multiplier cap (0 = none)", "multiplierCap", { min: 0 }),
        check("Build only on the canal network", "buildNeedsNetwork"),
        check("Building types (nine, from board/buildings.csv)", "buildingTypes", "Off: every building is the plain one (docs/buildings.md)"),
        check("Resources (cubes)", "materials", "Building types need clay, wood or stone cubes, from extractors or the import market (docs/resources.md)"),
        num("Haul cost per canal edge", "haulPerEdge", { min: 0 }),
        num("Import price once a market is empty", "marketEmptyPrice", { min: 0 }),
        num("Extraction fee (to the camp's owner)", "extractionFee", { min: 0 }),
        select("Inland opens at", "inlandMilestone", [["canals", "canals bordering inland hexes"], ["keys", "key tiles on the network"], ["open", "the first opened inland hex"], ["none", "the start (no milestone)"]]),
        num("Milestone N per player (rounded down)", "inlandMilestonePerPlayer", { min: 0.5, step: 0.5 }),
        select("First to reach it takes", "milestoneReward", [["+1C", "+1C (an extra buy)"], ["+3M", "+3M"], ["+2M", "+2M"], ["+1K", "+1K (a key)"], ["+1I", "+1I (income)"], ["", "nothing"]])),
      h("h3", {}, "Alternatives ", h("span", { class: "muted" }, "— candidates not adopted; see docs/alternatives.md")),
      h("div", { class: "grid" },
        select("Map", "map", [["settled", "The deep map: three bands, grows with the player count"], ["stage1", "Stage 1 (playtest-v1): two bands"], ["classic", "Classic 9×6, 3 harbours"], ["alt-12x11", "12×11 with three far hubs"]]),
        select("Network score", "networkScore", [["reach", "Reach (settled)"], ["crossings", "Crossings"]]),
        select("Income", "incomeMode", [["earn", "Earn pays your income (settled)"], ["round", "Passive, every round; Earn N = N money"]]),
        check("Dig anywhere (stranded ditches)", "connectionRequired", "Replaces the settled connection rule: a canal may be dug anywhere, and counts once something links it to the sea", true),
        check("First crossing ends the game (after the round)", "endOnCrossing", "Needs a map with hubs"),
        num("Random key tiles (if the map has none)", "autoKeyTiles", { min: 0 }))),

    h("section", {}, h("h2", {}, "Decks"),
      h("p", { class: "hint" }, "Set copies per card. Starting copies are per player. Market copies form two decks: ", h("code", {}, "coastal"), " cards from the start, ", h("code", {}, "inland"), " cards once the inland opens at its milestone; tier 2 (", h("code", {}, "coastal-2"), ", ", h("code", {}, "inland-2"), ") comes out after tier 1 of its deck."),
      summary,
      h("div", { class: "row wrap" },
        h("button", { class: "ghost", onclick: async () => { const t = await pickFile(".csv"); if (t) { data.cards = parseCSV(t); setup = defaultSetup(null); renderSetup(); } } }, "Replace cards CSV…"),
        h("button", { class: "ghost", onclick: async () => { const t = await pickFile(".csv"); if (t) { data.cards.push(...parseCSV(t)); setup = defaultSetup(setup); renderSetup(); } } }, "Add cards CSV…"),
        h("button", { class: "ghost", onclick: async () => { const t = await pickFile(".csv"); if (t) { data.hexes = parseCSV(t); renderSetup(); } } }, "Replace hexes CSV…"),
        h("button", { class: "ghost", onclick: async () => { const t = await pickFile(".csv"); if (t) { data.terrain = parseCSV(t); renderSetup(); } } }, "Replace terrain CSV…"),
        data.altMarket?.length && !data.cards.some((r) => r.id === data.altMarket[0].id)
          ? h("button", { class: "ghost", title: "cards/alternatives/market-sample.csv, added with 0 copies",
            onclick: () => { data.cards.push(...data.altMarket); setup = defaultSetup(setup); for (const r of data.altMarket) setup.market[r.id] = 0; saveSetup(); renderSetup(); } }, "Add sample market (alternative)")
          : null,
        h("button", { class: "ghost", onclick: () => download("canals-setup.json", JSON.stringify(setup, null, 2)) }, "Export setup"),
        h("button", { class: "ghost", onclick: async () => { const t = await pickFile(".json"); if (t) { setup = defaultSetup(JSON.parse(t)); saveSetup(); renderSetup(); } } }, "Import setup…"),
        h("button", { class: "ghost", onclick: () => { store.del("canals.setup"); setup = defaultSetup(null); renderSetup(); } }, "Reset to defaults")),
      Object.entries(groups).map(([g, list]) => h("div", { class: "deck-group" }, h("h3", {}, g),
        h("table", { class: "decks" },
          h("thead", {}, h("tr", {}, ["Card", "id", "Effect", "Cost", "VP", "Start", "Market"].map((t) => h("th", {}, t)))),
          h("tbody", {}, list.map(deckRow)))))),

    h("div", { class: "start" }, shareSwitch(), h("button", { class: "primary", onclick: startGame }, "Start game"))));
  pushLobby();
}

// --------------------------------------------------------------------------- //
// The front door (docs/state-of-play.md 5.2): one screen for a newcomer; the
// designer's settings sit behind a link.
// --------------------------------------------------------------------------- //

const STORY = [
  "The sea animals have always lived along the shore. This year they mean to reach the high springs, and they have hired the land animals to dig them a way inland.",
  "Dig canals from your harbour, build on the land your water opens, and gather a deck of animals to help. When the waters reach the high springs, or the market runs dry, the most points wins.",
];

/** Games from the front door use the game's own rules, whatever the designer's page holds. */
function frontSetup(players, seats) {
  const cfg = defaultSetup(null);
  cfg.players = players; cfg.seats = seats;
  cfg.aiPace = store.get("canals.setup")?.aiPace || "normal";
  cfg.seed = Math.floor(Math.random() * 1e6);
  return fixSeats(cfg);
}

function renderHome() {
  stopAi();
  if (net.role === "guest") leaveTable(false);
  document.title = "Canals";
  let saved = store.get("canals.game");
  if (saved && saved.version !== E.STATE_VERSION) { store.del("canals.game"); saved = null; }
  const finished = finishedGames();
  const vsComputer = (n) => {
    setup = frontSetup(["You", ...Array.from({ length: n }, (_, i) => AI_NAMES[i])], ["human", ...Array(n).fill("greedy")]);
    startGame();
  };
  const hotSeat = (n) => {
    setup = frontSetup(Array.from({ length: n }, (_, i) => `Player ${i + 1}`), Array(n).fill("human"));
    startGame();
  };
  app.replaceChildren(h("div", { class: "home" },
    h("div", { class: "hero" },
      h("div", { class: "hero-art", "aria-hidden": "true" }, ["🦦", "🦫", "🦀", "🦡", "🦉"].map((a) => h("span", { class: "animal" }, a))),
      h("h1", { class: "hero-title" }, "Canals"),
      h("p", { class: "hero-sub" }, "A game of water, burrows and borrowed hands, for 2 to 5 players"),
      STORY.map((t) => h("p", { class: "story" }, t)),
      versionBadge()),
    h("div", { class: "doors" },
      saved && !saved.over ? h("section", { class: "door resume" }, h("h2", {}, "Carry on"),
        h("p", {}, `Your game in round ${saved.round}, with ${saved.players.map((pl) => pl.name).join(", ")}.`),
        h("button", { class: "primary", onclick: () => { setup = defaultSetup(store.get("canals.setup")); resume(saved); } }, "Resume the game")) : null,
      h("section", { class: "door" }, h("h2", {}, "Play against the computer"),
        h("p", { class: "muted" }, "You and computer players at this screen. About 45 minutes."),
        h("div", { class: "row wrap" }, [1, 2, 3].map((n) => h("button", { class: n === 2 ? "primary" : "", onclick: () => vsComputer(n) }, `${n + 1} players`)))),
      h("section", { class: "door" }, h("h2", {}, "Play with friends"),
        h("p", { class: "muted" }, "Pass this device around, or invite friends to join from their own."),
        h("div", { class: "row wrap" },
          [2, 3, 4].map((n) => h("button", { onclick: () => hotSeat(n) }, `${n} at this screen`)),
          h("button", { onclick: () => { setup = defaultSetup(store.get("canals.setup")); renderSetup(); hostQuick(); } }, "Online, with an invite link"))),
      h("section", { class: "door" }, h("h2", {}, "How to play"),
        h("p", { class: "muted" }, "One screen to start; the full rules when you want them. Your first game also has a guide."),
        h("div", { class: "row wrap" }, h("button", { onclick: quickStart }, "Quick start"), rulesButton("Full rules")))),
    finished.length ? h("p", { class: "hint home-foot" }, `${finished.length} finished game${finished.length > 1 ? "s" : ""} kept in this browser: see `,
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); setup = defaultSetup(store.get("canals.setup")); renderSetup(); } }, "the designer's page"), ".") : null,
    h("footer", { class: "home-foot" },
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); setup = defaultSetup(store.get("canals.setup")); renderSetup(); } }, "Designer settings"),
      " · rules switches, decks, maps and finished games · Best on a laptop or tablet.")));
  scrollTo(0, 0);
}
const AI_NAMES = ["Hazel", "Bramble", "Rush", "Tansy"];

/** The rules on one screen. */
function quickStart() {
  const cfg = setup || E.DEFAULTS;
  const step = (n, title, text) => h("li", {}, h("b", {}, title), " ", text);
  const panel = h("div", { class: "export", role: "dialog", "aria-label": "Quick start", onclick: (e) => { if (e.target === panel) panel.remove(); } },
    h("div", { class: "export-box quick-start" },
      h("h2", {}, "Canals in one screen"),
      h("ol", {},
        step(1, "Each turn, play one card", "from your hand of three. A card does one thing: dig, build, buy a card, or earn money. You may discard other cards to boost it."),
        step(2, "Dig canals", "from your harbour, along the borders between hexes. Each hex your canals open is open water."),
        step(3, "Build", "on land beside your own canals. Buildings score, raise your income, and unlock crafts in your lodge."),
        step(4, "Buy animals", "from the market to make your deck stronger. They arrive in your discard pile and come round later."),
        step(5, "Keep cards for pearls", "Cards you keep in hand fill your pearl track. Pearls buy money, a redraw or an extra action."),
        step(6, "Score four currents", "Each is a count of one colour of card times what it multiplies: Dig × buildings, Build × card VP, Buy × open water, Guide × friendships. So a deck that leans pays."),
        step(7, "The land opens in three tides", "the coast, then the meadows, then the highland. The game ends when the waters reach the high springs or the market runs dry.")),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => panel.remove() }, "Got it"),
        h("button", { class: "ghost", onclick: () => { panel.remove(); openRules(); } }, "Full rules"))));
  document.body.append(panel);
}

/** "This confused me": a note on this turn, kept with the game's report. */
function markConfusing() {
  if (!state) return;
  const area = h("textarea", { rows: 3, placeholder: "What was confusing? (optional)" });
  const panel = h("div", { class: "export", role: "dialog", "aria-label": "Note a confusion" },
    h("div", { class: "export-box" }, h("h2", {}, "This confused me"),
      h("p", { class: "muted" }, `Marks round ${state.round} in the game's report, so the designer can see where.`), area,
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => {
        (state.notes ||= []).push({ round: state.round, turn: state.turnNumber, player: state.current, text: area.value.trim(), at: Date.now() });
        persist(); panel.remove(); toast("Noted. Thank you!");
      } }, "Mark it"), h("button", { class: "ghost", onclick: () => panel.remove() }, "Cancel"))));
  document.body.append(panel);
  area.focus();
}

/** Which version of the game this is: a frozen playtest version, or the development preview. */
function versionBadge() {
  const slot = h("span", { class: "version-badge" });
  siteInfo().then(({ channel, name, version }) => {
    if (channel === "release") slot.replaceChildren(h("span", { title: `build ${version}` }, `Playtest ${String(name || "").replace(/^playtest-/, "")}`));
    else if (channel === "dev") slot.replaceChildren(h("span", { class: "dev", title: "Work in progress: rules and cards may change. Playtests use the frozen version." },
      `Development preview (${version?.slice(0, 7) || "?"}) · `), h("a", { href: "../" }, "frozen version"));
  });
  return slot;
}

/** "Share finished games with the designer", shown only where reporting is set up. */
function shareSwitch() {
  const slot = h("span", { class: "share-switch" });
  const draw = () => {
    const { queued, last } = reportStatus();
    const send = h("button", { class: "ghost small-btn", onclick: async () => {
      send.disabled = true; send.textContent = "Sending…";
      const r = await flushReports();
      toast(r.sent ? `Sent ${r.sent} report${r.sent === 1 ? "" : "s"}` : "Not sent; see the note");
      draw();
    } }, "Send now");
    slot.replaceChildren(h("label", { class: "row", title: "Each finished game's report (settings, scores, decks, turn history and log, with the players' names) goes to the designer for playtest analysis." },
      h("input", { type: "checkbox", checked: sharing() || null, onchange: (e) => { setSharing(e.target.checked); if (e.target.checked) flushReports().then(draw); } }),
      h("span", {}, "Share finished games with the designer")),
      queued ? h("span", { class: "report-status" }, `${queued} report${queued === 1 ? "" : "s"} waiting to send`,
        last && !last.ok ? h("span", { class: "warn" }, ` (last try: ${last.error})`) : null, " ", send)
      : last?.ok ? h("span", { class: "report-status" }, `Last report sent ${new Date(last.at).toLocaleString()}.`) : null);
  };
  // Show the switch once the site says reporting is set up, after this visit's own attempt to send.
  reportingAvailable().then((on) => { if (on) flushReports().then(draw, draw); });
  return slot;
}

/** For guests: the host's device sends the report. */
function shareNotice() {
  const slot = h("p", { class: "hint" });
  reportingAvailable().then((on) => { if (on) slot.textContent = "Finished games are sent to the designer for playtest analysis (by the host's device, with the players' names)."; });
  return slot;
}

let refreshSeats = () => {};   // redraws the setup screen's Players section
/** The setup screen's Players section: seats, quick starts, and online play. */
function playersBlock() {
  const seatsChanged = () => { saveSetup(); refreshSeats(); pushLobby(); };
  const quick = (n) => {
    setup.players = ["You", ...Array.from({ length: n }, (_, i) => (n > 1 ? `Greedy AI ${i + 1}` : "Greedy AI"))];
    setup.seats = ["human", ...Array(n).fill("greedy")];
    seatsChanged();
  };
  return h("div", {},
    h("div", { class: "row wrap quick" }, h("span", { class: "muted" }, "Quick start:"),
      [1, 2, 3].map((n) => h("button", { class: "ghost", onclick: () => quick(n) }, `You vs ${n} AI${n > 1 ? "s" : ""}`)),
      h("button", { class: "ghost", onclick: () => { setup.players = ["Player 1", "Player 2"]; setup.seats = ["human", "human"]; seatsChanged(); } }, "2 humans, hot-seat"),
      h("button", { class: "ghost", onclick: () => { hostQuick(); } }, "Online: you + friends")),
    h("div", { class: "players" },
      setup.players.map((name, i) => h("div", { class: "player-input" },
        crest({ colour: E.PLAYER_COLOURS[i] }, i),
        h("input", { value: name, "aria-label": `Seat ${i + 1} name`, onchange: (e) => { setup.players[i] = e.target.value; saveSetup(); } }),
        h("select", { "aria-label": `Seat ${i + 1} player`, title: SEAT_HINT, onchange: (e) => { setup.seats[i] = e.target.value; seatsChanged(); } },
          Object.entries(SEATS).map(([v, l]) => h("option", { value: v, selected: setup.seats[i] === v || null }, l))),
        setup.seats[i] === "remote" ? lobbySeatNote(i) : null,
        setup.players.length > 1 ? h("button", { class: "ghost", title: "remove", onclick: () => { removeSeat(i); seatsChanged(); } }, "×") : null)),
      setup.players.length < 5 ? h("button", { class: "ghost", onclick: () => {
        const n = setup.players.length + 1;
        setup.players.push(`AI ${n}`); setup.seats.push("greedy"); seatsChanged();
      } }, "+ player") : null),
    setup.seats.some((x) => x === "greedy" || x === "random") ? h("div", { class: "row wrap" },
      h("label", { class: "row" }, h("span", { class: "muted" }, "Computer turn speed"),
        h("select", { onchange: (e) => { setup.aiPace = e.target.value; saveSetup(); } },
          Object.entries(PACES).map(([v, [l]]) => h("option", { value: v, selected: setup.aiPace === v || null }, l)))),
      h("span", { class: "hint" }, SEAT_HINT)) : null,
    setup.seats.every((x) => !["human", "remote"].includes(x)) ? h("p", { class: "hint" }, "No human seats: the computers will play the whole game while you watch.") : null,
    onlinePanel());
}

function boardLegend(state) {
  const item = (id, text, title) => h("span", { title: title || null }, icon(id), text);
  return h("div", { class: "legend" },
    state.board.harbourMap ? item("m-harbour", "harbour") : null,
    h("span", {}, h("span", { class: "lg mouth" }), "harbour mouth: canals start here, and join only at shared corners"),
    item("m-key", "key tile"), item("m-discovery", "discovery (first opener takes it)"),
    h("span", {}, h("span", { class: "lg canal" }), "canal (banks in its digger's colour)"), item("b-plain", "building"),
    h("span", {}, h("span", { class: "lg opened" }), "opened (counts for Reach)"),
    E.inlandClosed(state) ? h("span", {}, h("span", { class: "lg locked" }), "inland, closed until the milestone") : null,
    state.config.materials && state.config.hauling === "tolls" ? h("span", {}, icon("m-forest"), icon("m-mountain"),
      `forest / stone: build a logging camp / quarry for a source that never runs out (1 to its owner). Clay is free from any shore hex. A build's resources come the cheapest way over linked canals: ${state.config.tollPerCanal} to the owner of each canal of someone else's, and stone ${state.config.stoneBankToll} more a canal to the bank`)
    : state.config.materials ? h("span", {}, icon("m-clay"), icon("m-forest"), icon("m-mountain"),
      `clay bed / forest / mountain: build a clay pit / logging camp / quarry to put cubes on the hex (number shown). Builds take the cubes they need from the cheapest connected source: ${state.config.haulPerEdge} per canal edge, plus ${state.config.extractionFee} to the owner, or imported through a harbour at the market price`) : null,
    state.config.networkScore === "crossings" || state.config.endOnCrossing ? h("span", {}, h("span", { class: "lg hub" }), "hub (crossing goal)") : null,
    state.crossings.length ? h("span", {}, `${state.crossings.length} crossing(s) complete`) : null);
}

/** The setup screen's map: the board a game with these settings would start on. */
function mapPreview() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "board");
  svg.setAttribute("role", "img");
  const facts = h("p", { class: "hint" });
  const legend = h("div");
  refreshPreview = () => {
    try {
      const s = E.createGame(gameData(), structuredClone(setup));
      renderBoard(svg, s, { still: true, coords: true });
      svg.setAttribute("aria-label", "Map preview");
      const hx = Object.values(s.board.hexes);
      const land = hx.filter((x) => !s.board.terrain[x.terrain].water);
      const count = (f) => land.filter(f).length;
      facts.replaceChildren(
        `For ${s.players.length} players: ${land.length} land hexes · ${count((x) => x.harbour)} harbours · `,
        `${count((x) => !x.shore)} hexes a canal can open · ${count((x) => x.isKey)} key tiles · `,
        `${count((x) => x.bonus)} discoveries · ${Object.keys(s.board.edges).length} diggable edges`);
      legend.replaceChildren(boardLegend(s));
    } catch (err) {
      svg.replaceChildren();
      facts.textContent = `Can't draw this map: ${err.message || err}`;
    }
  };
  refreshPreview();
  return h("section", { class: "map-preview" }, h("h2", {}, "Map"), facts, svg, legend);
}

function finishedList() {
  const list = finishedGames();
  if (!list.length) return null;
  const rows = list.map((g) => {
    let rank;
    try { rank = E.ranking(g.state); } catch { rank = null; }
    return h("tr", {},
      h("td", {}, new Date(g.finishedAt).toLocaleString()),
      h("td", {}, rank ? rank.map((r, k) => h("span", { class: "result" },
        h("span", { class: "swatch", style: `background:${g.state.players[r.i].colour}` }),
        k === 0 ? h("b", {}, `${r.name} ${r.total}`) : `${r.name} ${r.total}`,
        g.state.players[r.i].ai ? h("span", { class: "muted" }, " (AI)") : null)) : h("span", { class: "warn" }, "unreadable")),
      h("td", { class: "n" }, g.state.round),
      h("td", {}, h("div", { class: "row" },
        rank ? h("button", { class: "ghost", onclick: () => { stopAi(); refreshPreview = null; state = g.state; renderEnd(); } }, "Open") : null,
        confirmButton("Delete", "Delete? Click again", () => { saveFinished(finishedGames().filter((x) => x.finishedAt !== g.finishedAt)); renderSetup(); }))));
  });
  return h("section", {}, h("h2", {}, "Finished games ", h("span", { class: "muted" }, `(last ${KEEP_FINISHED} kept in this browser)`)),
    h("table", { class: "decks" },
      h("thead", {}, h("tr", {}, ["Finished", "Result", "Rounds", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows)));
}

function gameData(chosen = setup) {
  return {
    cards: data.cards, terrain: data.terrain,
    hexes: chosen.map === "stage1" && data.stage1Hexes?.length ? data.stage1Hexes
      : chosen.map === "alt-12x11" && data.altHexes?.length ? data.altHexes
      : chosen.map === "classic" && data.classicHexes?.length ? data.classicHexes : data.hexes,
    buildings: data.buildings, tech: data.tech,
  };
}

async function startGame() {
  // Online seats need the table open, so their players can join (now or later).
  if (setup.seats.includes("remote") && net.role !== "host" && !(await openTable())) return;
  refreshPreview = null;
  stopAi();
  state = E.createGame(gameData(), structuredClone(setup));
  // The seat is kept on the player, so a saved game resumes with its computers.
  state.players.forEach((pl, i) => {
    if (setup.seats[i] === "remote") pl.remote = true;
    else if (setup.seats[i] !== "human") pl.ai = setup.seats[i];
  });
  undo = [];
  sel = { play: null, discards: new Set() };
  if (net.role === "host") net.started = true;
  state.startedAt = Date.now();
  persist();
  renderGame();
  scrollTo(0, 0);
  pushState();
}

async function resume(saved) {
  // A game with online seats reopens its table under the same code, so its players can rejoin.
  if (saved.players?.some((pl) => pl.remote) && net.role !== "host") {
    const was = store.get("canals.hosting");
    const claims = (was?.claims || []).map((c) => (c ? { ...c, conn: null } : null));
    if (!(await openTable(was?.code || makeCode(), claims))) return;
  }
  refreshPreview = null; stopAi(); state = saved; undo = []; sel = { play: null, discards: new Set() };
  if (net.role === "host") net.started = true;
  if (state.over) { keepFinished(state); pushState(); return renderEnd(); }
  renderGame();
  pushState();
}
function persist() { if (net.role !== "guest") store.set("canals.game", state); }

// --------------------------------------------------------------------------- //
// Game screen
// --------------------------------------------------------------------------- //

/**
 * Make a move (commands.js). On a guest's device it goes to the host, which
 * applies it and sends the new state back; otherwise it is applied here.
 */
function act(cmd) {
  if (net.role === "guest") {
    if (!net.link?.send({ t: "cmd", cmd })) toast("Not connected to the host right now");
    return;
  }
  const res = applyMove(cmd);
  if (!res.ok) return toast(res.reason);
  afterMove(res.ended);
}

/** Apply a move here, keeping the within-turn undo stack. */
function applyMove(cmd) {
  if (cmd?.type === "undo") {
    if (!undo.length) return { ok: false, reason: "nothing to undo" };
    state = JSON.parse(undo.pop());
    return { ok: true };
  }
  const snap = JSON.stringify(state);
  const mover = state.current, wasTurn = state.turnNumber;
  const res = applyCommand(state, cmd);
  if (!res.ok) return res;
  // How long each turn took (the reports carry it: docs/state-of-play.md 5.2).
  if (state.turnNumber !== wasTurn) {
    const at = Date.now();
    (state.timing ||= []).push({ round: state.round, player: mover, ms: state.turnStart ? at - state.turnStart : null, ai: !!state.players[mover]?.ai });
    state.turnStart = at;
  }
  // Moves that show hidden information (a new market card) can't be undone.
  if (res.ended || res.reveals) undo = []; else undo.push(snap);
  return res;
}

function afterMove(ended) {
  if (ended) { undo = []; sel = { play: null, discards: new Set() }; redrawing = false; }
  persist();
  pushState();
  if (state.over) { store.del("canals.game"); learnLanes(state); keepFinished(state); sendReport(); return renderEnd(); }
  renderGame(ended);
}

/**
 * Send the finished game's report to the designer (reports.js), once per game.
 * Online, only the host sends it.
 */
async function sendReport() {
  if (net.role === "guest" || !state?.over || state.reportId) return;
  state.reportId = makeCode(10);
  keepFinished(state);                      // remember it was sent, with its id
  const info = await siteInfo();
  const rep = { ...report(), site: info.version, channel: info.channel, release: info.channel === "release" ? info.name : null };
  const res = await submitReport(rep);
  if (res.sent) toast("Game report sent to the designer. Thank you!");
}

function toast(msg) {
  const t = h("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

function afterTurn() { afterMove(true); }

// --------------------------------------------------------------------------- //
// Computer players
// --------------------------------------------------------------------------- //

/** "Ana's", but "Your" for a seat named You. */
const whose = (name) => (/^you$/i.test(name.trim()) ? "Your" : `${name}'s`);
/** Online, "Your" only on the device that moves for the seat. */
const whoseSeat = (i) => (net.role === "local" ? whose(state.players[i].name) : canMove(i) ? "Your" : `${state.players[i].name}'s`);

function stopAi() { clearTimeout(aiTimer); aiTimer = null; aiFailed = null; }

/** If a computer is to move, play its turn after the chosen delay. */
function scheduleAi() {
  if (net.role === "guest" || aiTimer || aiFailed || !state || state.over || !E.currentPlayer(state).ai) return;
  // Leave time for the last turn's playback (animateLastTurn) before the next.
  aiTimer = setTimeout(aiTurn, (PACES[setup?.aiPace] || PACES.normal)[1] + playbackMs);
}

function aiTurn() {
  aiTimer = null;
  const p = E.currentPlayer(state);
  if (!p?.ai || state.over) return;
  const turn = AGENTS[p.ai] || AGENTS.greedy;
  const before = JSON.stringify(state);
  try {
    // Seeded from the game, so a resumed game makes the same computer choices.
    const res = turn(state, makeRng((state.config.seed || 1) * 31 + state.log.length));
    if (res && res.ok === false) throw new Error(res.reason);
  } catch (err) {
    state = JSON.parse(before);
    aiFailed = String(err.message || err);
    persist();
    pushState();
    renderGame();
    return;
  }
  state.turnStart = Date.now();
  afterTurn();
}

function poolLine(pool) {
  const items = [
    ["dig", "dig", "i-dig"], ["build", "build", "i-build"], ["buy", "buy", "i-buy"],
    ["digDiscount", "−dig cost", "i-dig"], ["buildDiscount", "−build cost", "i-build"], ["buyDiscount", "−card cost", "i-buy"],
    ["trashAny", "trash (hand/discard)", "i-trash"], ["trashHand", "trash (hand)", "i-trash"], ["trashDiscard", "trash (discard)", "i-trash"], ["extraDraw", "extra draw", "i-hand"],
  ].filter(([k]) => pool[k] > 0);
  return items.length ? items.map(([k, l, ic]) => h("span", { class: "pill action-pill" }, icon(ic), ` ${l} ×${pool[k]}`)) : h("span", { class: "muted" }, "nothing left to do — end your turn");
}

function previewEffects(d, n) {
  const fx = resolveEffects(d, n);
  const names = { money: "money", income: "income", keys: "keys", handSize: "hand size", dig: "dig", build: "build", buy: "buy",
    digDiscount: "−dig cost", buildDiscount: "−build cost", buyDiscount: "−card cost", trashAny: "trash", trashHand: "trash (hand)",
    trashDiscard: "trash (discard)", extraDraw: "extra draw", pearl: "pearl", pearlTrack: "pearl track" };
  return Object.entries(fx).map(([k, v]) => `${names[k] || k} ${v > 0 ? "+" : ""}${v}`).join(", ") || "no effect";
}

/** The map key starts open on wide screens, and then stays as the player left it. */
function legendOpen() {
  const kept = store.get("canals.mapKey");
  return typeof kept === "boolean" ? kept : !matchMedia("(max-width: 900px)").matches;
}

/** Money, income, keys, Reach, hand, pearls and piles, as icons. */
function statLine(pl, i, piles) {
  const stat = (id, title, v) => h("span", { title }, icon(id), v);
  return h("span", { class: "stat-line" },
    stat("i-coin", "money", pl.money),
    stat("i-income", state.config.incomeMode === "earn" ? "income (paid when you Earn)" : "income", pl.income),
    stat("i-key", "keys", pl.keys),
    stat("i-reach", "Reach: inland hexes your canals opened", E.reach(state, i)),
    stat("i-hand", "hand size", pl.handSize),
    state.config.pearls ? (state.config.pearlEarning === "track"
      ? stat("i-pearl", `pearls held (at most ${state.config.pearlCap}), and the pearl track: each card you keep at the end of your turn moves it a space; at the threshold you take a pearl`,
        h("span", {}, pl.pearls || 0, h("small", { class: "track" }, ` ${pl.pearlTrack || 0}/${E.pearlNeed(state, pl)}`)))
      : stat("i-pearl", `pearls: banked by ending a turn without discarding (at most ${state.config.pearlCap})`, pl.pearls || 0)) : null,
    piles ? stat("i-deck", "draw pile / discard pile", `${pl.draw.length}/${pl.discard.length}`) : null);
}

function renderGame(newTurn = false) {
  const p = E.currentPlayer(state);
  const t = state.turn;
  const acting = canMove(state.current);          // this device moves for the current seat
  const vi = viewerSeat(), me = vi === null ? null : state.players[vi];
  if (!state.buildingTypes.some((b) => b.id === buildType)) buildType = state.buildingTypes[0].id;
  const boardSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  boardSvg.setAttribute("class", "board");
  renderBoard(boardSvg, state, {
    onDig: (ek) => act({ type: "dig", edge: ek }),
    onBuild: (hk) => act({ type: "build", hex: hk, kind: buildType }),
    onHarbour: (hk) => act({ type: "harbour", hex: hk }),
    buildType, interactive: acting,
  });
  const zoomCtl = attachZoom(boardSvg);
  // The price of a dig or build beside the pointer, not in a slow browser tooltip.
  const info = h("div", { class: "hover-info", hidden: true });
  boardSvg.addEventListener("pointerover", (e) => {
    const t = e.target.closest?.("[data-info]");
    if (!t) { info.hidden = true; return; }
    info.replaceChildren(...t.dataset.info.split("\n").map((l, i) => h(i ? "div" : "b", {}, l)));
    const r = boardSvg.getBoundingClientRect(), b = t.getBoundingClientRect();
    info.style.left = `${Math.min(r.width - 230, Math.max(4, b.right - r.left + 8))}px`;
    info.style.top = `${Math.max(4, b.top - r.top - 8)}px`;
    info.hidden = false;
  });
  boardSvg.addEventListener("pointerleave", () => { info.hidden = true; });
  if (net.role !== "local") document.title = acting ? "Your turn · Canals" : "Canals";

  // Hand
  let controls;
  const hand = h("div", { class: "hand" });
  if (!acting) {
    // Someone else's turn: a computer, a player on another device, or a
    // hot-seat player who isn't looking. Keep their hand hidden; show this
    // device's own player's hand so they can plan.
    const seat = seatStatus(state.current);
    controls = h("div", { class: "controls" },
      p.ai && aiFailed
        ? [h("p", { class: "warn" }, `${p.name} could not take its turn: ${aiFailed}`),
          net.role !== "guest" ? h("div", { class: "row" }, h("button", { class: "primary", onclick: () => { aiFailed = null; renderGame(); } }, "Try again")) : null]
        : p.ai ? h("p", { class: "thinking" }, `${p.name} is playing… `, h("span", { class: "muted" }, `(${p.hand.length} cards in hand)`))
        : seat === "away" ? [h("p", { class: "warn" }, `Waiting for ${p.name}, who isn't connected.`),
          net.role === "host" ? h("div", { class: "row" }, h("button", { onclick: () => takeOver(state.current) }, `Let the computer play for ${p.name}`),
            h("span", { class: "hint" }, "They get their seat back when they rejoin.")) : null]
        : h("p", { class: "thinking" }, `Waiting for ${p.name}… `),
      me && me !== p ? [h("h3", {}, `${whose(me.name)} hand `, h("span", { class: "muted" }, "(waiting)")),
        h("div", { class: "hand mini" }, me.hand.map((uid) => cardView(E.def(state, uid), { cls: "dim", key: `c${uid}` })))] : null);
  } else if (t.phase === "startTech") {
    // The starting technology: an inner slot opened for free; its token goes back in the box.
    controls = h("div", { class: "controls" },
      h("p", {}, h("b", {}, "Choose your starting craft. "), "It opens one inner slot of your lodge: its craft and income are yours from the first turn, and its building goes back in the box. No two players the same."),
      h("div", { class: "row wrap" }, E.startTechChoices(state).map((id) => {
        const x = E.techSlot(state, id), bt = state.buildingTypes.find((b) => b.id === x.token);
        return h("button", { class: "craft-choice", title: `Gives up a ${rename(bt?.name || x.token)} from your lodge`, onclick: () => act({ type: "startTech", slot: id }) }, h("b", {}, rename(x.name)), h("span", {}, x.text));
      })));
  } else if (t.phase === "harbour") {
    // The harbour draft: last seat chooses first; a deep harbour costs a premium.
    controls = h("div", { class: "controls" },
      h("p", {}, h("b", {}, "Choose your harbour."), " Click a ringed harbour on the map. The last seat chooses first; a deep harbour, one that reaches the inland in fewer canals, costs some of your starting money."),
      h("div", { class: "row" }, E.draftChoices(state).map((hk) => {
        const cost = E.harbourPremium(state, hk);
        return h("button", { onmouseenter: () => flashHexes([hk]), onmouseleave: () => flashHexes([]), onclick: () => act({ type: "harbour", hex: hk }) },
          h("b", {}, harbourName(state, hk)), cost ? ` · deep, costs ${cost} money` : " · free");
      })));
  } else if (t.phase === "choose") {
    for (const uid of p.hand) {
      const d = E.def(state, uid);
      const isPlay = sel.play === uid, isDisc = sel.discards.has(uid);
      hand.append(cardView(d, {
        key: `c${uid}`,
        cls: isPlay ? "selected" : isDisc ? "discarding" : "clickable",
        badge: isPlay ? "PLAY" : isDisc ? "DISCARD" : null,
        onclick: () => {
          if (sel.play === null || sel.play === uid) { sel.play = sel.play === uid ? null : uid; sel.discards.clear(); }
          else if (isDisc) sel.discards.delete(uid);
          else sel.discards.add(uid);
          renderGame();
        },
      }));
    }
    if (sel.play === null) {
      const cfg = state.config;
      const forage = p.hand.length && (cfg.forageOne > 0 || cfg.forageHand > 0)
        ? h("p", { class: "hint" }, "Or forage instead: ",
          cfg.forageOne > 0 ? `select a card and discard it face down for ${cfg.forageOne} money` : "",
          cfg.forageOne > 0 && cfg.forageHand > 0 ? ", or " : "",
          cfg.forageHand > 0 ? h("button", { onclick: () => act({ type: "forage", uid: "hand" }) }, `discard your whole hand for ${cfg.forageHand}`) : "",
          ". Foraging ends the turn and earns no pearl progress.")
        : null;
      controls = h("div", { class: "controls" },
        p.hand.length ? (t.secondWind ? h("p", {}, h("b", {}, "Second wind: "), "choose a second card to play.") : [h("p", {}, "Choose a card to play."), forage]) : [h("p", {}, "Your hand is empty."), h("button", { onclick: () => act({ type: "pass" }) }, "Pass")]);
    } else {
      const d = E.def(state, sel.play), n = sel.discards.size;
      const legal = legalDiscardCount(d, n);
      const bc = d.boostCost;
      const need = bc.kind === "threshold" ? `Boost: discard exactly ${bc.n}.` : bc.kind === "scalar" ? "Boost: discard any number — scales per card." : "No boost on this card.";
      controls = h("div", { class: "controls" },
        h("p", {}, h("b", {}, displayName(d)), " — ", need, bc.kind !== "none" ? " Click other cards to discard them." : ""),
        h("p", { class: legal ? "" : "warn" }, legal ? `Gives: ${previewEffects(d, n)}` : `Can't discard ${n} for this boost.`),
        h("div", { class: "row" },
          h("button", { class: "primary", disabled: !legal, onclick: () => {
            const play = sel.play, discards = [...sel.discards];
            sel = { play: null, discards: new Set() };
            act({ type: "play", play, discards });
          } }, n ? `Play and discard ${n}` : "Play"),
          ...E.boardBoosts(state, state.current, d).map((b) => {
            const ok = E.boardBoostLegal(state, b, [...sel.discards]);
            return h("button", { disabled: !ok || null, title: `Board boost (${E.techName(state, b)}): ${E.BOARD_BOOSTS[b].text}, instead of the card's own boost`, onclick: () => {
              const play = sel.play, discards = [...sel.discards];
              sel = { play: null, discards: new Set() };
              act({ type: "play", play, discards, board: b });
            } }, `${E.techName(state, b)}: ${E.BOARD_BOOSTS[b].text}`);
          }),
          state.config.forageOne > 0 && !n && !t.secondWind ? h("button", { title: "Discard this card face down for money instead of playing it. The turn ends, with no pearl progress.", onclick: () => {
            const uid = sel.play;
            sel = { play: null, discards: new Set() };
            act({ type: "forage", uid });
          } }, `Forage it for ${state.config.forageOne}`) : null));
    }
  } else {
    const trashHand = (t.pool.trashHand || 0) + (t.pool.trashAny || 0) > 0;
    for (const uid of p.hand) {
      hand.append(cardView(E.def(state, uid),
        redrawing ? { key: `c${uid}`, cls: "clickable", badge: "redraw?", onclick: () => { redrawing = false; act({ type: "pearl", kind: "redraw", uid }); } }
        : trashHand ? { key: `c${uid}`, cls: "clickable trashable", badge: "trash?", onclick: () => act({ type: "trash", uid, from: "hand" }) } : { key: `c${uid}`, cls: "dim" }));
    }
    const played = t.played ? E.def(state, t.played) : null;
    controls = h("div", { class: "controls" },
      played ? h("p", {}, "Played ", h("b", {}, displayName(played)), t.discards.length ? ` (discarded ${t.discards.length})` : "", ". Available: ") : null,
      h("div", { class: "row wrap" }, poolLine(t.pool)),
      pearlMenu(p),
      t.pool.build > 0 && state.buildingTypes.length > 1 ? buildingPicker(p) : null,
      t.digAnywhere && t.pool.dig > 0 ? h("p", { class: "hint" }, `This land animal may also dig anywhere${t.digAnywhere === "any" ? "" : t.digAnywhere === "coastal" ? " on the coast" : " inland"}, away from the water; such a canal is cut off until someone links it.`) : null,
      h("div", { class: "row" },
        h("button", { class: "ghost", disabled: !(net.role === "guest" ? net.undoable : undo.length), onclick: () => act({ type: "undo" }) }, "Undo"),
        endTurnButton(t.pool)));
  }

  // Discard pile (trash target)
  const trashDisc = acting && t.phase === "resolve" && (t.pool.trashDiscard || 0) + (t.pool.trashAny || 0) > 0;
  const discardPile = !me ? null : h("details", { class: "pile", open: trashDisc || null },
    h("summary", {}, `Discard pile (${me.discard.length})${trashDisc ? " — click a card to trash it" : ""}`),
    h("div", { class: "hand mini" }, me.discard.map((uid) => cardView(E.def(state, uid),
      trashDisc ? { key: `c${uid}`, cls: "clickable trashable", onclick: () => act({ type: "trash", uid, from: "discard" }) } : { key: `c${uid}` }))));

  // Market
  const canBuy = acting && t.phase === "resolve" && t.pool.buy > 0;
  const topExtra = E.topCost(state);
  const mk = state.market;
  const split = state.config.inlandDisplay;
  const tierLeft = (pile) => {
    const t2 = pile.filter((uid) => E.deckTier(E.def(state, uid).deck) > 1).length;
    return `${pile.length} in deck${t2 ? `, ${t2} of them tier 2` : ""}`;
  };
  const clock = E.clockMode(state.config);
  const leavesNext = (where) => clock === "always" || (clock === "unbought" && !mk.bought?.[where]);
  const row = (cards, offset) => h("div", { class: "hand" }, cards.map((uid, i) => {
    const d = E.def(state, uid), slot = offset + i;
    const top = buyTop && topExtra !== null;
    const ok = canBuy && E.canBuy(state, slot, top).ok;
    const cost = canBuy ? E.buyCost(state, uid) + (top ? topExtra : 0) : d.cost;
    return cardView(d, { key: `c${uid}`, cls: ok ? "clickable buyable" : canBuy ? "dim" : "",
      badge: canBuy ? `pay ${cost}` : (i === 0 && leavesNext(offset === 0 ? "coastal" : "inland") ? "leaves next" : null),
      onclick: ok ? () => { buyTop = false; act({ type: "buy", slot, ...(top ? { top: true } : {}) }); } : null });
  }), cards.length ? null : h("div", { class: "card empty" }, "—"));
  const markets = h("div", { class: "market" },
    h("h3", {}, split ? "Coastal market " : "Market ", h("span", { class: "muted" },
      `(${tierLeft(mk.stack)}${!split && mk.inland.length ? `; ${mk.inland.length} inland cards join when the inland opens` : ""})`)),
    E.inlandClosed(state) ? h("p", { class: "milestone" }, milestoneLine()) : null,
    state.config.materials && state.config.hauling !== "tolls" ? h("p", { class: "supply" }, h("b", {}, "Import market: "),
      E.RESOURCES.map((r) => `${r} ${state.supply[r]} left, next ${E.marketPrice(state, r)}`).join(" · ")) : null,
    canBuy && topExtra !== null ? h("label", { class: "buy-top" },
      h("input", { type: "checkbox", checked: buyTop || null, onchange: (e) => { buyTop = e.target.checked; renderGame(); } }),
      ` Put the card I buy on top of my draw pile (${topExtra ? `+${topExtra} money` : "free"}): I draw it at the end of this turn.`) : null,
    row(mk.display, 0),
    split ? h("h3", {}, "Inland market ", h("span", { class: "muted" },
      state.inlandOpen ? `(${tierLeft(mk.inland)})` : `(${mk.inland.length} cards; opens with the inland)`)) : null,
    split && state.inlandOpen ? row(mk.inlandDisplay, mk.display.length) : null,
    // Reserve (technology): cards set aside for this player alone.
    (p.reserved || []).length && acting ? [h("h3", {}, "Reserved for you"), row(p.reserved, mk.display.length + mk.inlandDisplay.length)] : null,
    acting && t.phase === "resolve" && E.hasTech(state, state.current, "reserve") && (p.pearls || 0) >= 1
      ? h("p", { class: "hint" }, "Reserve (1 pearl): ", [...mk.display, ...mk.inlandDisplay].map((uid, slot) =>
        h("button", { class: "ghost", onclick: () => act({ type: "pearl", kind: "reserve", uid: slot }) }, displayName(E.def(state, uid))))) : null);

  // Players: the others compact, with labels on hover.
  const others = state.players.map((pl, i) => {
    const sc = E.score(state, i);
    return h("div", { class: "player" + (i === state.current ? " active" : ""), style: `--pc:${pl.colour}`, "data-key": `player-${i}` },
      h("div", { class: "pname" }, crest(pl, i), pl.name,
        pl.takenOver ? h("span", { class: "muted" }, " · computer, until they rejoin")
          : pl.ai ? h("span", { class: "muted" }, " · computer") : null,
        seatBadge(i), h("span", { class: "ptotal", title: "the score if the game ended now" }, count(sc.total, `score-${i}`), " pts")),
      lastTurnLine(i),
      h("div", { class: "player-row" }, scoreWheel(sc, 74, i),
        h("div", {}, statLine(pl, i, true),
          E.techOn(state) ? h("details", { class: "tech" },
            h("summary", {}, `${W.Lodge}: ${state.tech.slots.length - (pl.taken || []).length} buildings to place`,
              E.capstonesOf(state, i).map((k) => h("span", { class: "pill", title: E.CAPSTONES[k].text }, ` ★ ${rename(E.CAPSTONES[k].name)}`))),
            renderTechBoard(state, i)) : null)));
  });

  // What the others did since this player's last turn.
  const since = me && me.seen !== undefined ? state.log.slice(me.seen) : [];
  const recap = since.length && state.players.length > 1
    ? h("details", { class: "recap", open: t.phase === "choose" || null },
      h("summary", {}, me === p ? "Since your last turn" : "Since your turn"),
      h("div", { class: "log" }, since.slice(-30).map((l) => h("div", {}, themeLog(state, l.msg)))))
    : null;

  const logView = h("div", { class: "log" }, state.log.slice(-60).reverse().map((l) => h("div", {}, h("span", { class: "muted" }, `R${l.round} `), themeLog(state, l.msg))));
  const tab = store.get("canals.tab") || "players";
  const tabs = h("section", { class: "tabs" },
    h("div", { class: "tab-row", role: "tablist" }, [["players", "Players"], ["market", "Market"], ["log", "Log"], ["key", "Map key"]].map(([k, l]) =>
      h("button", { role: "tab", class: "tab" + (tab === k ? " on" : ""), "aria-selected": tab === k ? "true" : "false",
        onclick: () => { store.set("canals.tab", k); renderGame(); } }, l,
        k === "market" && canBuy ? h("span", { class: "dot-new", title: "you can buy" }) : null))),
    h("div", { class: "tab-body" }, tab === "players" ? others : tab === "log" ? logView : tab === "market" ? markets : boardLegend(state)));

  const mine = me ? myPanel(me, vi) : null;

  const flip = flipFirst();
  app.replaceChildren(h("div", { class: "game" },
    h("header", { class: "top" },
      brand("Canals"),
      h("div", { class: "turn-info" }, `Round ${state.round}`,
        state.tide ? h("span", { class: "tide-chip", title: "The coast, then the meadows (the inland), then the highland." }, ` · ${["", "The coast", "The meadows", "The highland"][state.tide]}`) : null,
        h("span", { class: "muted", title: `The game ends when the market decks run out, or the waters reach the high springs; at most ${state.config.rounds} rounds` },
          state.config.endOnMarket ? ` · ${state.market.stack.length + state.market.inland.length} cards left to buy` : ` of ${state.config.rounds}`),
        state.endTriggered ? h("span", { class: "warn" }, " · final round") : null),
      h("div", { class: "row wrap" }, tableBadge(), rulesButton("Rules"), settingsMenu(),
        net.role === "guest" ? confirmButton("Leave", "Leave the table? Click again", leaveTable)
          : confirmButton("Quit", net.role === "host" ? "End the game for everyone? Click again" : "Quit? Click again", () => { store.del("canals.game"); renderHome(); }))),
    promptBar(acting, p),
    h("main", {},
      h("div", { class: "left" },
        h("div", { class: "board-wrap" }, boardSvg, zoomCtl, info),
        tab !== "market" ? h("section", { class: "market-strip" }, markets) : null),
      h("aside", {},
        netBanner(),
        h("section", { class: "me", style: `--pc:${(me || p).colour}` },
          me ? h("h2", { onclick: (e) => { if (matchMedia("(max-width: 640px)").matches) e.currentTarget.parentElement.classList.toggle("collapsed"); } }, crest(me, vi), me.name, h("span", { class: "ptotal" }, count(E.score(state, vi).total, `score-${vi}`), " pts"))
            : h("h2", {}, "Watching", h("span", { class: "muted" }, net.role === "guest" ? " (every seat is taken)" : "")),
          mine?.stats, recap, hand, controls, discardPile, mine?.extra),
        tabs))));

  flipLast(flip);
  animateLastTurn();
  tideBanner();
  if (newTurn && acting && net.role === "guest") toast("Your turn");
  if (newTurn && acting && localSeats().length > 1) {
    const cover = h("div", { class: "cover", onclick: () => cover.remove() },
      h("div", {}, crest(p, state.current, "big"), h("h2", {}, `${whose(p.name)} turn`),
        h("p", {}, `Round ${state.round}. Click to reveal your hand.`)));
    document.body.append(cover);
  }
  scheduleAi();
}

// --------------------------------------------------------------------------- //
// Playback (docs/state-of-play.md 5.3): another player's turn is shown in
// steps: their card face up, then each canal and building arriving in order.
// --------------------------------------------------------------------------- //

let animatedTurn = -1, playbackMs = 0;
const STEP_MS = 380;
function animateLastTurn() {
  const recs = state.history || [];
  const rec = recs[recs.length - 1];
  if (!rec || animatedTurn === state.turnNumber) { playbackMs = 0; return; }
  const first = animatedTurn < 0;
  animatedTurn = state.turnNumber;
  playbackMs = 0;
  if (first || canMove(rec.player) && !state.players[rec.player].ai || reduceMotion()) return;
  const acts = rec.actions.filter((a) => a.type === "dig" || a.type === "build" || a.type === "buy");
  acts.forEach((a, i) => {
    const delay = `${300 + i * STEP_MS}ms`;
    const node = a.type === "dig" ? document.querySelector(`.canal.draw[data-edge="${CSS.escape(a.edge)}"]`)
      : a.type === "build" ? document.querySelector(`.building.drop[data-hex="${CSS.escape(a.hex)}"]`) : null;
    if (node) { node.style.animationDelay = delay; for (const c of node.querySelectorAll("*")) c.style.animationDelay = delay; }
  });
  const pl = state.players[rec.player], d = rec.card ? state.defs[rec.card] : null;
  if (d) {
    const wrap = document.querySelector(".board-wrap");
    const pop = h("div", { class: "played-pop", style: `--pc:${pl.colour}` },
      h("div", { class: "who" }, crest(pl, rec.player), `${pl.name} plays`), cardView(d, { compact: true }),
      h("div", { class: "what" }, lastTurnSummary(rec.player)?.text || ""));
    wrap?.append(pop);
    setTimeout(() => pop.classList.add("out"), 900 + acts.length * STEP_MS);
    setTimeout(() => pop.remove(), 1300 + acts.length * STEP_MS);
  }
  playbackMs = 600 + acts.length * STEP_MS;
  sound(acts.some((a) => a.type === "build") ? "build" : acts.length ? "dig" : null);
}

/**
 * FLIP (First, Last, Invert, Play): note where each keyed element is before a
 * redraw, and after it let each travel from there. Cards then slide from the
 * market to a hand or pile, and new ones fade in. Nothing in the engine changes.
 */
function flipFirst() {
  if (reduceMotion()) return null;
  const at = new Map();
  for (const n of app.querySelectorAll("[data-key]")) at.set(n.dataset.key, n.getBoundingClientRect());
  return at;
}
function flipLast(at) {
  if (!at || !at.size) return;
  for (const n of app.querySelectorAll("[data-key]")) {
    const was = at.get(n.dataset.key);
    if (!was) { if (n.classList.contains("card")) n.classList.add("enter"); continue; }
    const now = n.getBoundingClientRect();
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.7,.2,1)" });
  }
}

/** Zoom and pan on the map: buttons, Ctrl+wheel, drag when zoomed, pinch on touch. */
let zoom = { k: 1, cx: 0.5, cy: 0.5 };
function attachZoom(svg) {
  const base = svg.getAttribute("viewBox").split(" ").map(Number);
  const apply = () => {
    zoom.k = Math.max(1, Math.min(3.5, zoom.k));
    zoom.cx = Math.max(0, Math.min(1, zoom.cx)); zoom.cy = Math.max(0, Math.min(1, zoom.cy));
    const [x, y, w, hh] = base, W = w / zoom.k, H = hh / zoom.k;
    svg.setAttribute("viewBox", `${x + (w - W) * zoom.cx} ${y + (hh - H) * zoom.cy} ${W} ${H}`);
    svg.classList.toggle("zoomed", zoom.k > 1.01);
  };
  apply();
  const by = (f) => { zoom.k *= f; apply(); };
  const pts = new Map();
  let start = null, moved = false;
  svg.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    start = { k: zoom.k, cx: zoom.cx, cy: zoom.cy, x: e.clientX, y: e.clientY, d: pts.size === 2 ? dist() : 0 };
    moved = false;
  });
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  svg.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2 && start.d) { zoom.k = start.k * dist() / start.d; moved = true; apply(); return; }
    if (zoom.k <= 1.01) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true;
    const rect = svg.getBoundingClientRect(), [, , w, hh] = base;
    zoom.cx = start.cx - dx / rect.width * (w / zoom.k) / (w - w / zoom.k);
    zoom.cy = start.cy - dy / rect.height * (hh / zoom.k) / (hh - hh / zoom.k);
    apply();
  });
  const up = (e) => { pts.delete(e.pointerId); if (!pts.size) start = null; };
  svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", up);
  svg.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
  svg.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    zoom.cx = (e.clientX - rect.left) / rect.width; zoom.cy = (e.clientY - rect.top) / rect.height;
    by(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  return h("div", { class: "zoom-ctl" },
    h("button", { class: "ghost", title: "Zoom in (or Ctrl + scroll; pinch on touch)", onclick: () => by(1.3) }, "+"),
    h("button", { class: "ghost", title: "Zoom out", onclick: () => by(1 / 1.3) }, "−"),
    h("button", { class: "ghost", title: "The whole map", onclick: () => { zoom = { k: 1, cx: .5, cy: .5 }; apply(); } }, "⤢"));
}

/** The tides as events: a banner across the map when one turns. */
let lastTide = null, lastTideGame = null;
const TIDE_WORDS = {
  2: ["The tide reaches the meadows", "The inland wakes: canals may cross it, buildings rise there, and the meadow animals come to market."],
  3: ["The tide reaches the highland", "The springs are in sight: your own animals may dig the high ground now."],
};
function tideBanner() {
  const game = `${state.config.seed}|${state.players.map((p) => p.name).join(",")}`;
  const tide = state.tide || 1;
  if (lastTideGame === game && lastTide !== null && tide > lastTide && TIDE_WORDS[tide]) {
    const [t, sub] = TIDE_WORDS[tide];
    const b = h("div", { class: "tide-banner" }, h("b", {}, t), h("span", {}, sub));
    document.querySelector(".board-wrap")?.append(b);
    setTimeout(() => b.classList.add("out"), 3200);
    setTimeout(() => b.remove(), 3800);
    sound("tide");
  }
  lastTide = tide; lastTideGame = game;
}

/** Small sounds, off unless chosen in Settings: water for a dig, wood for a build, a bell for a tide. */
let audio = null;
function sound(kind) {
  if (!kind || !store.get("canals.sound")) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    const spec = { dig: ["sine", 320, 180, .18], build: ["triangle", 180, 140, .12], tide: ["sine", 660, 660, .9], buy: ["sine", 520, 700, .12] }[kind];
    if (!spec) return;
    o.type = spec[0]; o.frequency.setValueAtTime(spec[1], t); o.frequency.exponentialRampToValueAtTime(spec[2], t + spec[3]);
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + spec[3]);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + spec[3] + .05);
  } catch { /* no audio */ }
}

// --------------------------------------------------------------------------- //
// The game screen's parts (docs/state-of-play.md 5.2-5.4)
// --------------------------------------------------------------------------- //

/** A number that counts up (or down) from the value it showed last time, under the same key. */
const shown = new Map();
function count(n, key) {
  const span = h("span", { class: "count" }, String(n));
  const was = shown.get(key);
  shown.set(key, n);
  if (was === undefined || was === n || reduceMotion()) return span;
  span.classList.add(n > was ? "up" : "down");
  const t0 = performance.now(), dur = Math.min(600, 120 + 60 * Math.abs(n - was));
  const step = (t) => {
    const f = Math.min(1, (t - t0) / dur);
    span.textContent = String(Math.round(was + (n - was) * (1 - (1 - f) ** 3)));
    if (f < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return span;
}
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches || store.get("canals.motion") === false;

/** "Dug 2 canals, built a Wharf" for player i's last turn. */
function lastTurnSummary(i) {
  const rec = [...(state.history || [])].reverse().find((r) => r.player === i);
  if (!rec) return null;
  const n = (t) => rec.actions.filter((a) => a.type === t);
  const bits = [];
  if (rec.card) bits.push(`played ${displayName(state.defs[rec.card] || { name: rec.card, role: "special" })}`);
  if (n("dig").length) bits.push(`dug ${n("dig").length} canal${n("dig").length > 1 ? "s" : ""}`);
  for (const b of n("build")) bits.push(`built a ${rename(state.buildingTypes.find((x) => x.id === b.building)?.name || "building")}`);
  for (const b of n("buy")) bits.push(`bought ${state.defs[b.card]?.name || "a card"}`);
  const f = n("forage")[0];
  if (f) bits.push(`foraged ${f.money} money`);
  return { rec, text: bits.join(", ") || "passed" };
}
function lastTurnLine(i) {
  const x = lastTurnSummary(i);
  if (!x) return null;
  const hexes = x.rec.actions.flatMap((a) => (a.type === "dig" ? a.edge.split("|") : a.type === "build" ? [a.hex] : []));
  return h("div", { class: "last-turn", onmouseenter: () => flashHexes(hexes), onmouseleave: () => flashHexes([]) }, "Last turn: ", x.text, ".");
}
function flashHexes(keys) {
  for (const n of document.querySelectorAll(".hex.flash")) n.classList.remove("flash");
  for (const k of keys) document.querySelector(`.hex[data-hex="${CSS.escape(k)}"]`)?.classList.add("flash");
}

/** The scoring wheel: four currents, each its multiplier × its score, filling as the game goes. */
function scoreWheel(sc, size = 120, pi = null) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "-50 -50 100 100");
  svg.setAttribute("class", "wheel");
  svg.setAttribute("width", size); svg.setAttribute("height", size);
  const el = (tag, attrs, parent = svg) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); parent.append(n); return n; };
  const COL = { dig: "var(--brown)", build: "var(--green)", buy: "var(--blue)", special: "var(--purple)" };
  const top = Math.max(30, ...sc.lanes.map((l) => l.total));
  sc.lanes.forEach((l, k) => {
    const a0 = (k * 90 - 90 + 3) * Math.PI / 180, a1 = ((k + 1) * 90 - 90 - 3) * Math.PI / 180;
    const r0 = 14, rMax = 46, r = r0 + (rMax - r0) * Math.min(1, l.total / top);
    const arc = (rr) => `M ${r0 * Math.cos(a0)} ${r0 * Math.sin(a0)} L ${rr * Math.cos(a0)} ${rr * Math.sin(a0)} A ${rr} ${rr} 0 0 1 ${rr * Math.cos(a1)} ${rr * Math.sin(a1)} L ${r0 * Math.cos(a1)} ${r0 * Math.sin(a1)} A ${r0} ${r0} 0 0 0 ${r0 * Math.cos(a0)} ${r0 * Math.sin(a0)} Z`;
    el("path", { d: arc(rMax), fill: COL[l.mult], opacity: .16 });
    el("path", { d: arc(r), fill: COL[l.mult], class: "wheel-fill" });
    const am = (a0 + a1) / 2, tx = 31 * Math.cos(am), ty = 31 * Math.sin(am);
    const t = el("text", { x: tx, y: ty + 3.5, "text-anchor": "middle", class: "wheel-num" });
    t.textContent = l.total;
    const cur = CURRENTS[l.mult];
    const tip = el("title", {}, t);
    tip.textContent = `${cur.name}: ${l.m} × ${l.s} ${cur.what} = ${l.total} (${cur.desc}; ${sc.counts[l.mult]} cards counted)`;
  });
  el("circle", { r: 12.5, class: "wheel-hub" });
  const c = el("text", { y: 4.5, "text-anchor": "middle", class: "wheel-total" });
  c.textContent = sc.total;
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Score ${sc.total}: ` + sc.lanes.map((l) => `${CURRENTS[l.mult].name} ${l.m}×${l.s}`).join(", "));
  return svg;
}

/** My stats with labels, the wheel with its currents spelled out, and my lodge. */
function myPanel(me, vi) {
  const cfg = state.config, sc = E.score(state, vi);
  const item = (ic, label, val, title) => h("div", { class: "stat", title: title || null }, icon(ic), h("span", { class: "stat-label" }, label), h("b", {}, val));
  const stats = h("div", { class: "my-stats" },
    item("i-coin", "Money", count(me.money, `money-${vi}`)),
    item("i-income", "Income", me.income, "An Earn card collects your income"),
    cfg.pearls ? item("i-pearl", "Pearls", h("span", {}, me.pearls || 0, h("small", { class: "track" }, ` · track ${me.pearlTrack || 0}/${E.pearlNeed(state, me)}`)),
      "Each card you keep in hand at the end of your turn moves your pearl track a step; a full track gives a pearl. Spend pearls in the pearl menu.") : null,
    item("i-hand", "Hand", me.handSize, "Cards you draw up to at the end of a turn"),
    item("i-key", "Friendships", me.keys, "One for each spring village you build in (two in the highland)"),
    item("i-reach", "Open water", E.reach(state, vi), "Hexes your canals have opened"),
    item("i-deck", "Deck", `${me.draw.length} to draw · ${me.discard.length} discarded`));
  const lanes = h("div", { class: "currents" }, sc.lanes.map((l) => {
    const next = E.nextStep(cfg, sc.counts[l.mult]);
    return h("div", { class: `current c-${ROLES[l.mult].colour}`, title: CURRENTS[l.mult].desc },
      icon(ROLE_ICON[l.mult]), h("span", {}, CURRENTS[l.mult].name),
      h("span", { class: "muted" }, ` ×${l.m} · ${l.s} ${CURRENTS[l.mult].what}`),
      h("b", {}, ` ${l.total}`),
      next ? h("small", { class: "muted" }, ` (×${next.m} at ${next.at} card${next.at === 1 ? "" : "s"})`) : null);
  }));
  const extra = h("details", { class: "my-score", open: store.get("canals.myScore") !== false || null, ontoggle: (e) => store.set("canals.myScore", e.target.open) },
    h("summary", {}, "Score and lodge"),
    h("div", { class: "player-row" }, scoreWheel(sc, 132, vi), lanes),
    E.techOn(state) ? lodgeView(vi) : null,
    prizeView());
  return { stats, extra };
}

/** The lodge, large: the honeycomb and its crafts, with what is yours and what you can reach. */
function lodgeView(pi) {
  const p = state.players[pi], taken = new Set(p.taken || []);
  const level = E.techLevel(state);
  const rows = state.tech.slots.filter((x) => level >= (x.ring === "inner" ? 1 : 2)).map((x) => {
    const mine = taken.has(x.id), near = !mine && E.slotReachable(state, pi, x.id);
    return h("li", { class: mine ? "mine" : near ? "near" : "" },
      h("b", {}, rename(x.name)), " ", h("span", { class: "muted" }, mine ? "(yours) " : near ? "(can build) " : ""), x.text);
  });
  return h("div", { class: "lodge" },
    h("h3", {}, `${W.Lodge} `, h("span", { class: "muted" }, "— each building you place empties a slot: you gain its income and its craft")),
    h("div", { class: "lodge-row" }, renderTechBoard(state, pi, 22), h("ul", { class: "crafts" }, rows)),
    Object.keys(state.capstones || {}).length || E.tideNow(state) >= 3
      ? h("p", { class: "hint" }, "Masteries: ", Object.entries(E.CAPSTONES).map(([k, c]) => h("span", { class: "pill", title: c.text },
        rename(c.name), state.capstones?.[k] !== undefined ? ` · ${state.players[state.capstones[k]].name}` : ""))) : null);
}

/** First-act prizes: who holds which, while they can be won. */
function prizeView() {
  const list = E.prizeList ? E.prizeList(state) : [];
  if (!list.length) return null;
  const open = E.prizesOpen(state);
  return h("div", { class: "prizes" }, h("h3", {}, "Prizes of the coast ", h("span", { class: "muted" }, open ? "— won only before the meadows open" : "— closed")),
    h("div", { class: "row wrap" }, list.map((x) => {
      const who = state.prizes?.[x.id];
      return h("span", { class: "pill" + (who !== undefined ? " won" : ""), title: x.code },
        x.name, who !== undefined ? ` · ${state.players[who].name}` : open ? " · open" : "");
    })));
}

/** One line that says what to do now, in the same place every time; a guide for a first game. */
function promptBar(acting, p) {
  const t = state.turn;
  let text, guide = null;
  if (!acting) text = p.ai ? `${p.name} is playing…` : `Waiting for ${p.name}…`;
  else if (t.phase === "harbour") { text = "Choose your harbour: click a ringed harbour on the map."; guide = "Your canals begin at your harbour. A deep harbour reaches the meadows sooner, and costs some of your starting money."; }
  else if (t.phase === "startTech") { text = "Choose your starting craft."; guide = "Your lodge holds crafts: lasting abilities. Each building you place later empties a lodge slot and gives you its craft and income. This one is free."; }
  else if (t.phase === "choose") {
    text = sel.play === null ? "Choose a card to play." : "Boost it? Click other cards to discard them, then press Play.";
    guide = sel.play === null
      ? "Each turn you play one card. Cards you keep in hand move your pearl track; a full track gives a pearl. No good card? Forage: discard for money."
      : "A boost is the line after 'Discard': discard that many other cards for the extra. Or play it plain.";
  } else {
    const pool = t.pool, todo = [];
    if (pool.dig > 0) todo.push(`click a dashed border to dig (${pool.dig} left)`);
    if (pool.build > 0) todo.push(`click a highlighted hex to build (${pool.build} left)`);
    if (pool.buy > 0) todo.push(`click a market card to buy (${pool.buy} left)`);
    if ((pool.trashAny || 0) + (pool.trashHand || 0) + (pool.trashDiscard || 0) > 0) todo.push("click a card to remove it from your deck");
    text = todo.length ? cap(todo.join("; ")) + ". Then End turn." : "Nothing left to do: End turn.";
    guide = pool.dig > 0 ? "Canals start at your harbour's mouth and must join the water. Every hex your canals open is open water: points for your Open water current."
      : pool.build > 0 ? "Build where one of your own canals runs. A building scores, and empties a lodge slot: you gain its income and craft."
      : pool.buy > 0 ? "A bought card goes to your discard pile: you'll draw it in a later turn."
      : "Your hand refills at the end of the turn.";
  }
  const guiding = acting && guideOn();
  return h("div", { class: "prompt-bar", role: "status", "aria-live": "polite" },
    h("div", { class: "prompt-main" }, crest(p, state.current), h("span", {}, text)),
    guiding && guide ? h("div", { class: "guide" }, h("span", { class: "guide-tag" }, "Guide"), guide,
      h("button", { class: "ghost small-btn", onclick: () => { store.set("canals.guided", true); renderGame(); } }, "Hide the guide")) : null);
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** The guide shows for a player's first game: until they hide it, or their sixth turn. */
function guideOn() {
  if (store.get("canals.guided")) return false;
  const pi = state.current;
  return (state.history || []).filter((r) => r.player === pi).length < 6;
}

/** Settings: codes on cards, motion, sound, theme. */
function settingsMenu() {
  const flip = (k, v) => { store.set(k, v); renderGame(); };
  return h("details", { class: "settings" }, h("summary", { class: "ghost-btn" }, "Settings"),
    h("div", { class: "settings-box" },
      h("label", { class: "row" }, h("input", { type: "checkbox", checked: showCodes || null, onchange: (e) => { showCodes = e.target.checked; store.set("canals.codes", showCodes); renderGame(); } }), "Show card codes (D2: +1D)"),
      h("label", { class: "row" }, h("input", { type: "checkbox", checked: store.get("canals.motion") !== false || null, onchange: (e) => flip("canals.motion", e.target.checked) }), "Animations"),
      h("label", { class: "row" }, h("input", { type: "checkbox", checked: !!store.get("canals.sound") || null, onchange: (e) => flip("canals.sound", e.target.checked) }), "Sound"),
      h("label", { class: "row" }, h("input", { type: "checkbox", checked: !store.get("canals.guided") || null, onchange: (e) => flip("canals.guided", !e.target.checked) }), "First-game guide"),
      h("div", { class: "row" },
        h("button", { class: "ghost small-btn", onclick: () => download(`canals-game-r${state.round}.json`, JSON.stringify(state)) }, "Save game"),
        net.role === "guest" ? null : h("button", { class: "ghost small-btn", onclick: async () => { const t = await pickFile(".json"); if (t) resume(JSON.parse(t)); } }, "Load game")),
      h("button", { class: "ghost small-btn", onclick: () => markConfusing() }, "This confused me…")));
}

/** End turn, asking once when actions would go unused. */
function endTurnButton(pool) {
  const left = ["dig", "build", "buy"].filter((k) => pool[k] > 0).map((k) => `${pool[k]} ${k}`);
  if (!left.length) return h("button", { class: "primary", onclick: () => act({ type: "end" }) }, "End turn");
  const b = confirmButton("End turn", `Leave ${left.join(", ")} unused? Click again`, () => act({ type: "end" }));
  b.classList.remove("ghost"); b.classList.add("primary");
  return b;
}

/** "Inland closed: 3 of 8 canals bordering inland hexes." */
function milestoneLine() {
  const { have, need, what } = E.milestoneProgress(state);
  const reward = state.config.milestoneReward;
  return [h("b", {}, "Inland closed"), ` until ${need} ${what}: ${have} of ${need} so far. Then canals with inland on both sides, building inland, and the inland cards open${reward ? `, and the player whose dig reaches it takes ${reward}` : ""}.`];
}

/** Pearl menu while resolving: cash in, redraw a hand card, or one more action. */
function pearlMenu(p) {
  const cfg = state.config;
  if (!cfg.pearls) return null;
  const n = p.pearls || 0;
  const role = state.turn.played ? E.def(state, state.turn.played).role : null;
  const actionOk = ["dig", "build", "buy"].includes(role) && n >= cfg.pearlActionCost;
  const btn = (label, ok, title, onclick) => h("button", { class: "ghost", disabled: !ok || null, title, onclick }, label);
  return h("div", { class: "row wrap pearls" },
    h("span", { class: "muted" }, icon("i-pearl"), ` Pearls ${n}: `),
    btn(`1 → +${E.hasTech(state, state.current, "lustre") ? Math.max(3, cfg.pearlMoney + 1) : cfg.pearlMoney} money`, n >= 1, "Cash in a pearl", () => act({ type: "pearl", kind: "money" })),
    btn(redrawing ? "click a hand card…" : "1 → redraw a card", n >= 1 && p.hand.length > 0, "Put a hand card on your discard pile and draw one",
      () => { redrawing = !redrawing; renderGame(); }),
    btn(`${cfg.pearlActionCost} → +1 ${role && ["dig", "build", "buy"].includes(role) ? role : "action"}`, actionOk,
      "One more action of the played card's kind, at full cost", () => act({ type: "pearl", kind: "action" })),
    E.hasTech(state, state.current, "secondwind") ? btn("3 → play a second card", n >= 3 && p.hand.length > 0 && !state.turn.secondWindUsed,
      "Second wind: play another card from your hand this turn; its actions add to what you have left", () => act({ type: "pearl", kind: "secondwind" })) : null,
    E.hasTech(state, state.current, "reserve") ? h("span", { class: "muted" }, " · Reserve: see the market") : null,
    h("span", { class: "muted" }, cfg.pearlEarning === "track"
      ? ` · pearl track ${p.pearlTrack || 0}/${E.pearlNeed(state, p)}: each card left in your hand at the end of the turn moves it a space${n >= E.pearlCapOf(state, p) ? " (at the cap, it waits full)" : ""}`
      : n < E.pearlCapOf(state, p) ? " · end this turn without having discarded to bank one" : " · at the cap"));
}

function buildingPicker(p) {
  return h("div", { class: "picker" }, state.buildingTypes.map((bt) => {
    const used = E.builtCount(state, state.current, bt.id);
    const out = bt.supply && used >= bt.supply;
    return h("button", {
      class: "bt" + (bt.id === buildType ? " on" : ""), disabled: out || null, title: bt.rules,
      onclick: () => { buildType = bt.id; renderGame(); },
    }, h("b", {}, icon(hasSymbol(`b-${bt.id}`) ? `b-${bt.id}` : "b-plain", "", null, state.players[state.current].colour), ` ${bt.name}`),
      h("span", { class: "muted" }, [bt.extraCost ? `+${bt.extraCost} cost` : "", bt.supply ? `${bt.supply - used} left` : ""].filter(Boolean).join(" · ")),
      h("small", {}, (state.config.materials && bt.needs.length ? `Needs ${bt.needs.join(" + ")}. ` : "") + bt.rules));
  }));
}

// --------------------------------------------------------------------------- //
// Online play (net.js, commands.js)
// --------------------------------------------------------------------------- //
//
// One device hosts: it holds the game, runs the computers, and applies every
// move. Seats are "human" (played on the host's device, hot-seat style),
// "remote" (an online player on their own device), or a computer. Guests send
// moves; the host checks the move is from the seat whose turn it is (the
// engine checks it is legal) and sends everyone the new state.

let net = { role: "local" };
//   host:  { role, code, table, claims: [{ token, name, conn } per seat], started, status }
//   guest: { role, code, name, link, mySeat, connected, status, lobby, seats, undoable }

/** A random id for this browser, so a player who reloads gets their seat back. */
function browserToken() {
  let t = store.get("canals.token");
  if (!t) { t = makeCode(12); store.set("canals.token", t); }
  return t;
}

/** Does this device move for seat i? */
function canMove(i) {
  const pl = state.players[i];
  if (!pl || pl.ai) return false;
  if (net.role === "guest") return i === net.mySeat;
  return !pl.remote;
}
/** Seats this device plays (for the pass-the-device screen). */
function localSeats() { return state.players.map((_, i) => i).filter(canMove); }
/** Whose hand this device shows: the seat to move if it's ours, else our own seat. */
function viewerSeat() {
  if (canMove(state.current)) return state.current;
  if (net.role === "guest") return net.mySeat ?? null;
  const mine = state.players.map((_, i) => i).filter((i) => !state.players[i].ai && !state.players[i].remote);
  return mine.length === 1 ? mine[0] : null;
}

/** "host" (plays on the host's device), "online", "away", "computer", or null offline. */
function seatStatus(i) {
  if (net.role === "local") return null;
  if (net.role === "guest") return net.seats?.[i]?.control ?? null;
  const pl = state.players[i];
  return pl.ai ? "computer" : pl.remote ? (net.claims[i]?.conn ? "online" : "away") : "host";
}
function seatBadge(i) {
  const st = seatStatus(i);
  if (!st || st === "computer") return null;
  const you = net.role === "guest" ? i === net.mySeat : st === "host";
  const label = { host: "at the host", online: "online", away: "not connected" }[st];
  return h("span", { class: `seat-badge ${st}` }, you ? "you" : label);
}

/** The table code and invite link, in the game header. */
function tableBadge() {
  if (net.role === "local") return null;
  if (net.role === "guest") return h("span", { class: `table-badge${net.connected ? "" : " off"}` }, `Online · table ${net.code}`);
  return h("button", { class: "ghost table-badge", title: "Copy the invite link", onclick: () => copyInvite() }, `Table ${net.code} · invite`);
}
/** A banner when the connection is down or the host has news. */
function netBanner() {
  if (net.role === "guest" && (!net.connected || net.status)) return h("p", { class: "net-banner" }, net.status || "Not connected to the host.");
  if (net.role === "host" && net.status) return h("p", { class: "net-banner" }, net.status);
  return null;
}

function copyInvite() {
  const link = shareLink(net.code);
  navigator.clipboard?.writeText(link).then(() => toast("Invite link copied"), () => showExport("invite-link.txt", link))
    ?? showExport("invite-link.txt", link);
}

// --- hosting ---------------------------------------------------------------

/** Open this device's table so others can join; resolves false if it couldn't. */
async function openTable(code = makeCode(), claims = []) {
  if (net.role === "host") return true;
  if (net.role === "guest") leaveTable();
  net = { role: "host", code, table: null, claims, started: false, status: "Opening the table…" };
  refreshOnline();
  try {
    net.table = await hostTable(code, {
      onConnect: () => {},
      onMessage: hostMessage,
      onDisconnect: (conn) => {
        const i = net.claims.findIndex((c) => c?.conn === conn);
        if (i >= 0) { net.claims[i].conn = null; toast(`${net.claims[i].name} left`); }
        afterNetChange();
      },
      onStatus: (t) => { net.status = t; refreshOnline(); },
    });
  } catch (err) {
    net = { role: "local" };
    toast(err.message || String(err));
    refreshOnline();
    return false;
  }
  net.status = "";
  saveHosting();
  refreshOnline();
  return true;
}

function closeTable() {
  if (net.role !== "host") return;
  const table = net.table;
  table?.broadcast(() => ({ t: "bye", msg: "The host closed the table." }));
  net = { role: "local" };
  store.del("canals.hosting");
  setTimeout(() => table?.close(), 300);   // let the goodbye go out first
  document.title = "Canals";
}

function saveHosting() {
  if (net.role !== "host") return;
  store.set("canals.hosting", { code: net.code, claims: net.claims.map((c) => (c ? { token: c.token, name: c.name } : null)) });
}

/** Quick start: you, plus an online seat for a friend, and the table open. */
async function hostQuick() {
  if (!setup.seats.includes("remote")) {
    // Others will see this seat's name, so "You" won't do.
    const mine = /^you$/i.test(setup.players[0] || "") ? (store.get("canals.name") || "Host") : setup.players[0];
    setup.players = [mine, "Friend"];
    setup.seats = ["human", "remote"];
  }
  saveSetup();
  if (await openTable()) refreshSeats();
}

function removeSeat(i) {
  setup.players.splice(i, 1);
  setup.seats.splice(i, 1);
  if (net.role === "host") {
    const [gone] = net.claims.splice(i, 1);
    if (gone?.conn) net.table.send(gone.conn, { t: "welcome", seat: null, code: net.code });
    saveHosting();
  }
}

const inGame = () => net.role === "host" && net.started && state && app.querySelector(".game, .end");
const seatOfConn = (conn) => net.claims.findIndex((c) => c?.conn === conn);

function hostMessage(conn, msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "hello") return hostHello(conn, msg);
  if (msg.t === "cmd") {
    const seat = seatOfConn(conn);
    const no = (why) => net.table.send(conn, { t: "error", msg: why });
    if (!inGame() || !state || state.over) return no("The game hasn't started.");
    if (seat < 0 || seat !== state.current || state.players[seat].ai || !state.players[seat].remote) return no("It's not your turn.");
    const res = applyMove(msg.cmd);
    if (!res.ok) return no(res.reason);
    afterMove(res.ended);
  }
}

function hostHello(conn, msg) {
  const name = String(msg.name || "").trim().slice(0, 24) || "Guest";
  const token = String(msg.token || "").slice(0, 40);
  let seat = net.claims.findIndex((c) => c && c.token === token);
  if (seat < 0) {
    if (inGame()) {
      // Mid-game: take an online seat nobody is connected to.
      seat = state.players.findIndex((pl, i) => pl.remote && !net.claims[i]?.conn);
    } else {
      seat = setup.seats.findIndex((x, i) => x === "remote" && !net.claims[i]?.conn);
      if (seat < 0 && setup.players.length < 5) {
        setup.players.push(name); setup.seats.push("remote"); seat = setup.players.length - 1;
      }
    }
  }
  if (seat >= 0) {
    const old = net.claims[seat]?.conn;
    if (old && old !== conn) old.close();
    net.claims[seat] = { token, name, conn };
    if (inGame()) {
      const pl = state.players[seat];
      if (pl.takenOver) { pl.ai = null; delete pl.takenOver; toast(`${name} is back; the computer hands ${pl.name}'s seat back`); persist(); }
    } else {
      setup.players[seat] = name;
      saveSetup();
    }
    toast(`${name} joined`);
  } else toast(`${name} is watching: every seat is taken`);
  net.table.send(conn, { t: "welcome", seat: seat >= 0 ? seat : null, code: net.code });
  saveHosting();
  afterNetChange();
}

/** After someone joins or leaves: tell everyone, and redraw here. */
function afterNetChange() {
  if (net.role !== "host") return;
  if (inGame()) { pushState(); if (state.over) renderEnd(); else renderGame(); }
  else { pushLobby(); refreshOnline(); }
}

function seatInfo() {
  return state.players.map((pl, i) => ({ control: seatStatus(i), who: net.claims[i]?.name || null }));
}

/** Send the game to every guest (host only). */
function pushState() {
  if (net.role !== "host" || !net.table || !state) return;
  const seats = seatInfo(), undoable = undo.length > 0;
  net.table.broadcast((conn) => ({ t: "state", state, you: (() => { const i = seatOfConn(conn); return i >= 0 ? i : null; })(), seats, undoable }));
}

/** Send the seats to every guest while the host is still setting up (host only). */
function pushLobby() {
  if (net.role !== "host" || !net.table || inGame()) return;
  const seats = setup.players.map((name, i) => ({ name, type: setup.seats[i], connected: !!net.claims[i]?.conn }));
  net.table.broadcast((conn) => ({ t: "lobby", seats, you: (() => { const i = seatOfConn(conn); return i >= 0 ? i : null; })(), code: net.code, setup }));
}

/** Let the computer play an absent online player's seat until they rejoin. */
function takeOver(i) {
  const pl = state.players[i];
  if (net.role !== "host" || !pl?.remote || pl.ai) return;
  pl.ai = "greedy";
  pl.takenOver = true;
  persist();
  pushState();
  renderGame();
}

/** Redraw whatever online status is on screen. */
function refreshOnline() {
  if (app.querySelector(".game") && state) renderGame();
  else if (app.querySelector(".setup")) refreshSeats();
  else if (app.querySelector(".lobby")) renderGuestLobby();
}

// --- the setup screen's online panel ---------------------------------------

function lobbySeatNote(i) {
  if (net.role !== "host") return h("span", { class: "seat-badge away" }, "open the table below");
  const c = net.claims[i];
  return c?.conn ? h("span", { class: "seat-badge online" }, `${c.name} is here`) : h("span", { class: "seat-badge away" }, "waiting for someone to join");
}

function onlinePanel() {
  if (net.role === "host") {
    const link = shareLink(net.code);
    const here = net.claims.filter((c) => c?.conn).length;
    return h("div", { class: "online-panel" },
      h("h3", {}, "Online table ", h("b", { class: "code" }, net.code)),
      net.status ? h("p", { class: "warn" }, net.status) : null,
      h("p", {}, "Send this link to the other players. They open it, type a name, and take the next online seat (a new one is added while there are fewer than five).",
        " With a seat set to ", h("b", {}, "Human, this device"), " you play here; online seats wait for their players. Others see your seat's name, so make it yours."),
      h("div", { class: "row wrap" }, h("input", { class: "invite", value: link, readonly: true, onclick: (e) => e.target.select() }),
        h("button", { onclick: copyInvite }, "Copy invite link")),
      h("p", { class: "hint" }, here ? `${here} player${here === 1 ? "" : "s"} connected.` : "Nobody has joined yet.",
        " Players can also join after the game starts, into an online seat."),
      h("div", { class: "row" }, confirmButton("Close the table", "Close it? Click again", () => { closeTable(); refreshSeats(); })));
  }
  const code = h("input", { class: "code-input", placeholder: "Table code", maxlength: 8, "aria-label": "Table code" });
  const name = h("input", { placeholder: "Your name", value: store.get("canals.name") || "", maxlength: 24, "aria-label": "Your name" });
  return h("div", { class: "online-panel" },
    h("h3", {}, "Play online"),
    h("p", { class: "hint" }, "Each player on their own device. Set seats to ", h("b", {}, "Online player"), ", or use the quick start, then open the table and share its link."),
    h("div", { class: "row wrap" },
      h("button", { onclick: async () => { if (!setup.seats.includes("remote")) { setup.seats.push("remote"); setup.players.push("Friend"); saveSetup(); } if (await openTable()) refreshSeats(); } }, "Open a table"),
      h("span", { class: "muted" }, "or join one:"), code, name,
      h("button", { onclick: () => {
        const c = cleanCode(code.value);
        if (c.length < 4) return toast("Type the table code");
        joinGame(c, name.value.trim() || "Guest");
      } }, "Join")));
}

// --- joining -----------------------------------------------------------------

/** The page a guest lands on from an invite link: ask their name, then join. */
function renderJoin(code) {
  stopAi();
  const name = h("input", { value: store.get("canals.name") || "", placeholder: "Your name", maxlength: 24, "aria-label": "Your name" });
  const go = () => joinGame(code, name.value.trim() || "Guest");
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  app.replaceChildren(h("div", { class: "setup lobby" },
    h("header", { class: "top" }, brand("Canals"), rulesButton()),
    h("section", {}, h("h2", {}, "Join table ", h("b", { class: "code" }, code)),
      h("p", {}, "You've been invited to an online game. Pick a name the others will see."),
      h("div", { class: "row wrap" }, name, h("button", { class: "primary", onclick: go }, "Join the table")),
      h("p", { class: "hint" }, "New to the game? Read ", h("a", { href: "#rules", onclick: (e) => { e.preventDefault(); openRules(); } }, "How to play"), " while you wait."),
      shareNotice(),
      h("div", { class: "row" }, h("button", { class: "ghost", onclick: () => { history.replaceState(null, "", location.pathname + location.search); renderHome(); } }, "Back")))));
  name.focus();
}

async function joinGame(code, name) {
  if (net.role === "host") closeTable();
  if (net.role === "guest") leaveTable(false);
  store.set("canals.name", name);
  stopAi();
  state = null;
  net = { role: "guest", code, name, link: null, mySeat: null, connected: false, status: "Connecting…", lobby: null, seats: [], undoable: false };
  if (location.hash !== `#join=${code}`) history.replaceState(null, "", `#join=${code}`);
  renderGuestLobby();
  try {
    net.link = await joinTable(code, {
      onOpen: () => { net.connected = true; net.status = ""; net.link?.send({ t: "hello", name, token: browserToken() }); refreshOnline(); },
      onMessage: guestMessage,
      onClose: () => { net.connected = false; refreshOnline(); },
      onStatus: (t) => { net.status = t; refreshOnline(); },
    });
  } catch (err) {
    net.status = err.message || String(err);
    refreshOnline();
  }
}

function guestMessage(msg) {
  if (!msg || typeof msg !== "object" || net.role !== "guest") return;
  if (msg.t === "welcome") { net.mySeat = msg.seat; return refreshOnline(); }
  if (msg.t === "lobby") {
    net.lobby = msg; net.mySeat = msg.you;
    if (state) { state = null; stopAi(); }       // the host went back to setup
    return renderGuestLobby();
  }
  if (msg.t === "state") {
    const before = state;
    state = msg.state; net.mySeat = msg.you; net.seats = msg.seats || []; net.undoable = !!msg.undoable;
    const turned = !before || before.current !== state.current || before.round !== state.round;
    if (turned) { sel = { play: null, discards: new Set() }; redrawing = false; }
    if (state.over) { if (!before?.over) keepFinished(state); return renderEnd(); }
    return renderGame(turned && canMove(state.current));
  }
  if (msg.t === "error") return toast(msg.msg);
  if (msg.t === "bye") { toast(msg.msg || "The host closed the table."); leaveTable(); }
}

/** Leave an online game (guest), back to the setup screen. */
function leaveTable(show = true) {
  if (net.role !== "guest") return;
  net.link?.close();
  net = { role: "local" };
  state = null;
  document.title = "Canals";
  if (show) { history.replaceState(null, "", location.pathname + location.search); renderHome(); }
}

/** A guest's view before the game starts: who is at the table. */
function renderGuestLobby() {
  const seats = net.lobby?.seats || [];
  const TYPE = { human: "at the host's device", remote: "online", greedy: "computer", random: "computer (random)" };
  app.replaceChildren(h("div", { class: "setup lobby" },
    h("header", { class: "top" }, brand("Canals"), h("div", { class: "row wrap" }, rulesButton(),
      confirmButton("Leave", "Leave? Click again", leaveTable))),
    h("section", {}, h("h2", {}, "Table ", h("b", { class: "code" }, net.code)),
      net.status ? h("p", { class: "warn" }, net.status) : null,
      !net.connected ? h("p", { class: "thinking" }, "Connecting to the host… ") : null,
      net.connected && !net.lobby ? h("p", { class: "thinking" }, "Joining… ") : null,
      seats.length ? h("div", { class: "lobby-seats" }, seats.map((sx, i) => h("div", { class: "lobby-seat" + (i === net.mySeat ? " you" : "") },
        crest({ colour: E.PLAYER_COLOURS[i] }, i), h("b", {}, sx.name),
        h("span", { class: "muted" }, i === net.mySeat ? " · you" : sx.type === "remote" ? (sx.connected ? " · online" : " · waiting to join") : ` · ${TYPE[sx.type] || sx.type}`)))) : null,
      net.lobby ? h("p", {}, net.mySeat === null ? "Every seat is taken, so you'll watch. " : "", "Waiting for the host to start the game.") : null,
      h("p", { class: "hint" }, "Meanwhile: ", h("a", { href: "#rules", onclick: (e) => { e.preventDefault(); openRules(); } }, "How to play"), "."))));
}

// --------------------------------------------------------------------------- //
// End screen
// --------------------------------------------------------------------------- //

function report() {
  return {
    id: state.reportId || null,
    finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : null,
    mode: state.players.some((p) => p.remote) ? "online" : "local",
    config: state.config,
    rounds: state.round,
    endedByCrossing: state.crossings.length > 0,
    crossings: state.crossings,
    players: state.players.map((p, i) => {
      const sc = E.score(state, i);
      const deck = {};
      for (const uid of E.ownedCards(p)) deck[state.cards[uid]] = (deck[state.cards[uid]] || 0) + 1;
      // seat: "human" (on the playing device), "online", a computer ("greedy", "random"),
      // or "online, computer covered" for an online seat the computer finished.
      const seat = p.takenOver ? "online, computer covered" : p.ai || (p.remote ? "online" : "human");
      return { name: p.name, seat, total: sc.total, money: p.money, income: p.income, reach: E.reach(state, i), keys: p.keys,
        lanes: sc.lanes, colourCounts: sc.counts, deck, stats: p.stats };
    }),
    history: state.history,
    timing: state.timing || [],
    notes: state.notes || [],
    answers: state.answers || null,
    log: state.log.map((l) => `R${l.round} ${l.msg}`),
  };
}

/** Three questions after a game, sent with its report (docs/state-of-play.md 5.2). */
function feedbackForm() {
  const a = state.answers ||= {};
  const box = h("section", { class: "feedback" });
  const choice = (key, opts) => h("div", { class: "choices" }, opts.map((o) =>
    h("button", { class: a[key] === o ? "on" : "", onclick: () => { a[key] = o; persist(); keepFinished(state); draw(); } }, o)));
  const text = (key, ph) => {
    const t = h("textarea", { rows: 2, placeholder: ph, onchange: (e) => { a[key] = e.target.value; keepFinished(state); } });
    t.value = a[key] || "";
    return t;
  };
  const draw = () => box.replaceChildren(h("h2", {}, "Three questions for the designer"),
    h("div", { class: "questions" },
      h("label", {}, h("span", {}, "How long did the game feel?"), choice("length", ["Too short", "About right", "Too long"])),
      h("label", {}, h("span", {}, "What confused you, if anything?"), text("confused", "A rule, a screen, a moment…")),
      h("label", {}, h("span", {}, "Would you play again?"), choice("again", ["Yes", "Maybe", "No"])),
      h("label", {}, h("span", {}, "Anything else?"), text("other", "Optional")),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => {
        a.sentAt = Date.now(); keepFinished(state);
        if (state.reportId) {
          const info = await siteInfo();
          const r = await submitReport({ ...report(), site: info.version, channel: info.channel, feedback: true });
          toast(r.sent ? "Thank you! Sent to the designer." : "Saved with the game's report.");
        } else toast("Saved with the game's report. Thank you!");
        draw();
      } }, a.sentAt ? "Send again" : "Send"), a.sentAt ? h("span", { class: "muted" }, "Thank you!") : null)));
  draw();
  return box;
}

function renderEnd() {
  const rank = E.ranking(state);
  const rep = report();
  const win = state.players[rank[0].i];
  const most = (f) => state.players.map((_, i) => i).reduce((a, b) => (f(b) > f(a) ? b : a));
  const opener = most((i) => E.reach(state, i)), friend = most((i) => state.players[i].keys);
  const tale = [
    state.endReason === "keys" ? "The waters reached the high springs." : state.endReason === "market" ? "The market ran dry: no animal was left to hire." : "The season ended.",
    `${state.players[opener].name} opened the most water (${E.reach(state, opener)} hexes)` +
    (state.players[friend].keys ? `, and ${state.players[friend].name} made the most friends among the springs (${state.players[friend].keys}).` : "."),
  ].join(" ");
  app.replaceChildren(h("div", { class: "setup end" },
    h("header", { class: "top" }, brand("Canals"),
      h("span", {}, `${state.round} rounds · ${END_REASON[state.endReason] || "full length"}`,
        state.finishedAt ? h("span", { class: "muted" }, ` · ${new Date(state.finishedAt).toLocaleString()}`) : null)),
    h("section", { class: "finale" },
      h("div", { class: "winner" }, crest(win, rank[0].i, "big"), h("div", {}, `${win.name} ${/^you$/i.test(win.name.trim()) ? "win" : "wins"} with ${rank[0].total} points`)),
      h("p", { class: "story" }, tale),
      h("div", { class: "podium" }, rank.map((r, k) => h("div", { class: k === 0 ? "first" : "" },
        scoreWheel(E.score(state, r.i), k === 0 ? 150 : 110, r.i), h("b", {}, `${k + 1}. ${r.name}`),
        h("span", { class: "muted" }, r.lanes.map((l) => `${CURRENTS[l.mult].name} ${l.total}`).join(" · ")))))),
    net.role === "guest" ? null : feedbackForm(),
    h("section", {}, h("h2", {}, "Scores"),
      h("table", { class: "decks" },
        h("thead", {}, h("tr", {}, h("th", {}, "Player"),
          rank[0].lanes.map((l) => h("th", {}, icon(ROLE_ICON[l.mult]), ` ${CURRENTS[l.mult].name}: ${ROLE_WORD[l.mult]} × ${CURRENTS[l.mult].what}`)), h("th", {}, "Total"), h("th", {}, "Money (tiebreak)"))),
        h("tbody", {}, rank.map((r) => h("tr", {},
          h("td", {}, crest(state.players[r.i], r.i), " ", r.name),
          r.lanes.map((l) => h("td", { class: "n" }, `${l.m} × ${l.s} = ${l.total}`)),
          h("td", { class: "n" }, h("b", {}, r.total)), h("td", { class: "n" }, r.money)))))),
    h("section", {}, h("details", {}, h("summary", {}, h("b", {}, "Playtest stats")),
      h("table", { class: "decks" },
        h("thead", {}, h("tr", {}, ["Player", "Turns", "Boosted", "Avg discards", "Digs", "Reach", "Discoveries", "Builds (by type)", "Buys", "Earns", "Trashed", "Earned", "Spent", "Final income", "Final deck", "Plays by colour"].map((t) => h("th", {}, t)))),
        h("tbody", {}, rep.players.map((p) => h("tr", {},
          h("td", {}, p.name), h("td", { class: "n" }, p.stats.turns),
          h("td", { class: "n" }, `${Math.round((100 * p.stats.boosted) / Math.max(1, p.stats.turns))}%`),
          h("td", { class: "n" }, (p.stats.discarded / Math.max(1, p.stats.turns)).toFixed(2)),
          h("td", { class: "n" }, p.stats.digs), h("td", { class: "n" }, p.reach), h("td", { class: "n" }, p.stats.discoveries ?? 0),
          h("td", {}, `${p.stats.builds} `, h("span", { class: "muted" }, Object.entries(p.stats.builtByType || {}).map(([b, n]) => `${n}${b[0].toUpperCase()}`).join(" "))),
          h("td", { class: "n" }, p.stats.buys), h("td", { class: "n" }, p.stats.earns ?? 0),
          h("td", { class: "n" }, p.stats.trashed), h("td", { class: "n" }, p.stats.earned), h("td", { class: "n" }, p.stats.spent),
          h("td", { class: "n" }, p.income),
          h("td", {}, Object.entries(p.colourCounts).filter(([, c]) => c).map(([r, c]) => h("span", { class: `pill c-${ROLES[r].colour}` }, icon(ROLE_ICON[r]), ` ${c}`))),
          h("td", {}, Object.entries(p.stats.playedByRole).map(([r, c]) => h("span", { class: `pill c-${ROLES[r].colour}` }, icon(ROLE_ICON[r]), ` ${c}`))))))))),
    h("section", {}, h("details", {},
      h("summary", {}, h("b", {}, "Game log"), h("span", { class: "muted" }, ` (${state.log.length} entries)`)),
      h("div", { class: "log full" }, state.log.map((l) => h("div", {}, h("span", { class: "muted" }, `R${l.round} `), themeLog(state, l.msg)))))),
    h("div", { class: "start row wrap" },
      h("button", { class: "ghost", onclick: () => download("canals-report.json", JSON.stringify(rep, null, 2)) }, "Download report (JSON)"),
      h("button", { class: "ghost", onclick: () => download("canals-log.txt", rep.log.join("\n"), "text/plain") }, "Download log (text)"),
      net.role === "guest" ? h("button", { class: "primary", onclick: () => leaveTable() }, "Leave the table") : [
        h("button", { class: "ghost", onclick: () => { setup.seed = (Number(setup.seed) || 0) + 1; saveSetup(); startGame(); } }, "Rematch (next seed)"),
        h("button", { class: "primary", onclick: renderHome }, "New game")])));
}

// --------------------------------------------------------------------------- //

// --------------------------------------------------------------------------- //
// The computer players' lane priors (agents.js): how many cards of each scoring
// colour they usually end with. The shipped value (bots/lane-priors.json,
// learned by tools/learn_priors.mjs) is the prior, worth up to 20 games; every
// game they finish in this browser updates the mean, Bayes-style.
// --------------------------------------------------------------------------- //
const LANES_KEY = "canals.lanePrior";
let shippedLanes = { prior: { dig: 2, build: 2, buy: 2, special: 2 }, games: 4, builtFor: null };

async function loadLanePriors() {
  try {
    const doc = await (await fetch(repo("bots/lane-priors.json"))).json();
    const g = doc.browser?.greedy;
    if (g) shippedLanes = { prior: g, games: Math.max(1, Math.min(20, g.games || 0)), builtFor: doc.browser_built_for || null };
  } catch { /* keep the default */ }
  applyLanePriors();
}

/** What this browser has seen, for the shipped priors it was learned against. */
function localLanes() {
  const l = store.get(LANES_KEY);
  return l && l.builtFor === shippedLanes.builtFor ? l : { builtFor: shippedLanes.builtFor, games: 0, sum: {} };
}

function applyLanePriors() {
  const l = localLanes(), n0 = shippedLanes.games;
  setLanePrior(Object.fromEntries(LANE_ROLES.map((r) =>
    [r, (n0 * shippedLanes.prior[r] + (l.sum[r] || 0)) / (n0 + l.games)])));
}

/** After a finished game: add each greedy computer player's final counts. */
function learnLanes(g) {
  if (!g?.over || g.lanesLearned || net.role === "guest") return;
  const bots = g.players.map((p, i) => [p, i]).filter(([p]) => p.ai === "greedy");
  g.lanesLearned = true;
  if (!bots.length) return;
  const l = localLanes();
  for (const [, i] of bots) {
    const c = E.score(g, i).counts;
    for (const r of LANE_ROLES) l.sum[r] = (l.sum[r] || 0) + c[r];
    l.games++;
  }
  store.set(LANES_KEY, l);
  applyLanePriors();
}

(async function main() {
  installSprites();
  loadLanePriors();
  try {
    setData(await loadRepoData());
    const joining = location.hash.match(/^#join=([A-Za-z0-9]+)/);
    if (joining) renderJoin(cleanCode(joining[1])); else renderHome();
    flushReports();   // anything a previous visit couldn't send
    if (location.hash === "#rules") openRules();
    addEventListener("hashchange", () => { if (location.hash === "#rules" && !document.querySelector(".rules-overlay")) openRules(); });
  } catch (err) {
    app.replaceChildren(h("div", { class: "setup" }, h("h1", {}, "Canals — playtest table"),
      h("div", { class: "errors" }, h("p", {}, "Couldn't load the repository's CSV files (", String(err.message || err), ")."),
        h("p", {}, "Serve the repo root over HTTP and open /web/:"), h("pre", {}, "python3 -m http.server 8000\n# then open http://localhost:8000/web/")),
      h("p", {}, "Or load the files by hand:"),
      h("button", { class: "primary", onclick: async () => {
        const d = { cards: [], hexes: [], terrain: [], notation: [] };
        for (const [k, label] of [["cards", "cards CSV (cards.csv)"], ["hexes", "hexes CSV"], ["terrain", "terrain CSV"]]) {
          toast(`Pick the ${label}`);
          const t = await pickFile(".csv");
          if (!t) return;
          d[k] = parseCSV(t);
        }
        setData(d); renderSetup();
      } }, "Load CSVs…")));
  }
})();

// "How to play": the rules for new players, told in the story's words, with
// numbers taken from the game's own settings (rules/defaults.json, or whatever
// the setup screen has), so the text cannot drift from the table it describes.
// The pictures are the table's own drawing: map snapshots of staged games in
// progress (scenes.js) and the lodge, with what lies under each token.
import { icon, ROLE_ICON, hasSymbol } from "./sprites.js";
import * as E from "./engine.js";
import { rename, codeWords, harbourName } from "./words.js";
import { renderExcerpt, renderTechBoard } from "./board.js";
import { SCENES, LEGEND, scene, blankStage, place } from "./scenes.js";

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const ROLE_NAME = { dig: "Dig", build: "Build", buy: "Buy", earn: "Earn", special: "Guide" };
const ROLE_COLOUR = { dig: "brown", build: "green", buy: "blue", earn: "yellow", special: "purple" };
const role = (r, text = ROLE_NAME[r]) => h("b", { class: `dot c-${ROLE_COLOUR[r]}` }, icon(ROLE_ICON[r]), " ", text);
/** The market decks as players name them. */
export const DECK_WORD = { starting: "starting", coastal: "coast", "coastal-2": "seasoned coast", inland: "meadow", "inland-2": "seasoned meadow" };
const BAND_WORD = { coast: "the coast", inland: "the meadows", highland: "the highland" };
const COLOUR_WORD = (n) => ["Hazel's red", "Bramble's blue", "Rush's yellow"][n];

/** Draw a picture safely: a figure, or nothing if this map or rule set can't show it. */
function figure(make, caption, cls = "") {
  try {
    const pic = make();
    if (!pic) return null;
    return h("figure", { class: `rules-fig ${cls}`.trim() }, pic, caption ? h("figcaption", {}, caption) : null);
  } catch (err) {
    console.warn("rules picture skipped:", err);
    return null;
  }
}

/**
 * The rules as a DOM element.
 * game: a game state (or a preview of one) for its config, map and building types.
 * extra: { startingDeck: [[role, n], ...], cards: { starter, market } (card elements), onClose, closeLabel }.
 */
export function rulesView(game, extra = {}) {
  const c = game.config;
  const players = game.players.length;
  const types = game.buildingTypes || [];
  const typed = c.buildingTypes && types.length > 1;
  const mats = !!c.materials;
  const tolls = mats && c.hauling === "tolls";
  const lodge = !!(game.tech && c.techBoard && c.techBoard !== "off");
  const terrain = game.board.terrain;
  const hexes = Object.values(game.board.hexes);
  const bands = hexes.some((hx) => hx.band === "highland");
  // Costs by band: "coast 1, meadows 2, highland 3".
  const bandCost = (k) => ["coastal", "inland", "highland"].filter((t) => terrain[t]).map((t) => `${BAND_WORD[terrain[t].band]?.replace("the ", "") || terrain[t].name.toLowerCase()} ${terrain[t][k]}`).join(", ");
  const perPlayer = Number(c.inlandMilestonePerPlayer) || 0;
  const need = (n) => Math.max(1, Math.floor(perPlayer * n));
  const deck = (extra.startingDeck || []).filter(([, n]) => n);
  const deckSize = deck.reduce((a, [, n]) => a + n, 0);
  // Card weights by deck (rule cardWeights), e.g. { starting: 0, coastal: 1, "coastal-2": 2, inland: 2 }.
  const weights = Object.fromEntries(String(c.cardWeights || "").split(",").filter((x) => x.includes("="))
    .map((x) => x.split("=")).map(([k, v]) => [k.trim().toLowerCase(), Number(v)]));
  const weighted = Object.keys(weights).length > 0;
  const w = (d) => weights[d] ?? weights[E.deckFamily(d)] ?? 1;
  const split = !!c.inlandDisplay;
  const tides = !!(c.tides && c.inlandMilestone && c.inlandMilestone !== "none");
  const share = Number(c.endKeysShare ?? 1);
  const springs = share >= 1 ? "every spring village" : share === 0.5 ? "half the spring villages" : `${Math.round(share * 100)}% of the spring villages`;
  const ends = [c.endOnMarket ? "the market decks run out" : null,
    c.endOnKeys ? `${springs}${c.endKeysBand ? ` in the ${c.endKeysBand}` : ""} are on the canal network` : null].filter(Boolean);
  const endLine = ends.length ? `The game ends at the end of the round in which ${ends.join(", or ")}` : `The game ends after round ${c.rounds}`;
  const feats = Object.fromEntries(hexes.filter((hx) => hx.feature).map((hx) => [hx.feature, game.board.features[hx.feature]]));
  const reachVals = String(c.reachBands || "").split(",").filter(Boolean).map(Number);
  const reachFlat = !reachVals.length || reachVals.every((v) => v === reachVals[0]);
  const reachOne = reachVals[0] ?? c.vpPerReach;
  const prizes = E.prizeList ? E.prizeList(game) : [];
  const steps = E.multiplierSteps(c);
  const multOf = (n) => (steps ? steps.filter(([at]) => n >= at).pop()?.[1] ?? 1 : n);

  const sections = [
    ["goal", "Four currents"], ["stuff", "What you hold"], ["setup", "Setting up"], ["turn", "A turn"],
    ["map", "The land"], ["dig", "Digging canals"], ["water", "Open water"], ["build", "Building"],
    ...(lodge ? [["lodge", "Your lodge"]] : []), ...(mats ? [["resources", "Wood and stone"]] : []),
    ["market", "The market"], ["money", c.pearls ? "Money and pearls" : "Money"],
    ...(tides ? [["tides", "Three tides"]] : []), ["end", "The end"],
  ];
  const sec = (id, ...kids) => h("section", { id: `rules-${id}` }, h("h2", {}, sections.find((s) => s[0] === id)[1]), ...kids);
  const item = (pic, title, text) => h("div", {}, pic, h("div", {}, h("b", {}, title), " ", text));

  // ------------------------------------------------------------------ pictures
  const seated = (s) => s.harbours.slice(0, 2).map((hk, i) => `${harbourName(s, hk)} (${COLOUR_WORD(i)})`);
  const swatchStage = (() => {
    try {
      const s = place(blankStage(game, 3), [[0, "dig", "1,3|2,2"], [0, "dig", "1,3|2,3"]]);
      const tok = Object.values(game.tokens || {})[0] || E.tokenPool?.(c)?.[0];
      if (tok && game.board.hexes["0,4"]) s.tokens = { "0,4": { name: tok.name, code: tok.code } };
      return s;
    } catch { return null; }
  })();
  const swatch = (hk) => {
    if (!swatchStage || !game.board.hexes[hk]) return h("span", { class: "swatch" });
    const svg = renderExcerpt(swatchStage, [hk], { pad: 1.02, isolate: true });
    svg.setAttribute("class", "board excerpt swatch");
    svg.setAttribute("aria-hidden", "true");
    return svg;
  };
  const sampleToken = swatchStage?.tokens?.["0,4"];

  const firstFig = () => figure(() => {
    const s = scene(game, "first");
    return renderExcerpt(s, SCENES.first.hexes, { labels: [{ hex: "2,2", text: harbourName(s, "2,2"), dy: -0.7 }, { hex: "1,1", text: harbourName(s, "1,1"), dy: -0.7 }] });
  }, (() => {
    const s = scene(game, "first");
    const [a, b] = seated(s);
    return `Early on the coast. Hazel has dug three canals from ${a}, Bramble two from ${b}. `
      + "Each canal starts at a harbour mouth or meets another at a corner. Bramble's third canal joins Hazel's: only a bought dig card may do that. "
      + `The brighter hexes with a blue rim are opened. Hazel's canals touch ${plural(E.reach(s, 0), "opened hex", "opened hexes")}, Bramble's ${E.reach(s, 1)}: the forest between them counts for both.`;
  })());

  const villageFig = () => figure(() => {
    const s = scene(game, "village", true);
    return renderExcerpt(s, SCENES.village.hexes, { focus: ["1,6"] });
  }, "Later, in the meadows. Hazel has built a Wharf between two of her canals (it paid her 2 money), a Logging camp on the forest, and a Burrow in the spring village. "
    + "Bramble dug one canal to the village's edge, joined to Hazel's, and built a Mill there: two families in one village, and each now has a friendship with it.");

  const tollFig = () => figure(() => {
    const s = scene(game, "village");
    s.current = 1;
    const price = E.buildPrice(s, "1,6", "mill", 1);
    const route = [...new Set(price.picks.flatMap((x) => x.edges || []))];
    const svg = renderExcerpt(s, SCENES.village.hexes, { route, focus: ["1,6", "1,4"], labels: [{ hex: "1,4", text: "camp", dy: -0.66 }, { hex: "1,6", text: "Mill here", dy: 0.7 }] });
    const loads = price.picks.length, fees = price.picks.reduce((a, x) => a + (x.fee || 0), 0), toll = price.picks.reduce((a, x) => a + (x.tolls || 0), 0);
    const site = price.total - price.picks.reduce((a, x) => a + x.cost, 0);
    svg.dataset.caption = `Bramble builds that Mill. It needs two loads of wood, and the cheapest is Hazel's camp: ${loads} loads at 1 each to Hazel (${fees}), `
      + `carried along the gold route over ${plural(toll, "canal")} of Hazel's: ${toll} in tolls, paid once for the build, not once a load. With ${site} for the site, the Mill costs ${price.total}. `
      + (c.importPrice ? `Wood from over the sea would have cost ${c.importPrice} a load.` : "");
    return svg;
  }, null);

  const bandsFig = () => figure(() => {
    const s = scene(game, "bands");
    return renderExcerpt(s, SCENES.bands.hexes, { labels: SCENES.bands.labels, pad: 1 });
  }, "The western end of the land at the start. Only the coast is open; the meadows (greyed) open at the second tide, and the highland lies beyond the crags.", "side");

  const tollCaption = (fig) => { if (fig) { const svg = fig.querySelector("svg"); fig.append(h("figcaption", {}, svg?.dataset.caption || "")); } return fig; };

  // ------------------------------------------------------------------- the page
  return h("article", { class: "rules", "aria-label": "How to play" },
    h("header", {}, h("h1", {}, icon("i-reach", "big"), "How to play Canals"),
      extra.onClose ? h("button", { class: "primary", onclick: extra.onClose }, extra.closeLabel || "Close") : null),
    h("p", { class: "lede" }, "The sea animals have always lived along the shore. This year the families mean to reach the high springs, ",
      "and they have hired the land animals to dig them a way inland."),
    h("p", { class: "lede" }, "You lead one family. Your deck is the animals who work for you: moles and badgers dig, beavers and bees build, ",
      "magpies haggle at the market, mice bring in money. Every family's canals join into one network of water, but each canal and each building belongs to the family that made it. ",
      `${endLine}, and the family with the most points wins.`),
    h("div", { class: "box glance" }, h("b", {}, "At a glance. "),
      "On your turn, play one card: it digs a canal, builds beside your water, buys an animal from the market, or earns money. ",
      "Discard other cards to make it stronger, or keep them to earn pearls. At the end, each colour of card you own multiplies something you made."),
    h("nav", { "aria-label": "Sections" }, sections.map(([id, t]) => h("a", { href: `#rules-${id}`, onclick: (e) => {
      e.preventDefault(); document.getElementById(`rules-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } }, t))),

    // -------------------------------------------------------------- the goal
    sec("goal",
      h("p", {}, "When the game ends, your points flow in from four ", h("b", {}, "currents"), ". Each multiplies two things: ",
        h("b", {}, "how many animals of one colour you own"), ", and ", h("b", {}, "something you have made"), "."),
      h("div", { class: "lanes4" }, [
        ["dig", "Dig cards", "×", "your building score", typed ? `Most buildings score ${c.vpPerBuilding}; some more, the Burrow nothing.` : `Each building scores ${c.vpPerBuilding}.`],
        ["build", "Build cards", "×", "the VP on your cards", "The VP printed on the animals you own. Guides carry the most."],
        ["buy", "Buy cards", "×", "your open water", reachFlat ? `Each opened hex your canals touch scores ${reachOne}${feats.marsh ? `, a marsh ${reachOne + feats.marsh.reachBonus}` : ""}.` : `Each opened hex your canals touch: ${reachVals.join(" / ")} for coast / meadows / highland.`],
        ["special", "Guide cards", "×", "your friendships", `Each friendship with a spring village scores ${c.vpPerKey}.`],
      ].map(([r, a, x, b, note]) => h("div", { class: `lane c-${ROLE_COLOUR[r]}` },
        icon(ROLE_ICON[r], "big"), h("b", {}, `${a} ${x} ${b}`), h("span", { class: "muted" }, note)))),
      h("p", {}, "No colour feeds its own current: Dig cards dig canals, but they multiply your buildings. So you always need two things at once, ",
        "the animals of a colour and the work that colour multiplies, and a deck that leans one way pays."),
      h("p", {}, "Every card you own counts, wherever it is: hand, draw pile and discard pile. ",
        weighted ? [`Starting cards count ${w("starting")}, coast cards ${w("coastal")}, seasoned coast and meadow cards ${w("coastal-2")}`,
          w("starting") === 0 ? ", so throwing out a starting card costs you nothing. " : ". "] : "",
        role("earn", "Earn"), " cards count for no current: they are your purse."),
      steps ? h("div", { class: "box" }, h("b", {}, "Counting up. "), "Add up a colour's cards, then read its multiplier here:",
        h("table", { class: "steps" },
          h("tr", {}, h("th", {}, "Count"), steps.map(([at], i) => h("td", {}, i + 1 < steps.length ? (steps[i + 1][0] - 1 > at ? `${at}–${steps[i + 1][0] - 1}` : `${at}`) : `${at}+`))),
          h("tr", {}, h("th", {}, "Multiplier"), steps.map(([, m]) => h("td", {}, `×${m}`)))),
        h("p", {}, h("b", {}, "Example. "), weighted
          ? `Hazel owns two coast Dig cards and a meadow Dig card: ${w("coastal")} + ${w("coastal")} + ${w("inland")} = ${2 * w("coastal") + w("inland")}, so ×${multOf(2 * w("coastal") + w("inland"))}. Her buildings score 14, so that current pays ${multOf(2 * w("coastal") + w("inland"))} × 14 = ${14 * multOf(2 * w("coastal") + w("inland"))}.`
          : `Hazel owns 4 Dig cards, so ×${multOf(4)}. Her buildings score 14: that current pays ${14 * multOf(4)}.`,
          " Every current scores at least once, even with no cards.")) : null,
      h("p", { class: "muted" }, "At the table, your panel draws the four currents as a wheel: each slice is a current, the centre your total if the game ended now.")),

    // -------------------------------------------------------- what you hold
    sec("stuff",
      h("div", { class: "glossary" },
        item(icon("i-coin"), "Money.", "Pays for canals, buildings and animals. Kept from turn to turn."),
        item(icon("i-income"), "Income.", `What an Earn brings in. It starts at ${c.startingIncome}${lodge ? "; buildings from the inner ring of your lodge add 1 each" : `; each building adds ${c.incomePerBuilding}`}.`),
        item(icon("i-hand"), "Hand.", `${c.handSize} cards. A few animals raise it for good, up to ${c.handSizeCap}.`),
        item(icon("i-deck"), "Deck.", "Your animals: draw pile, hand and discard pile. New ones go to your discard pile and come round later."),
        c.pearls ? item(icon("i-pearl"), "Pearls.", `Earned by keeping cards in hand; at most ${c.pearlCap}. Spent for money, a fresh card or an extra action.`) : null,
        lodge ? item(icon("b-burrow"), "Lodge.", "Your family's home: the stock of buildings you can raise, and the crafts you learn as you raise them.") : null,
        item(icon("i-key"), "Friendships.", `One for each spring village you build in${c.keysPerHighland > 1 ? `, ${c.keysPerHighland} in the highland` : ""}.`),
        item(icon("i-reach"), "Open water.", "The opened hexes your canals touch."))),

    // -------------------------------------------------------------- setting up
    sec("setup",
      h("ol", {},
        h("li", {}, `Lay out the land. It grows a strip for each family: this one is set for ${plural(players, "player")}.`),
        h("li", {}, "Each player takes a starting deck", deckSize ? ` of ${deckSize} animals (` : "", deck.map(([r, n], i) => [i ? ", " : "", `${n} ${ROLE_NAME[r]}`]), deckSize ? ")" : "",
          `, shuffles it and draws ${c.handSize}, and takes ${c.startingPurse} money. Income starts at ${c.startingIncome}.`),
        c.ownHarbours ? h("li", {}, c.harbourDraft
          ? ["Choose harbours, the last seat first. ", `A deep harbour, two canals or more nearer the meadows than most, costs ${c.harbourPremium} of your money. `, "Unchosen harbours belong to nobody."]
          : "Each player takes a harbour, spread along the coast in seat order. Any others belong to nobody.") : null,
        lodge && c.startingTech ? h("li", {}, "In seat order, each player opens one inner slot of their lodge: its craft is theirs from the start (see Your lodge). No two players the same.") : null,
        c.deckSizes ? h("li", {}, "Fewer players use fewer animals. Before shuffling, set copies aside until each deck holds:",
          h("table", { class: "steps" }, h("tr", {}, h("th", {}, "Players"), [2, 3, 4, 5].map((n) => h("td", {}, n))),
            String(c.deckSizes).split(",").map((part) => part.split("=").map((x) => x.trim())).filter(([d, v]) => d && v)
              .map(([d, v]) => h("tr", {}, h("th", {}, `${DECK_WORD[d] || d}${d.startsWith("coastal") || d.startsWith("inland") ? " cards" : ""}`), v.split("/").map((n) => h("td", {}, n))))),
          "Set aside Earn cards first, then from the animal with the most copies; every animal keeps at least one.") : null,
        h("li", {}, "Make the market. Shuffle the seasoned coast cards and put the shuffled coast cards on top: that is the ", h("b", {}, "coast deck"), ". ",
          "Do the same with the meadow cards for the ", h("b", {}, "meadow deck"), `. Lay ${c.displaySize} coast cards face up. `,
          split ? `The meadow deck waits face down until the meadows open${tides ? " at the second tide" : ""}.` : "The meadow deck waits until the meadows open, then shuffles into the coast deck."),
        mats && !tolls ? h("li", {}, `Fill the import market: ${String(c.marketTrack || "").split(",").length} cubes each of clay, wood and stone.`) : null)),

    // ---------------------------------------------------------------- a turn
    sec("turn",
      h("p", {}, "Players take turns in seat order. On your turn:"),
      h("ol", {},
        h("li", {}, h("b", {}, "Play one card"), " from your hand.",
          c.forageOne > 0 || c.forageHand > 0 ? [" Or ", h("b", {}, "forage"), ": ",
            c.forageOne > 0 ? `throw one card away face down for ${c.forageOne} money` : "",
            c.forageOne > 0 && c.forageHand > 0 ? ", or " : "",
            c.forageHand > 0 ? `your whole hand for ${c.forageHand}` : "",
            ". That is your whole turn: no actions, no boost and no pearl progress."] : ""),
        h("li", {}, h("b", {}, "Boost it if you like."), " The lower part of a card names a discard and what it gives: ",
          h("i", {}, "Discard 2 cards"), ", ", h("i", {}, "Discard a Dig card"), ", or ", h("i", {}, "Discard any number"), " (the reward then comes for each card). ",
          lodge ? "A craft from your lodge may offer another boost; use one boost, never both." : ""),
        h("li", {}, h("b", {}, "Do what it gives"), ", in any order: its actions, plus anything the boost added. ",
          "A discount counts for every action of its kind this turn. Actions you don't use are lost."),
        h("li", {}, h("b", {}, "Draw back up"), ` to ${c.handSize} (or your hand size). When your draw pile runs out, shuffle your discard pile to make a new one.`)),
      h("div", { class: "box" }, h("b", {}, "Discard or keep? "),
        "Discarding makes this turn stronger and turns your deck over faster, so you meet your best animals sooner. ",
        c.pearls ? (c.pearlEarning === "track"
          ? ["Keeping is patient: every card still in your hand at the end of your turn moves your ", icon("i-pearl"), " pearl track a step towards the next pearl."]
          : ["Keeping your cards earns a ", icon("i-pearl"), " pearl to spend later."]) : "Keeping them keeps your next turn certain."),
      extra.cards?.starter && extra.cards?.market ? h("figure", { class: "rules-fig cards-fig" },
        h("div", { class: "cards-pair" }, extra.cards.starter, extra.cards.market),
        h("figcaption", {}, h("b", {}, "Reading a card. "), "The band gives its colour, its action and, on the coin, its price at the market. ",
          "The middle says what it does. Below that, its boost: what to discard, then what it gives. ",
          "The foot names its deck and any VP it carries for the Deck current. ",
          "On the left, an Otter from your starting deck; on the right, a Kestrel, a Guide from the coast deck.")) : null),

    // ---------------------------------------------------------------- the land
    sec("map",
      h("p", {}, bands ? ["The land rises in three bands from the sea: ", h("b", {}, "the coast"), ", ", h("b", {}, "the meadows"), " and ", h("b", {}, "the highland"),
        `. Each is dearer to dig and to build on than the last (${bandCost("digCost")}). `] : "",
        "Canals run along the borders between hexes and meet only at their corners."),
      bands ? bandsFig() : null,
      h("div", { class: "glossary legend" },
        item(swatch(LEGEND.harbour), "Harbours.", c.ownHarbours ? "Each family's harbour flies its pennant. The dots where it meets the sea are its mouths, where canals begin." : "The dots where a harbour meets the sea are its mouths, where canals begin."),
        item(swatch(LEGEND.village), "Spring villages.", `${c.villageSlots > 1 ? `Room for ${c.villageSlots} families, one building each.` : "Room for one building."} Building here makes a friendship${c.keysPerHighland > 1 ? ` (${c.keysPerHighland} in the highland)` : ""}.`),
        item(swatch(LEGEND.site), "Building sites.", "The pale ring: one building may stand here. Hexes without one take none."),
        item(swatch(LEGEND.discovery), "Discoveries.", `A small find (here, ${codeWords(game.board.hexes[LEGEND.discovery]?.bonus || "+1M")}). The dig that opens the hex takes it.`),
        sampleToken ? item(swatch("0,4"), "Site tokens.", `Dealt face up on a few sites each game (here, ${sampleToken.name}: ${codeWords(sampleToken.code)}). The first building on the site takes it.`) : null,
        mats ? item(swatch(LEGEND.forest), "Forests.", "Wood. A Logging camp here supplies it.") : null,
        mats ? item(swatch(LEGEND.stone), "Stony hills.", `Stone. A Quarry here supplies it.${feats.hills ? ` Hills cost ${feats.hills.digMod} more to dig beside, and a building on them scores ${feats.hills.vpBonus} more.` : ""}`) : null,
        feats.marsh ? item(swatch(LEGEND.marsh), "Marshes.", `${-feats.marsh.digMod} cheaper to dig beside, no building site, and ${feats.marsh.reachBonus} more open water once opened.`) : null,
        item(swatch(LEGEND.lake), "Lakes.", "Inland water. Once a canal linked to the sea reaches one corner of a lake, all its corners are linked: a free crossing."),
        item(swatch(LEGEND.crag), "Crags.", "A ridge before the highland: no building site, and no canal between two crags. Find a pass."))),

    // ------------------------------------------------------------------- dig
    sec("dig",
      h("p", {}, role("dig"), " cards dig. A canal runs along the border between two land hexes and is yours: draw it in your colour. ",
        `It costs the dearer of the two hexes (${bandCost("digCost")}${feats.hills ? `; beside hills ${feats.hills.digMod} more` : ""}${feats.marsh ? `, beside a marsh ${-feats.marsh.digMod} less` : ""}).`),
      h("p", {}, h("b", {}, "Water must flow. "), "A new canal starts at a harbour mouth, or meets at a corner a canal (anyone's) already linked to the sea. ",
        "A few land animals may also dig away from the water on their own ground; such a canal is cut off, and counts for nothing, until someone links it."),
      c.ownHarbours ? h("p", {}, h("b", {}, "Your harbour. "), "Your starting animals dig only from your own harbour or along your own linked canals",
        c.tidesLiftStarters && tides ? ", until the second tide frees them to join anyone's" : "",
        ". Animals bought at the market may start at any harbour or join anyone's canals.") : null,
      bands && c.highlandNeedsBought ? h("p", {}, h("b", {}, "The highland. "), "Only bought animals dig a border touching the highland",
        tides ? ", until the third tide opens it to everyone" : "", ".") : null,
      firstFig()),

    // ------------------------------------------------------------ open water
    sec("water",
      h("p", {}, "A land hex is ", h("b", {}, "opened"), " when a linked canal runs along one of its borders. Hexes beside the sea were always within reach, so they never count. ",
        h("b", {}, "Your open water"), " is the opened hexes that touch at least one of your own canals; two families whose canals touch the same hex both count it. ",
        "On the board, opened hexes shine brighter, with a blue rim."),
      h("p", {}, "In the picture above, two hexes are opened: the forest, which both families' canals touch, and the hex beside it, which only Hazel's touch. The hexes along the sea, harbours included, never count.")),

    // ---------------------------------------------------------------- build
    sec("build",
      h("p", {}, role("build"), " cards build. Choose a hex with a building site where ",
        c.buildNeedsOwnCanal ? [h("b", {}, "one of your own canals"), ", linked to the sea, runs along a border"] : "a linked canal runs along a border",
        `. Pay for the site (${bandCost("buildCost")})`, mats ? ", plus the wood or stone the building needs (see Wood and stone)" : "",
        lodge ? ", and take its token from your lodge." : "."),
      h("p", {}, c.villageSlots > 1
        ? `A spring village has room for ${c.villageSlots} families, one building each, and building there makes a friendship with it${c.keysPerHighland > 1 ? ` (${c.keysPerHighland} in the highland)` : ""}. Elsewhere, one building per hex.`
        : "Building in a spring village makes a friendship with it. One building per hex."),
      villageFig(),
      typed ? h("table", { class: "buildings" },
        h("thead", {}, h("tr", {}, ["", "Building", "Scores", mats ? "Needs" : null, "What else", lodge ? "In your lodge" : "Each"].filter((x) => x !== null).map((t) => h("th", {}, t)))),
        h("tbody", {}, types.map((bt) => h("tr", {},
          h("td", { style: "--pc:#c96f4a" }, icon(hasSymbol(`b-${bt.id}`) ? `b-${bt.id}` : "b-plain", "", null, "#c96f4a")),
          h("td", {}, h("b", {}, rename(bt.name))),
          h("td", {}, bt.vp === "base" ? `${c.vpPerBuilding}` : `${bt.vp}${bt.vpPerNeighbour ? "+" : ""}`),
          mats ? h("td", {}, (bt.needs || []).length ? bt.needs.map((r) => [icon(`cube-${r}`, "", r), " "]) : "—") : null,
          h("td", {}, buildingNote(bt)),
          h("td", {}, lodge ? `${game.tech.slots.filter((x) => x.token === bt.id).length}` : bt.supply ? `${bt.supply}` : "—"))))) : null,
      h("p", { class: "muted" }, "At the table, hover a building for its rule, or a hex you can build on for its full price.")),

    // ----------------------------------------------------------------- lodge
    lodge ? sec("lodge",
      h("p", {}, "Every building you raise comes out of your lodge: a honeycomb of ", `${game.tech.slots.length}`, " tokens around an open centre, ",
        `${game.tech.slots.filter((x) => x.ring === "inner").length} on the inner ring and ${game.tech.slots.filter((x) => x.ring !== "inner").length} on the outer. `,
        "Under each token lies a ", h("b", {}, "craft"), ", printed on the slot: build the token and the craft is yours for the rest of the game."),
      lodgeDiagram(game),
      h("ul", {},
        h("li", {}, "Take a token from a slot ", h("b", {}, "next to an open one"), `: the centre, or a slot you have emptied. A token from anywhere else costs ${c.techLeapCost} pearl (a leap).`),
        h("li", {}, "The inner ring pays: each slot gives +1 income when you empty it. The outer ring gives no income, but holds the Holts, Mills and Locks",
          c.techTideGate && tides ? ", and it opens only at the second tide." : "."),
        h("li", {}, "When a type's tokens are gone, you build no more of it."),
        c.techBoard === "full" ? h("li", {}, h("b", {}, "Masteries. "), c.techTideGate && tides ? "From the third tide, the" : "The",
          " first family to empty all three slots of a sector takes its mastery", c.capstoneLimit ? ` (at most ${c.capstoneLimit} each)` : "", ": ",
          Object.entries(E.CAPSTONES).map(([sector, x], i, a) => [h("i", {}, rename(x.name)), ` (${sector}): ${x.text.replace(/\.$/, "")}`, i < a.length - 1 ? "; " : "."])) : null)) : null,

    // ------------------------------------------------------------ resources
    tolls ? sec("resources",
      h("p", {}, "Most buildings need clay, wood or stone, carried to the site along canals linked to the sea. Each load comes from the ", h("b", {}, "cheapest source"), ":"),
      h("ul", {},
        h("li", {}, icon("cube-clay"), " ", h("b", {}, "Clay"), " is dug from any hex on the shore, free."),
        h("li", {}, icon("cube-wood"), " ", h("b", {}, "Wood"), " comes from a Logging camp on a forest, ", icon("cube-stone"), " ", h("b", {}, "stone"), " from a Quarry on stony hills",
          c.sourceFirst ? "; each must be the first building on its hex. " : ". ",
          c.wearStep > 0 && c.wearFree > 0
            ? `A source never runs dry, but it wears: its first ${c.wearFree} loads cost ${c.extractionFee} each, paid to its owner, then ${c.extractionFee + c.wearStep}, ${c.extractionFee + 2 * c.wearStep} and so on. Your own source is free for the first ${c.wearFree}; after that you pay the rise to the bank. A busy source tells everyone: open another.`
            : `A source never runs dry. Each load costs ${c.extractionFee}, paid to its owner; yours are free.`,
          c.sourceLoads > 0 ? ` A source is worked out after ${c.sourceLoads} loads (the building stays and scores).` : ""),
        c.importPrice > 0 ? h("li", {}, h("b", {}, "From over the sea. "), `Wood or stone can always be shipped to any shore hex for ${c.importPrice} a load, then carried from there.`) : null,
        h("li", {}, h("b", {}, "Tolls. "), `Each canal of another family's that a load passes costs ${c.tollPerCanal}, paid to its owner`,
          c.tollMode === "owner" ? " (once for each family, however many of their canals)" : "",
          c.tollsPerBuild ? "; however many loads a build needs, each owner is paid once" : "",
          `. Your own canals are free. Stone is heavy: ${c.stoneBankToll} more a canal, paid to the bank, on your own canals too. A site on or beside its source pays no tolls.`)),
      tollCaption(tollFig()),
      h("p", {}, "So a canal on a busy route is a toll road: other families pay you each time they build past it.")) : null,
    mats && !tolls ? sec("resources",
      h("p", {}, "Clay, wood and stone are cubes on the board. A building takes its cube from the cheapest connected source: an extractor's hex, ",
        `${c.extractionFee} to its owner, or the import market at a harbour; plus ${c.haulPerEdge} a canal to haul it.`)) : null,

    // ---------------------------------------------------------------- market
    sec("market",
      h("p", {}, role("buy"), " cards buy. Take an animal from a display, pay its price on the coin and put it on your discard pile. The display refills at once.",
        E.topCost({ config: c }) !== null ? ` For ${c.buyOnTopCost} more, put it on top of your draw pile instead: you draw it at the end of this turn.` : "",
        c.trashFloor > 0 ? ` Some animals let you throw cards out of your deck for good, but never below ${c.trashFloor} cards.` : ""),
      h("p", {}, split
        ? [`There are two market decks, each with its own display of ${c.displaySize}: the coast deck from the start, the meadow deck once the meadows open. `,
          "If the coast runs dry before then, there is nothing to buy until they do."]
        : `${c.displaySize} cards lie face up; the meadow cards join the deck when the meadows open.`),
      h("p", {}, "The ", h("b", {}, "seasoned"), " animals lie under each deck. They come out later and do two things or more from one card, so by then a starting card is a weak draw, and throwing it out is worth a turn."),
      c.marketClock && c.marketClock !== "off" ? h("p", {}, h("b", {}, "The market moves. "),
        c.marketClock === "unbought"
          ? "At the end of each round, in each display nobody bought from, the animal that has waited longest leaves the game and the display refills."
          : "At the end of each round, the animal that has waited longest in each display leaves the game and the display refills.",
        " So the decks run down even when nobody buys.") : null,
      h("p", {}, "Read the market as a map of your future: the colours you buy are your multipliers.")),

    // ----------------------------------------------------- money and pearls
    sec("money",
      h("p", {}, role("earn"), ` cards earn: take money equal to your income. Some say twice.`),
      h("p", {}, role("special", "Guides"), " (purple) do what they say, often two things, and carry the most VP for the Deck current. They are what your friendships multiply."),
      c.pearls ? [
        c.pearlEarning === "track"
          ? h("p", {}, "At the end of your turn, before you draw, move your ", h("b", {}, "pearl track"), " a step for each card still in your hand. ",
            "When it reaches the threshold, take a pearl ", icon("i-pearl"), " and start again from 0. ",
            `You hold at most ${c.pearlCap}; when you are full, the track waits. Some animals move it further, or hand you a pearl outright.`)
          : h("p", {}, "End a turn without discarding and take a pearl ", icon("i-pearl"), ` (at most ${c.pearlCap}).`),
        c.pearlEarning === "track" ? h("div", { class: "box" }, h("b", {}, "The threshold"), ` is ${c.pearlThreshold}, and 1 more`,
          h("ul", {},
            c.pearlStoredStep ? h("li", {}, "for each pearl you are holding: hoard, and the next comes slower;") : null,
            c.pearlUsedDivisor ? h("li", {}, `for every ${c.pearlUsedDivisor} pearls you have spent this game;`) : null,
            c.pearlHandStep ? h("li", {}, `for each card of hand size above ${c.handSize}.`) : null),
          "Spend them as you go, and expect six or seven in a game.") : null,
        h("p", {}, "On a later turn, while you act, spend them:"),
        h("table", {}, h("tbody", {},
          h("tr", {}, h("td", {}, "1 pearl"), h("td", {}, `${c.pearlMoney} money`)),
          h("tr", {}, h("td", {}, "1 pearl"), h("td", {}, "A fresh card: put one from your hand on your discard pile and draw another")),
          h("tr", {}, h("td", {}, `${c.pearlActionCost} pearls`), h("td", {}, "One more action of the played card's kind (dig, build or buy), at full price")))),
        h("p", { class: "muted" }, "A pearl taken this turn waits until your next. Pearls left at the end score nothing.")] : null),

    // ------------------------------------------------------------------ tides
    tides ? sec("tides",
      h("p", {}, "The land opens in three tides, and the market and your lodge change with them. Cards already on display stay where they are."),
      h("ol", { class: "tides" },
        h("li", {}, h("b", {}, "The first tide: the coast. "), "Only the coast is open. No canal may have meadows on both sides, and nothing is built there (the meadows are greyed). ",
          `You buy from the coast deck${lodge && c.techTideGate ? ", and build from the inner ring of your lodge" : ""}.`),
        h("li", {}, h("b", {}, "The second tide: the meadows. "),
          c.inlandMilestone === "canals"
            ? `It comes when the network has ${perPlayer} canals per player bordering the meadows, rounded down (${[2, 3, 4, 5].map((n) => `${need(n)} at ${n}`).join(", ")} players). `
            : "It comes at the milestone. ",
          "The meadows open", split ? `, and ${c.displaySize} meadow cards are laid out as a second display` : "", ". ",
          "The first coast cards still in the deck leave the game, so the seasoned ones come out next",
          c.tidesLiftStarters ? "; starting animals may join anyone's canals" : "",
          lodge && c.techTideGate ? "; the outer ring of your lodge opens" : "", ". ",
          c.milestoneReward ? `Whoever digs the canal that brings it takes ${codeWords(c.milestoneReward)}, at once.` : ""),
        h("li", {}, h("b", {}, "The third tide: the highland. "), "It comes when the first highland village is on the network, or the coast deck runs out. ",
          "Starting animals may dig in the highland, and the first meadow cards still in the deck leave the game",
          lodge && c.techBoard === "full" && c.techTideGate ? "; masteries may be claimed" : "", ". ",
          c.tideReward ? `Whoever links that village takes ${codeWords(c.tideReward)}.` : "")),
      prizes.length ? h("div", { class: "box" }, h("b", {}, "Prizes of the coast. "),
        "Before the second tide, the first family to reach each of these takes its prize: ",
        prizes.map((x, i) => [h("i", {}, x.name), ` (${codeWords(x.code)})`, i < prizes.length - 1 ? "; " : ". "]),
        "Prizes nobody has won by the second tide are gone.") : null) : null,

    // ------------------------------------------------------------------- end
    sec("end",
      h("p", {}, `${endLine}${c.rounds && ends.length ? ` (at the latest, after round ${c.rounds})` : ""}. Everyone has had the same number of turns. `,
        "Score the four currents; the family with the most points wins. A tie goes to the one with more money."),
      ends.length > 1 ? h("p", {}, "Racing for the high springs ends the game early; building up a deck and buying through the market makes it longer. Watch which end is coming.") : null,
      h("p", { class: "muted" }, "Prefer the designer's short codes on cards? Settings, Show card codes.")),
  );
}

/** A building's rule, less what the table's other columns already say. */
function buildingNote(bt) {
  return String(bt.rules || "")
    .replace(/^\d+ VP[,.]?\s*(and\s*)?/i, "")
    .replace(/\s*Needs (clay|two wood|stone and wood|wood and stone)\.\s*$/i, "")
    .replace(/,? (wood and stone|and wood)\.\s*$/i, ".")
    .replace(/^No points\.\s*/i, "")
    .replace(/^./, (m) => m.toUpperCase()) || "—";
}

/** The lodge as a honeycomb: hover (or tap) a slot to see its building and the craft beneath it. */
function lodgeDiagram(game) {
  const s = blankStage(game, 2);
  const info = h("div", { class: "lodge-info", "aria-live": "polite" });
  const idle = () => info.replaceChildren(
    h("p", { class: "lodge-info-head" }, "Hover or tap a slot"),
    h("p", { class: "muted" }, "Each slot holds a building token. Lift it, and the craft beneath it is yours."),
    h("p", { class: "muted" }, "The slots outlined in colour are the ones you can take first: those next to the open centre."));
  const show = (x) => {
    if (!x || x.id === "centre") return idle();
    const bt = s.buildingTypes.find((b) => b.id === x.token);
    const boost = E.BOARD_BOOSTS[x.tech];
    info.replaceChildren(
      h("p", { class: "lodge-info-head" }, `${x.sector}, ${x.ring === "inner" ? "inner ring" : "outer ring"}`),
      h("div", { class: "lodge-layer" }, h("span", { class: "lodge-tag" }, "On top"),
        icon(hasSymbol(`b-${x.token}`) ? `b-${x.token}` : "b-plain", "", null, "#c96f4a"),
        h("div", {}, h("b", {}, rename(bt?.name || x.token)), " ", h("span", { class: "muted" }, bt?.rules || ""))),
      h("div", { class: "lodge-layer under" }, h("span", { class: "lodge-tag" }, "Underneath"),
        h("div", {}, h("b", {}, rename(x.name)), boost ? h("span", { class: "muted" }, " (a boost)") : null, " ", x.text,
          x.income ? h("div", { class: "muted" }, `Emptying this slot also gives +${x.income} income${x.tech === "granary" ? " (2 with Granary)" : ""}.`) : null)));
  };
  idle();
  const board = renderTechBoard(s, 0, 26, { onHover: show });
  board.querySelectorAll("[data-slot]").forEach((g) => g.addEventListener("click", () => show(s.tech.slots.find((x) => x.id === g.dataset.slot))));
  board.setAttribute("aria-label", "A lodge at the start of the game");
  return h("figure", { class: "rules-fig lodge-fig" }, h("div", { class: "lodge-wrap" }, h("div", { class: "lodge-pic" }, board), info),
    h("figcaption", {}, "A lodge at the start. Six sectors of three slots: one on the inner ring, two on the outer. ",
      "The token shows what you may build; the craft under it is what you learn by building it."));
}

/** Show the rules over the page; returns a function that closes them. */
export function showRules(game, extra = {}) {
  document.querySelector(".rules-overlay")?.remove();
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); if (location.hash === "#rules") history.replaceState(null, "", location.pathname + location.search); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const overlay = h("div", { class: "rules-overlay", onclick: (e) => { if (e.target === overlay) close(); } },
    rulesView(game, { ...extra, onClose: close }));
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  overlay.querySelector("button")?.focus();
  return close;
}

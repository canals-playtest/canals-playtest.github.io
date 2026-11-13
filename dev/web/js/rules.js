// "How to play": the rules for playtesters, with numbers taken from the game's
// own settings (rules/defaults.json, or whatever the setup screen has), so the
// text cannot drift from the table it describes.
import { icon, ROLE_ICON, hasSymbol } from "./sprites.js";
import * as E from "./engine.js";

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
const ROLE_NAME = { dig: "Dig", build: "Build", buy: "Buy", earn: "Earn", special: "Special" };
const ROLE_COLOUR = { dig: "brown", build: "green", buy: "blue", earn: "yellow", special: "purple" };
const role = (r) => h("b", { class: `dot c-${ROLE_COLOUR[r]}` }, icon(ROLE_ICON[r]), " ", ROLE_NAME[r]);

/**
 * The rules as a DOM element.
 * game: a game state (or a preview of one) for its config, map and building types.
 * extra: { startingDeck: [[role, n], ...], notation: [{code, meaning}], onClose }.
 */
export function rulesView(game, extra = {}) {
  const c = game.config;
  const players = game.players.length;
  const types = game.buildingTypes || [];
  const typed = c.buildingTypes && types.length > 1;
  const mats = !!c.materials;
  const terrain = game.board.terrain;
  const land = Object.values(terrain).filter((t) => !t.water);
  const cost = (k) => land.map((t) => `${t.name.toLowerCase()} ${t[k]}`).join(", ");
  const track = String(c.marketTrack || "").split(",").map(Number).filter((n) => !Number.isNaN(n));
  const perPlayer = Number(c.inlandMilestonePerPlayer) || 0;
  const need = (n) => Math.max(1, Math.floor(perPlayer * n));
  const reward = { "+1C": "an extra buy, at once", "+1D": "an extra dig, at once", "+1B": "an extra build, at once", "+3M": "3 money" }[c.milestoneReward] || c.milestoneReward;
  const deck = (extra.startingDeck || []).filter(([, n]) => n);
  const deckSize = deck.reduce((a, [, n]) => a + n, 0);
  // Card weights by deck (rule cardWeights), e.g. { starting: 0, coastal: 1, inland: 2 }.
  const weights = Object.fromEntries(String(c.cardWeights || "").split(",").filter((x) => x.includes("="))
    .map((x) => x.split("=")).map(([k, v]) => [k.trim().toLowerCase(), Number(v)]));
  const weighted = Object.keys(weights).length > 0;
  const w = (deck) => weights[deck] ?? 1;
  const split = !!c.inlandDisplay;
  const ends = [c.endOnMarket ? "the market decks run out" : null, c.endOnKeys ? (c.endKeysBand ? `every key tile in the ${c.endKeysBand} is on the network` : "every key tile is on the network") : null].filter(Boolean);
  const endLine = ends.length
    ? `The game ends at the end of the round in which ${ends.join(", or ")} (after round ${c.rounds} at the latest)`
    : `The game ends after round ${c.rounds}`;

  const bands = Object.values(game.board.hexes).some((hx) => hx.band === "highland");
  const bandPts = String(c.reachBands || "").split(",").filter(Boolean).join(" / ") || String(c.vpPerReach);
  const hasLakes = Object.values(game.board.hexes).some((hx) => terrain[hx.terrain].water && hx.band);
  const hasCrags = Object.values(game.board.hexes).some((hx) => terrain[hx.terrain].wall);
  const feats = Object.fromEntries(Object.values(game.board.hexes).filter((hx) => hx.feature).map((hx) => [hx.feature, game.board.features[hx.feature]]));
  const tokenNames = [...new Set(Object.values(game.tokens || {}).map((t) => `${t.name} ${t.code}`))];
  const tokens = tokenNames.length ? tokenNames.join(", ") : "";

  const sections = [
    ["goal", "The goal"], ["stuff", "What you have"], ["setup", "Setting up"], ["turn", "Your turn"],
    ["actions", "The actions"], ["map", "The map"], ["buildings", "Buildings"], ...(mats ? [["resources", "Resources"]] : []),
    ...(c.pearls ? [["pearls", "Pearls"]] : []), ["market", "The market"], ["end", "Game end"], ["notation", "Reading the cards"],
  ];
  const sec = (id, ...kids) => h("section", { id: `rules-${id}` }, h("h2", {}, sections.find((s) => s[0] === id)[1]), ...kids);
  const glossaryItem = (id, title, text) => h("div", {}, icon(id), h("div", {}, h("b", {}, title), " ", text));

  const steps = E.multiplierSteps(c);
  const lanes = [
    ["dig", "i-dig", "Dig cards", "×", "your buildings' VP", `Each building scores ${c.vpPerBuilding} VP${typed ? ", unless its type says otherwise" : ""}.`],
    ["build", "i-build", "Build cards", "×", "your deck's VP", "The VP printed on cards you own (Special cards carry it)."],
    ["buy", "i-buy", "Buy cards", "×", "your Reach", `${c.vpPerReach} for every inland hex your canals opened.`],
    ["special", "i-special", "Special cards", "×", "your keys", `${c.vpPerKey} VP for each key.`],
  ];

  return h("article", { class: "rules", "aria-label": "How to play" },
    h("header", {}, h("h1", {}, icon("i-reach", "big"), "How to play Canals"),
      extra.onClose ? h("button", { class: "primary", onclick: extra.onClose }, extra.closeLabel || "Close") : null),
    h("p", { class: "lede" }, "You lead a family of water animals who want to travel inland. Your deck is the land animals you hire: ",
      "they dig canals from the coast, raise buildings along the banks and haggle at the market. Everyone's canals join into one shared network, ",
      `but each canal and building is yours. ${endLine}; the player with the most points wins.`),
    h("nav", { "aria-label": "Sections" }, sections.map(([id, t]) => h("a", { href: `#rules-${id}`, onclick: (e) => {
      e.preventDefault(); document.getElementById(`rules-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } }, t))),

    sec("goal",
      h("p", {}, "Points come from four ", h("b", {}, "lanes"), ". Each lane multiplies ", h("b", {}, "how many cards of one colour you own"),
        " by a score you build on the map or in your deck:"),
      h("div", { class: "lanes4" }, lanes.map(([r, ic, a, x, b, note]) => h("div", { class: `lane c-${ROLE_COLOUR[r]}` },
        icon(ic, "big"), h("b", {}, `${a} ${x} ${b}`), h("span", { class: "muted" }, note)))),
      h("p", {}, "Every card you own counts: hand, draw pile and discard pile. ",
        weighted ? [h("b", {}, `Starting cards count ${w("starting")}`), `, coastal market cards ${w("coastal")} each and inland cards ${w("inland")} each`,
          w("starting") === 0 ? ", so trashing a starting card costs no points. " : ". "] : "",
        role("earn"),
        " cards score nothing; they are money. No colour multiplies a score its own action builds, so you always need two things at once: ",
        "the cards for a lane, and the work on the map or in the market that feeds it."),
      steps ? h("div", { class: "box" }, h("b", {}, "Multipliers in steps. "),
        "Count a colour's cards (weighted as above), then read its multiplier off the steps: ",
        h("table", { class: "steps" },
          h("tr", {}, h("th", {}, "Count"), steps.map(([at], i) => h("td", {}, i + 1 < steps.length ? (steps[i + 1][0] - 1 > at ? `${at}–${steps[i + 1][0] - 1}` : `${at}`) : `${at}+`))),
          h("tr", {}, h("th", {}, "Multiplier"), steps.map(([, m]) => h("td", {}, `×${m}`)))),
        "Every lane scores at least once, and one more card can take you up a step.") : null,
      !steps ? h("div", { class: "box" }, h("b", {}, "Example. "), weighted
        ? `You own 2 coastal and 1 inland Dig card (${2 * w("coastal")} + ${w("inland")} = ${2 * w("coastal") + w("inland")}) and buildings worth 10 VP: that lane scores ${2 * w("coastal") + w("inland")} × 10 = ${10 * (2 * w("coastal") + w("inland"))}. `
        : `You own 4 Dig cards and buildings worth 10 VP: that lane scores 4 × 10 = 40. `,
        `With 3 Buy cards and a Reach of 6, the Reach lane scores 3 × ${6 * c.vpPerReach} = ${18 * c.vpPerReach}.`) : null,
      h("p", { class: "muted" }, "The player panels show each lane as cards × score, and the total if the game ended now.")),

    sec("stuff",
      h("div", { class: "glossary" },
        glossaryItem("i-coin", "Money.", "Pays for digs, builds and cards. The only thing you keep from turn to turn, apart from pearls."),
        glossaryItem("i-income", "Income.", `What an Earn pays. Starts at ${c.startingIncome}; each building adds ${c.incomePerBuilding}${typed ? " (a Mill more)" : ""}.`),
        glossaryItem("i-hand", "Hand.", `You hold ${c.handSize} cards (more with +1S, up to ${c.handSizeCap}).`),
        glossaryItem("i-deck", "Deck.", "Your cards: draw pile, hand and discard pile. Bought cards go to your discard pile."),
        c.pearls ? glossaryItem("i-pearl", "Pearls.", c.pearlEarning === "track"
          ? `Earned on your pearl track, one space for each card you keep at the end of a turn; at most ${c.pearlCap}. Spent on later turns.`
          : `Earned by keeping your cards; at most ${c.pearlCap}. Spent on later turns.`) : null,
        glossaryItem("i-key", "Keys.", "One for each building on a key tile."),
        glossaryItem("i-reach", "Reach.", "Inland hexes your canals opened (see The map)."),
        mats ? glossaryItem("cube-clay", "Cubes.", "Clay, wood and stone on the board, taken by builds. Nobody holds them.") : null)),

    sec("setup",
      h("ol", {},
        h("li", {}, `The board grows with the number of players: this one is set for ${plural(players, "player")}.`),
        h("li", {}, "Each player takes a starting deck", deckSize ? ` of ${deckSize} cards (` : "", deck.map(([r, n], i) => [i ? ", " : "", `${n} ${ROLE_NAME[r]}`]), deckSize ? ")" : "",
          `, shuffles it and draws ${c.handSize}.`),
        h("li", {}, `Each player starts with ${c.startingPurse} money and income ${c.startingIncome}.`),
        c.ownHarbours ? h("li", {}, "Each player takes a harbour, spread along the coast in seat order (the first player the one furthest left). Any other harbours belong to nobody.") : null,
        c.deckSizes ? h("li", {}, "Fewer players use fewer market cards. Before shuffling, set aside copies until each deck holds: ",
          h("table", { class: "steps" }, h("tr", {}, h("th", {}, "Players"), [2, 3, 4, 5].map((n) => h("td", {}, n))),
            String(c.deckSizes).split(",").map((part) => part.split("=").map((x) => x.trim())).filter(([d, v]) => d && v)
              .map(([d, v]) => h("tr", {}, h("th", {}, d), v.split("/").map((n) => h("td", {}, n))))),
          "Set aside Earn copies first, then from the design with the most copies; every design keeps at least one.") : null,
        h("li", {}, "Make the market decks. Shuffle the ", h("b", {}, "coastal"), " cards and the ", h("b", {}, "coastal-2"),
          " cards separately and stack the coastal cards on top; do the same with the ", h("b", {}, "inland"), " and ", h("b", {}, "inland-2"), " cards. ",
          `Lay ${c.displaySize} coastal cards face up. `, split ? "The inland deck waits face down until the inland opens." : "The inland deck waits until the inland opens, then joins the coastal deck."),
        mats ? h("li", {}, `Fill the import market: ${track.length} cubes each of clay, wood and stone.`) : null)),

    sec("turn",
      h("p", {}, "Players take turns in order. On your turn:"),
      h("ol", {},
        h("li", {}, h("b", {}, "Play one card"), " from your hand.",
          c.forageOne > 0 || c.forageHand > 0 ? [" Or ", h("b", {}, "forage"), ": ",
            c.forageOne > 0 ? `discard one card face down for ${c.forageOne} money` : "",
            c.forageOne > 0 && c.forageHand > 0 ? ", or " : "",
            c.forageHand > 0 ? `your whole hand for ${c.forageHand}` : "",
            ". That is your turn: no actions, no boost, and no pearl track progress."] : ""),
        h("li", {}, h("b", {}, "Boost it if you like"), " by discarding other cards from your hand. The card says what a boost costs and gives: ",
          h("code", {}, "D2"), " means discard exactly two; ", h("code", {}, "D"), " means any number, with ", h("code", {}, "/D"), " effects counted per card; ",
          h("code", {}, "XD"), " means discard one Dig card (", h("code", {}, "XB"), " Build, ", h("code", {}, "XC"), " Buy, ", h("code", {}, "XE"), " Earn)."),
        h("li", {}, h("b", {}, "Do what it gives"), ", in any order: its actions (dig, build, buy, earn), plus any extra actions, discounts or money from the boost. ",
          "A discount applies to every action of its kind this turn. Unused actions are lost at the end of the turn."),
        h("li", {}, h("b", {}, "Refill"), ` your hand to ${c.handSize} (or your hand size). When your draw pile runs out, shuffle your discard pile into it.`)),
      h("div", { class: "box" }, h("b", {}, "Discard or keep? "),
        "Discarding makes this turn stronger and cycles your deck faster, so you see your best cards sooner. ",
        c.pearls ? (c.pearlEarning === "track"
          ? ["Every card still in your hand at the end of your turn moves your ", icon("i-pearl"), " pearl track a space toward the next pearl."]
          : ["Keeping your cards earns a ", icon("i-pearl"), " pearl to spend later."]) : "Keeping them keeps your next turn certain.")),

    sec("actions",
      h("h3", {}, icon("i-dig"), "Dig"),
      h("p", {}, "Dig one canal along the border between two land hexes, and mark it as yours. It costs the dearer of the two hexes' dig costs (",
        cost("digCost"), "). ", h("b", {}, "A canal must extend the network"), ": it starts at a harbour mouth or shares a corner with a canal (anyone's) already linked to the sea. ",
        "Some animal cards may also dig away from the network on their own ground; such a canal is cut off, and scores nothing, until someone links it."),
      c.ownHarbours ? h("div", { class: "box" }, h("b", {}, "Your own harbour. "),
        "Each player has a harbour, marked with a pennant in their colour. ", h("b", {}, "Starting dig cards"),
        " only dig from your own harbour's mouths or along your own canals that are linked to the sea. ",
        h("b", {}, "Bought dig cards"), " may start at any harbour or join anyone's linked canals: buy them to reach beyond your own network.",
        c.harbourDraft ? [" ", h("b", {}, "Choosing harbours: "), "before the first turn, players choose their harbours in reverse seat order, so the last seat chooses first. ",
          `A deep harbour, one that reaches the inland in at least two canals fewer than most, costs ${c.harbourPremium} of your starting money.`] : "") : null,
      h("h3", {}, icon("i-build"), "Build"),
      h("p", {}, "Build on a hex with a building site", c.buildNeedsNetwork ? " that is on the network (a linked canal runs along one of its borders)" : "", ". ",
        `Pay the hex's build cost (${cost("buildCost")})${typed ? ", plus the building type's extra cost" : ""}${mats ? ", plus the cubes it needs" : ""}. `,
        c.techBoard && c.techBoard !== "off" ? "Its token comes from your board, and it raises your income by what that slot shows (see Buildings). "
          : `Each building raises your income by ${c.incomePerBuilding}. `, "A building on a key tile gives you a key. One building per hex."),
      h("h3", {}, icon("i-buy"), "Buy"),
      h("p", {}, "Buy one card from the market display: pay its cost and put it on your discard pile. The display refills at once.",
        E.topCost({ config: c }) !== null ? ` Or pay ${c.buyOnTopCost} more to put it on top of your draw pile: you draw it at the end of the turn and can play it on the next.` : ""),
      h("h3", {}, icon("i-earn"), "Earn"),
      h("p", {}, "Take money equal to your income. ", h("code", {}, "Earn 1"), " pays it once."),
      h("h3", {}, icon("i-special"), "Special"),
      h("p", {}, "Purple cards do what they say, and carry VP for the deck lane. They help your network in general, but never take keys directly.")),

    sec("map",
      h("div", { class: "glossary" },
        glossaryItem("m-harbour", "Harbours.", "Canals reach the land only here. The dots at a harbour's corners on the sea are its mouths, where canals start."),
        glossaryItem("i-reach", "Corners.", "Canals run along hex borders and join only where they share a corner, like roads in Catan."),
        glossaryItem("m-key", "Key tiles.", `Build here for a key: ${c.vpPerKey} VP, times your Special cards.`),
        glossaryItem("m-discovery", "Discoveries.", "A one-off bonus, such as +2M. The dig that opens the hex takes it."),
        bands ? glossaryItem("i-reach", "Three bands.", `The coast, the inland and the highland, each dearer to dig and build on (${cost("digCost")}). An opened hex is worth ${bandPts} Reach, coast / inland / highland.`) : null,
        bands ? glossaryItem("i-dig", "The highland.", c.highlandNeedsBought ? "Only bought dig cards dig a border that touches the highland; starting cards can't." : "Dug like anywhere else, at its higher cost.") : null,
        hasLakes ? glossaryItem("i-reach", "Lakes.", "Inland water. Once a linked canal reaches one of a lake's corners, all its corners are linked: a free junction to the far side.") : null,
        feats.hills ? glossaryItem("i-dig", "Hills.", `Inland and highland: +${feats.hills.digMod} to dig a border beside them, and a building on hills scores +${feats.hills.vpBonus} VP. The stone is in the hills.`) : null,
        feats.marsh ? glossaryItem("i-reach", "Marsh.", `${-feats.marsh.digMod} cheaper to dig, no building site, and +${feats.marsh.reachBonus} Reach when opened.`) : null,
        tokens ? glossaryItem("m-discovery", "Site tokens.", `Dealt face up on marked sites each game (${tokens}). The first building on the site takes it, as part of the card that built it.`) : null,
        hasCrags ? glossaryItem("i-dig", "Crags.", "A ridge before the highland: no building site, and no canal between two crags. Go through a pass.") : null,
        mats ? glossaryItem("m-forest", "Forests, mountains, clay beds.", "Sources of wood, stone and clay (see Resources).") : null),
      h("h3", {}, "Opening hexes: your Reach"),
      h("p", {}, "A land hex is ", h("b", {}, "opened"), " when a linked canal runs along one of its borders and the hex does not touch open water. ",
        "Hexes beside the sea were always reachable, so they never count. ", h("b", {}, "Your Reach"),
        " is the number of opened hexes that touch at least one of your own canals. Two players whose canals touch the same opened hex both count it. ",
        "On the board, opened hexes are drawn brighter, with a blue outline."),
      c.inlandMilestone && c.inlandMilestone !== "none" ? [
        h("h3", {}, "The inland opens mid-game"),
        h("p", {}, "At first only the coast is open: no canal may have inland hexes on both sides, and nothing is built inland (inland hexes are greyed). ",
          c.inlandMilestone === "canals"
            ? `When the network has ${perPlayer} canals per player bordering inland hexes, rounded down (${[2, 3, 4].map((n) => `${need(n)} at ${n} players`).join(", ")}), `
            : "When the milestone is reached, ",
          split ? `the whole inland opens at once, and ${c.displaySize} inland cards are laid out as a second market display.`
            : "the whole inland opens at once, and the inland market cards shuffle into the market.",
          reward ? ` The player whose dig reaches the milestone takes ${reward}.` : ""),
      ] : null),

    sec("buildings",
      typed ? [
        h("p", {}, "When you build, choose a type. Each has the plain building's effect (", `${c.vpPerBuilding} VP, +${c.incomePerBuilding} income`,
          ") unless it says otherwise, plus its own."),
        h("table", {},
          h("thead", {}, h("tr", {}, ["", "Type", "Cost", mats ? "Needs" : null, "Effect", "Limit"].filter((x) => x !== null).map((t) => h("th", {}, t)))),
          h("tbody", {}, types.map((bt) => h("tr", {},
            h("td", { style: "--pc:#c96f4a" }, icon(hasSymbol(`b-${bt.id}`) ? `b-${bt.id}` : "b-plain", "", null, "#c96f4a")),
            h("td", {}, h("b", {}, bt.name)),
            h("td", {}, bt.extraCost ? `site +${bt.extraCost}` : "site"),
            mats ? h("td", {}, (bt.needs || []).length ? bt.needs.map((r) => [icon(`cube-${r}`), " "]) : "—") : null,
            h("td", {}, bt.rules),
            h("td", {}, c.techBoard && c.techBoard !== "off" ? "on your board" : bt.supply ? `${bt.supply} per player` : "—"))))),
        c.techBoard && c.techBoard !== "off" ? h("div", { class: "box" }, h("b", {}, "Your board. "),
          "Every building you build comes from your own board: a honeycomb of eighteen tokens around an open centre, six on the inner ring and twelve on the outer. ",
          "Take the token from a slot ", h("b", {}, "next to an open one"), ": the centre, or a slot you have already emptied. ",
          `To take one from anywhere else, pay ${c.techLeapCost} pearl (a leap). When the tokens of a type are gone, you build no more of it. `,
          "Buildings raise your income only by what their slot shows: +1 under each inner slot, nothing under the outer ones (a Mill adds its own +1). ",
          "The Mill, Quarry, Inn and Lock sit only on the outer ring.") : null,
        h("p", { class: "muted" }, "Hover a building on the board for its rule. Building something other than an extractor on a forest, mountain or clay bed uses the resource up."),
      ] : h("p", {}, `Every building scores ${c.vpPerBuilding} VP and raises your income by ${c.incomePerBuilding}.`)),

    mats && c.hauling === "tolls" ? sec("resources",
      h("p", {}, "Most building types need clay, wood or stone. A build takes each from the ", h("b", {}, "cheapest source"), ", carried along linked canals:"),
      h("ul", {},
        h("li", {}, h("b", {}, "Clay"), " comes from any hex on the shore, free."),
        h("li", {}, h("b", {}, "Wood"), " comes from a Logging camp (on a forest), ", h("b", {}, "stone"), " from a Quarry (on hills with stone). ",
          `They never run out. Each costs ${c.extractionFee}, paid to the owner; yours are free.`),
        h("li", {}, h("b", {}, "Tolls. "), `Every canal of someone else's the load passes costs ${c.tollPerCanal}, paid to that canal's owner`,
          c.tollMode === "owner" ? " (once per player, however many of their canals)" : "",
          `. Your own canals are free. Stone is heavy: ${c.stoneBankToll} more per canal to the bank, on your own canals too. A site on or beside its source pays no tolls.`),
        h("li", {}, h("b", {}, "A Lock"), " earns its owner 1 from the bank for every load carried through a canal on its borders, theirs included.")),
      h("p", {}, "So a canal on a busy route is a toll road: others pay you every time they build past it."),
      h("p", { class: "muted" }, "Hover a hex you can build on to see the full price and where each resource comes from.")) : null,
    mats && c.hauling !== "tolls" ? sec("resources",
      h("p", {}, "Clay, wood and stone are cubes on the board. ", icon("cube-clay"), icon("cube-wood"), icon("cube-stone"),
        " A building type needs one cube, which the build takes from the ", h("b", {}, "cheapest connected source"), ":"),
      h("ul", {},
        h("li", {}, h("b", {}, "An extractor"), " (Clay pit, Logging camp or Quarry) holds the cubes it put on its hex. ",
          `Each costs ${c.extractionFee}, paid to its owner (yours are free), plus ${c.haulPerEdge} per canal edge to haul it to the site.`),
        h("li", {}, h("b", {}, "The import market"), " sells through a harbour (or a Transport hub), plus the haul from there. ",
          `Prices climb as it empties: ${track.join(", ")}, then ${c.marketEmptyPrice} once a resource runs out. It never refills.`)),
      h("p", { class: "muted" }, "Hover a hex you can build on to see the full price and where each cube comes from.")) : null,

    c.pearls ? sec("pearls",
      c.pearlEarning === "track" ? [
        h("p", {}, "At the end of your turn, before you refill, move your ", h("b", {}, "pearl track"), " one space for each card still in your hand ",
          "(not played, discarded or trashed). When it reaches the threshold, take a pearl ", icon("i-pearl"), " and set the marker back to 0. ",
          `You hold at most ${c.pearlCap}; at the cap the marker waits, full, until you have room. `,
          "Some cards move the marker further (", h("code", {}, "+2PT"), ": two more spaces) or give a pearl outright (", h("code", {}, "+1P"), ", also at the end of the turn)."),
        h("div", { class: "box" }, h("b", {}, "The threshold"), ` is ${c.pearlThreshold}, plus`,
          h("ul", {},
            c.pearlStoredStep ? h("li", {}, `${c.pearlStoredStep === 1 ? "1" : c.pearlStoredStep} for each pearl you are holding: hoard, and the next comes slower;`) : null,
            c.pearlUsedDivisor ? h("li", {}, `1 for every ${c.pearlUsedDivisor} pearls you have used this game;`) : null,
            c.pearlHandStep ? h("li", {}, `${c.pearlHandStep === 1 ? "1" : c.pearlHandStep} for each card of hand size above ${c.handSize}.`) : null),
          "So spending regularly keeps pearls coming, and expect 6 or 7 in a game: when to use them is the choice."),
        h("p", {}, "On a later turn, while doing your actions, spend them:")]
      : h("p", {}, "End a turn ", h("b", {}, "without discarding"), " and take a pearl ", icon("i-pearl"), ` (hold at most ${c.pearlCap}). `,
        "On a later turn, while doing your actions, spend them:"),
      h("table", {}, h("tbody", {},
        h("tr", {}, h("td", {}, "1 pearl"), h("td", {}, `+${c.pearlMoney} money`)),
        h("tr", {}, h("td", {}, "1 pearl"), h("td", {}, "Redraw: put a card from your hand on your discard pile and draw one")),
        h("tr", {}, h("td", {}, `${c.pearlActionCost} pearls`), h("td", {}, "One more action of the played card's kind (dig, build or buy), at full cost")))),
      h("p", { class: "muted" }, "A pearl taken this turn can't be spent until your next one. Unspent pearls score nothing.")) : null,

    sec("market",
      h("p", {}, split
        ? [`There are two market decks, each with its own display of ${c.displaySize} cards: coastal from the start, inland once the inland opens. `,
          "Buying a card refills its display from its own deck. If the coastal deck and display run out before the inland opens, there is nothing to buy until it does."]
        : [`${c.displaySize} cards lie face up. Buying one refills the display from the market deck. `,
          "Only coastal cards are in it at first; the inland cards join when the inland opens."]),
      h("p", {}, "Each deck comes in two tiers: the tier-2 cards (", h("b", {}, "coastal-2"), ", ", h("b", {}, "inland-2"),
        ") come out once tier 1 is used up. They do two actions or more from one card: by then, a starting card is a weak draw, and trashing it is worth a turn."),
      c.marketClock && c.marketClock !== "off" ? h("p", {}, h("b", {}, "The market clock. "),
        c.marketClock === "unbought"
          ? "At the end of every round, in each display nobody bought from that round, the card that has been there longest leaves the game, and the display refills. "
          : "At the end of every round, the card that has been in each display longest leaves the game, and the display refills. ",
        "So the market keeps moving even when nobody buys, and the decks run down toward the end of the game.") : null,
      h("p", {}, "Read the market: the colours you buy are your multipliers."),
      h("p", {}, "Each card shows its colour and action in the band, its cost on the coin, its effect, and below that its boost: what to discard, then what it gives.")),

    sec("end",
      h("p", {}, `${endLine}. Everyone has had the same number of turns. Score the four lanes; the most points wins. Ties go to the player with more money.`),
      ends.length ? h("p", { class: "muted" }, "Rushing the key tiles ends the game early; building up a deck and buying through the market makes it longer.") : null),

    sec("notation",
      h("p", {}, "Card effects use short codes. Hover a code on any card for its meaning."),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Code"), h("th", {}, "Means"))),
        h("tbody", {}, (extra.notation || []).filter((n) => n.code).map((n) => h("tr", {}, h("td", {}, h("code", {}, n.code)), h("td", {}, n.meaning)))))),
  );
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

// Staged positions for the rules' map snapshots: hypothetical games in
// progress on the western end of the map (the part every player count shares).
// Engine only, no drawing, so web/test can check that every canal and
// building in them could have been played. rules.js draws them with
// board.js renderExcerpt.
import * as E from "./engine.js";

export const CAST = ["Hazel", "Bramble", "Rush"];
const HARBOURS = ["2,2", "1,1"];   // Rush keeps out of the pictures

const HAZEL_TO_VILLAGE = ["1,3|2,2", "1,3|2,3", "1,4|2,3", "1,4|2,4", "1,5|2,4", "1,5|2,5", "1,5|1,6"];

/**
 * The scenes, each in the order it was played: digs [player, edge] and builds
 * [player, hex, type]. tide: the tide it shows (1 the coast only).
 */
export const SCENES = {
  // Two families' first canals. Bramble's third is a bought dig card joining Hazel's.
  first: {
    tide: 1,
    moves: [[0, "dig", "1,3|2,2"], [1, "dig", "0,2|1,1"], [0, "dig", "1,3|2,3"], [1, "dig", "0,1|0,2"],
      [0, "dig", "1,4|2,3"], [1, "dig", "1,3|1,4", "bought"]],
    hexes: ["0,1", "1,1", "2,1", "-1,2", "0,2", "2,2", "3,2", "-1,3", "0,3", "1,3", "2,3", "3,3", "0,4", "1,4", "2,4", "3,4"],
  },
  // Hazel has dug to a spring village; Bramble joins her network beside it.
  village: {
    tide: 2,
    moves: [...HAZEL_TO_VILLAGE.map((ek) => [0, "dig", ek]), [0, "build", "2,3", "wharf"], [0, "build", "1,4", "camp"],
      [0, "build", "1,6", "burrow"], [1, "dig", "0,2|1,1"], [1, "dig", "0,6|1,6", "bought"]],
    after: [[1, "build", "1,6", "mill"]],
    hexes: ["1,3", "2,3", "3,3", "0,4", "1,4", "2,4", "0,5", "1,5", "2,5", "0,6", "1,6", "2,6", "0,7", "1,7"],
    route: ["1,5|2,4", "1,5|2,5"],
  },
  // The whole western end, early: the coast open, the meadows and highland waiting.
  bands: {
    tide: 1,
    moves: [[0, "dig", "1,3|2,2"], [0, "dig", "1,3|2,3"], [1, "dig", "0,2|1,1"], [1, "dig", "0,1|0,2"]],
    hexes: ["0,0", "4,0", "-4,9", "1,9", "-4,8", "4,1"],
    labels: [{ hex: "3,3", text: "the coast" }, { hex: "1,6", text: "the meadows", dy: 0.62 }, { hex: "-1,8", text: "the highland", dy: 0.62 }],
  },
};

/** The map's own sample of each thing in the legend. */
export const LEGEND = {
  harbour: "2,2", village: "1,6", discovery: "3,3", forest: "1,4", stone: "0,5", marsh: "-2,4",
  lake: "-1,6", crag: "-3,8", site: "0,3", opened: "2,3", highland: "-1,8",
};

/** A fresh copy of `game` with nothing played, the cast seated and harbours dealt. */
export function blankStage(game, tide = 1) {
  const s = E.cloneState(game);
  const base = game.players[0];
  s.players = CAST.map((name, i) => ({ ...structuredClone(game.players[i] || base), name, colour: E.PLAYER_COLOURS[i], taken: [], keys: 0 }));
  s.harbours = HARBOURS.slice();
  s.dug = {}; s.buildings = {}; s.claimed = {}; s.tokens = {}; s.tokenClaimed = {}; s.wear = {}; s.capstones = {}; s.prizes = {};
  s.tide = tide;
  s.inlandOpen = tide >= 2;
  s.current = 0;
  s.turn = { phase: "resolve", pool: {}, actions: [], discards: [] };
  s.quiet = true;
  return s;
}

/** Play the moves onto a stage, as placed pieces (no money changes hands). */
export function place(s, moves) {
  for (const [p, kind, where, what] of moves) {
    if (kind === "dig") s.dug[where] = p;
    else {
      (s.buildings[where] ||= []).push({ p, type: what });
      if (s.board.hexes[where]?.isKey) s.players[p].keys += E.villageKeys(s, where);
    }
  }
  return s;
}

/** A scene's position (before its `after` moves unless `after` is true). */
export function scene(game, name, after = false) {
  const sc = SCENES[name];
  const s = place(blankStage(game, sc.tide), sc.moves);
  return after && sc.after ? place(s, sc.after) : s;
}

/**
 * Check a scene through the engine's own rules: every move must have been
 * legal when played. Returns a list of problems (empty when all is well).
 */
export function checkScene(game, name) {
  const sc = SCENES[name], s = blankStage(game, sc.tide), errs = [];
  for (const m of [...sc.moves, ...(sc.after || [])]) {
    const [p, kind, where, what] = m;
    s.current = p;
    s.players[p].money = 99; s.players[p].pearls = 9;
    s.turn = { phase: "resolve", pool: { [kind]: 1 }, actions: [], discards: [], starter: what !== "bought", ownOnly: what === "bought" ? -1 : p };
    const r = kind === "dig" ? E.dig(s, where) : E.build(s, where, what);
    if (!r.ok) errs.push(`${name}: ${CAST[p]} ${kind} ${where}${what ? ` ${what}` : ""}: ${r.reason || r.error || JSON.stringify(r)}`);
  }
  return errs;
}

// Moves as plain data. Every change a player makes to the game is one of
// these, so the same move can be made on this device or sent over the network
// to the device that hosts an online game, which applies it for everyone.
//
//   { type: "play", play: uid, discards: [uid] }   play a card (cards are numbered), discarding to boost it
//   { type: "dig", edge }                          dig the border `edge` ("q,r|q,r")
//   { type: "build", hex, kind }                   build a building of type `kind`
//   { type: "buy", slot }                          buy the market card in `slot`
//   { type: "trash", uid, from: "hand"|"discard" }
//   { type: "pearl", kind: "money"|"redraw"|"action", uid }
//   { type: "end" }                                end the turn
//   { type: "pass" }                               end the turn with an empty hand
//   { type: "harbour", hex }                       choose a harbour in the harbour draft
import * as E from "./engine.js";

const fail = (reason) => ({ ok: false, reason });

/** Check that `cmd` is a well-formed move; the engine checks it is legal. */
export function validCommand(cmd) {
  if (!cmd || typeof cmd !== "object") return false;
  const str = (v) => typeof v === "string" && v.length < 64;
  const int = (v) => Number.isInteger(v) && v >= 0 && v < 100000;
  const card = int;   // cards in play are numbered
  switch (cmd.type) {
    case "play": return card(cmd.play) && Array.isArray(cmd.discards) && cmd.discards.length < 12 && cmd.discards.every(card);
    case "dig": return str(cmd.edge);
    case "build": return str(cmd.hex) && (cmd.kind === undefined || str(cmd.kind));
    case "buy": return int(cmd.slot) && (cmd.top === undefined || typeof cmd.top === "boolean");
    case "forage": return cmd.uid === "hand" || card(cmd.uid);
    case "trash": return card(cmd.uid) && (cmd.from === "hand" || cmd.from === "discard");
    case "pearl": return ["money", "redraw", "action"].includes(cmd.kind) && (cmd.uid === undefined || card(cmd.uid));
    case "end": case "pass": return true;
    case "harbour": return str(cmd.hex);
    default: return false;
  }
}

/**
 * Apply a move to `state` in place. Returns { ok, reason, ended, reveals }:
 * `ended` when the turn passed to the next player, `reveals` when the move
 * showed hidden information (a new market card, a drawn card), so it can't be
 * undone.
 */
export function applyCommand(state, cmd) {
  if (!validCommand(cmd)) return fail("not a move");
  if (state.over) return fail("the game is over");
  let res, reveals = false, ended = false;
  switch (cmd.type) {
    case "play": res = E.playCard(state, cmd.play, cmd.discards); break;
    case "dig": res = E.dig(state, cmd.edge); break;
    case "harbour": res = E.chooseHarbour(state, cmd.hex); ended = res.ok; break;
    case "build": res = E.build(state, cmd.hex, cmd.kind); break;
    case "buy": res = E.buy(state, cmd.slot, !!cmd.top); reveals = true; break;
    case "trash": res = E.trash(state, cmd.uid, cmd.from); break;
    case "pearl": res = E.spendPearl(state, cmd.kind, cmd.uid); reveals = cmd.kind === "redraw"; break;
    case "end": case "pass": case "forage": {
      const me = E.currentPlayer(state);
      // pass and forage end the turn themselves
      res = cmd.type === "pass" ? E.pass(state) : cmd.type === "forage" ? E.forage(state, cmd.uid) : E.endTurn(state);
      if (res.ok) { me.seen = state.log.length; ended = true; }       // their next recap starts here
      break;
    }
  }
  return res.ok ? { ok: true, ended, reveals } : { ok: false, reason: res.reason };
}

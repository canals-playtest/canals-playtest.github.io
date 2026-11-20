// The bots' reward (docs/bot-campaigns.md 6): winning comes first. Between two
// wins the bigger margin is better, but a loss with a high score of one's own
// counts for less than a win with a low one.
//
// - At the end: R = W × won + margin, where won is 1 for first place (a share
//   of it in a tie, as the rules break ties) and margin is one's score less
//   the best other's.
// - Before the end: R = W × P(win) + margin, with P(win) the chance that a lead
//   of so many points, with so many rounds left, ends as a win. Its numbers
//   are fitted from played games (tools/fit_reward.mjs, bots/reward-fit.json).
import * as E from "./engine.js";

// Fitted on 950 four-player games of trained project bots (v2-training,
// learn-expert, 2026-11-20); replaced by setRewardFit when a newer fit is loaded.
let FIT = { a: -0.838, k: 0.0838, g: 0.4, winBonus: 50 };
export function setRewardFit(f) { if (f && Number.isFinite(f.k)) FIT = { ...FIT, ...f }; }
export const rewardFit = () => ({ ...FIT });

/** The chance of winning from a lead in points with so many rounds left. */
export function pWin(lead, left) {
  return 1 / (1 + Math.exp(-(FIT.a + (FIT.k * lead) / Math.pow(Math.max(0, left) + 1, FIT.g))));
}

/** Seat me's lead in points: its score less the best other seat's. */
export function scoreLead(st, me) {
  const sc = st.players.map((_, i) => E.score(st, i).total);
  let best = -Infinity;
  for (let i = 0; i < sc.length; i++) if (i !== me) best = Math.max(best, sc[i]);
  return sc[me] - best;
}

/** At the end of a game: { won, margin, R }. A tie for first, as the rules cannot break it, shares the win. */
export function finalReward(st, me) {
  const rank = E.ranking(st);
  const sc = st.players.map((_, i) => E.score(st, i).total);
  const top = rank[0];
  const tied = rank.filter((x) => sc[x.i] === sc[top.i] && st.players[x.i].money === st.players[top.i].money).map((x) => x.i);
  const won = tied.includes(me) ? 1 / tied.length : 0;
  let best = -Infinity;
  for (let i = 0; i < sc.length; i++) if (i !== me) best = Math.max(best, sc[i]);
  const margin = sc[me] - best;
  return { won, margin, R: FIT.winBonus * won + margin };
}

/**
 * Before the end: the win bonus by the chance of winning, plus a margin. The
 * margin is the caller's own reckoning of the position (a bot's value of it,
 * which counts more than points on the board); the chance comes from the
 * points on the board, which is what the fit knows.
 */
export function positionReward(st, me, margin) {
  if (st.over) return finalReward(st, me).R;
  return FIT.winBonus * pWin(scoreLead(st, me), E.roundsLeft(st)) + margin;
}

// Ranking score: a fixed linear weighted sum of the nine point-giving stats
// (SPEC §2). Missing stat keys count as 0, so enchant stat blocks (which omit
// zero-valued stats) can be scored directly.

import { RANKING_WEIGHTS } from "./config.js";

export function score(stats) {
  let total = 0;
  for (const [key, weight] of Object.entries(RANKING_WEIGHTS)) {
    total += (stats[key] || 0) * weight;
  }
  return total;
}

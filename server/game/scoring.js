// wrong = 0. correct = base scaled down to 50% over the time limit, plus a streak bonus.
// streakBefore is the run the player was already on, so the first correct answer gets no bonus.
export function scoreAnswer({ correct, elapsedMs, timeLimitMs, pointsMode = 'standard', streakBefore = 0 }) {
  if (!correct || pointsMode === 'none') return 0;

  const base = pointsMode === 'double' ? 2000 : 1000;
  const elapsed = Math.min(Math.max(elapsedMs, 0), timeLimitMs);
  const speedPoints = Math.round(base * (1 - elapsed / timeLimitMs / 2));
  const streakBonus = Math.min(streakBefore * 100, 500);
  return speedPoints + streakBonus;
}

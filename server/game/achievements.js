// each rule takes a player summary:
// { rank, correct, totalQuestions, longestStreak, fastestCorrectMs, rankHistory }

export const speedDemon = (s) => s.fastestCorrectMs != null && s.fastestCorrectMs <= 2000;

export const streakMaster = (s) => s.longestStreak >= 3;

// needs a few questions, otherwise a 1 question quiz makes everyone perfect
export const perfectScore = (s) => s.totalQuestions >= 3 && s.correct === s.totalQuestions;

// climbed at least 3 places from their worst position
export const comebackKid = (s) => s.rankHistory.length >= 2 && Math.max(...s.rankHistory) - s.rank >= 3;

const rules = [
  ['Speed Demon', speedDemon],
  ['Streak Master', streakMaster],
  ['Comeback Kid', comebackKid],
  ['Perfect Score', perfectScore],
];

export function computeAchievements(summary) {
  if (summary.totalQuestions === 0) return [];
  return rules.filter(([, check]) => check(summary)).map(([name]) => name);
}

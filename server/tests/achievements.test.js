import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speedDemon, streakMaster, perfectScore, comebackKid, computeAchievements } from '../game/achievements.js';

const player = (over = {}) => ({ rank: 2, correct: 1, totalQuestions: 5, longestStreak: 1, fastestCorrectMs: 6000, rankHistory: [2, 2, 2], ...over });

test('speed demon needs a correct answer within 2 seconds', () => {
  assert.equal(speedDemon(player({ fastestCorrectMs: 1500 })), true);
  assert.equal(speedDemon(player({ fastestCorrectMs: 2000 })), true);
  assert.equal(speedDemon(player({ fastestCorrectMs: 2001 })), false);
  assert.equal(speedDemon(player({ fastestCorrectMs: null })), false);
});

test('streak master needs 3 in a row', () => {
  assert.equal(streakMaster(player({ longestStreak: 3 })), true);
  assert.equal(streakMaster(player({ longestStreak: 2 })), false);
});

test('perfect score needs all correct and at least 3 questions', () => {
  assert.equal(perfectScore(player({ correct: 5, totalQuestions: 5 })), true);
  assert.equal(perfectScore(player({ correct: 4, totalQuestions: 5 })), false);
  assert.equal(perfectScore(player({ correct: 2, totalQuestions: 2 })), false);
});

test('comeback kid climbs 3 places from their worst rank', () => {
  assert.equal(comebackKid(player({ rank: 2, rankHistory: [6, 4, 2] })), true);
  assert.equal(comebackKid(player({ rank: 2, rankHistory: [4, 3, 2] })), false);
  assert.equal(comebackKid(player({ rank: 1, rankHistory: [1] })), false);
});

test('computeAchievements lists earned names, none for an empty game', () => {
  const all = player({ rank: 1, correct: 5, longestStreak: 5, fastestCorrectMs: 900, rankHistory: [5, 3, 1] });
  assert.deepEqual(computeAchievements(all), ['Speed Demon', 'Streak Master', 'Comeback Kid', 'Perfect Score']);
  assert.deepEqual(computeAchievements(player({ totalQuestions: 0 })), []);
  assert.deepEqual(computeAchievements(player()), []);
});

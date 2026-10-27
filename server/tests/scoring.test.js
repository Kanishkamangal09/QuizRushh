import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnswer } from '../game/scoring.js';

const base = { correct: true, timeLimitMs: 10000, pointsMode: 'standard', streakBefore: 0 };

test('instant correct answer gets full points', () => {
  assert.equal(scoreAnswer({ ...base, elapsedMs: 0 }), 1000);
});

test('last second correct answer gets half', () => {
  assert.equal(scoreAnswer({ ...base, elapsedMs: 10000 }), 500);
});

test('halfway gets 750', () => {
  assert.equal(scoreAnswer({ ...base, elapsedMs: 5000 }), 750);
});

test('elapsed over the limit is clamped', () => {
  assert.equal(scoreAnswer({ ...base, elapsedMs: 15000 }), 500);
});

test('negative elapsed is clamped to zero', () => {
  assert.equal(scoreAnswer({ ...base, elapsedMs: -50 }), 1000);
});

test('wrong answer gets nothing, even with a streak', () => {
  assert.equal(scoreAnswer({ ...base, correct: false, elapsedMs: 0, streakBefore: 4 }), 0);
});

test('double points doubles the base', () => {
  assert.equal(scoreAnswer({ ...base, pointsMode: 'double', elapsedMs: 0 }), 2000);
  assert.equal(scoreAnswer({ ...base, pointsMode: 'double', elapsedMs: 10000 }), 1000);
});

test('no points mode always scores 0', () => {
  assert.equal(scoreAnswer({ ...base, pointsMode: 'none', elapsedMs: 0, streakBefore: 3 }), 0);
});

test('streak adds 100 per previous correct answer', () => {
  assert.equal(scoreAnswer({ ...base, elapsedMs: 0, streakBefore: 1 }), 1100);
  assert.equal(scoreAnswer({ ...base, elapsedMs: 0, streakBefore: 3 }), 1300);
});

test('streak bonus is capped at 500', () => {
  assert.equal(scoreAnswer({ ...base, elapsedMs: 0, streakBefore: 5 }), 1500);
  assert.equal(scoreAnswer({ ...base, elapsedMs: 0, streakBefore: 12 }), 1500);
});

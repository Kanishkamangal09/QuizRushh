import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGO_URI ??= 'mongodb://unused';
process.env.JWT_SECRET ??= 'test';
const { quizSchema } = await import('../models/Quiz.js');

const mcq = (over = {}) => ({
  type: 'mcq',
  text: 'Capital of France?',
  options: ['Paris', 'Rome', 'Madrid'],
  correctIndex: 0,
  ...over,
});
const quiz = (over = {}) => ({ title: 'Geo', questions: [mcq()], ...over });

test('valid quiz passes and gets defaults', () => {
  const r = quizSchema.parse(quiz());
  assert.equal(r.questions[0].timeLimitSec, 20);
  assert.equal(r.questions[0].pointsMode, 'standard');
  assert.deepEqual(r.tags, []);
  assert.equal(r.settings.shuffleOptions, false);
});

test('true/false needs exactly 2 options', () => {
  const ok = { type: 'tf', text: 'Sky is blue', options: ['True', 'False'], correctIndex: 1 };
  assert.ok(quizSchema.safeParse(quiz({ questions: [ok] })).success);
  const bad = { ...ok, options: ['True', 'False', 'Maybe'] };
  assert.ok(!quizSchema.safeParse(quiz({ questions: [bad] })).success);
});

test('option count limits', () => {
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ options: ['Only'] })] })).success);
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ options: ['a', 'b', 'c', 'd', 'e'] })] })).success);
  assert.ok(quizSchema.safeParse(quiz({ questions: [mcq({ options: ['a', 'b', 'c', 'd'] })] })).success);
});

test('correctIndex must point at an option', () => {
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ correctIndex: 3 })] })).success);
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ correctIndex: -1 })] })).success);
});

test('time limit must be 5 to 60', () => {
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ timeLimitSec: 4 })] })).success);
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ timeLimitSec: 61 })] })).success);
  assert.ok(quizSchema.safeParse(quiz({ questions: [mcq({ timeLimitSec: 5 })] })).success);
  assert.ok(quizSchema.safeParse(quiz({ questions: [mcq({ timeLimitSec: 60 })] })).success);
});

test('rejects bad points mode, duplicate options, blank text, empty quiz', () => {
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ pointsMode: 'triple' })] })).success);
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ options: ['A', 'a'] })] })).success);
  assert.ok(!quizSchema.safeParse(quiz({ questions: [mcq({ text: '   ' })] })).success);
  assert.ok(!quizSchema.safeParse(quiz({ questions: [] })).success);
  assert.ok(!quizSchema.safeParse(quiz({ title: '' })).success);
});

test('tags are trimmed, lowercased and capped', () => {
  assert.deepEqual(quizSchema.parse(quiz({ tags: [' Math ', 'SCI'] })).tags, ['math', 'sci']);
  assert.ok(!quizSchema.safeParse(quiz({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).success);
});

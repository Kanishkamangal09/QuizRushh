import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGO_URI ??= 'mongodb://unused';
process.env.JWT_SECRET ??= 'test';
const hw = await import('../game/homework.js');
const { weakStats, buildRevisionQuiz } = await import('../services/revision.js');

const T0 = 5_000_000;
const questions = [
  { type: 'mcq', text: 'Q1', options: ['a', 'b', 'c'], correctIndex: 0, timeLimitSec: 10, pointsMode: 'standard' },
  { type: 'mcq', text: 'Q2', options: ['a', 'b', 'c'], correctIndex: 2, timeLimitSec: 10, pointsMode: 'double' },
  { type: 'tf', text: 'Q3', options: ['True', 'False'], correctIndex: 1, timeLimitSec: 10, pointsMode: 'none' },
];
const assignment = { questions };

// a fresh attempt with the question at `position` started at T0
function attempt(over = {}) {
  return {
    plan: hw.buildPlan(questions),
    answers: [],
    current: { startedAt: new Date(T0) },
    score: 0,
    streak: 0,
    longestStreak: 0,
    correct: 0,
    fastestCorrectMs: null,
    finishedAt: null,
    ...over,
  };
}

test('codes use the readable alphabet and match the pattern', () => {
  for (let i = 0; i < 200; i++) assert.match(hw.makeCode(), hw.CODE_RE);
  assert.equal(hw.CODE_RE.test('ABCDEFO'), false); // no O
  assert.equal(hw.CODE_RE.test('ABC'), false);
});

test('homework is open until closed or past its deadline', () => {
  assert.equal(hw.isOpen({ closed: false, deadline: null }), true);
  assert.equal(hw.isOpen({ closed: true, deadline: null }), false);
  assert.equal(hw.isOpen({ closed: false, deadline: new Date(T0) }, T0 - 1), true);
  assert.equal(hw.isOpen({ closed: false, deadline: new Date(T0) }, T0 + 1), false);
});

test('plan without shuffling keeps the original order', () => {
  const plan = hw.buildPlan(questions, {});
  assert.deepEqual(plan.map((s) => s.q), [0, 1, 2]);
  assert.deepEqual(plan[0].opts, [0, 1, 2]);
});

test('plan with shuffling is still a permutation, and true/false options stay put', () => {
  for (let i = 0; i < 30; i++) {
    const plan = hw.buildPlan(questions, { shuffleQuestions: true, shuffleOptions: true });
    assert.deepEqual(plan.map((s) => s.q).sort(), [0, 1, 2]);
    for (const step of plan) {
      assert.deepEqual([...step.opts].sort(), questions[step.q].options.map((_, k) => k));
      if (questions[step.q].type === 'tf') assert.deepEqual(step.opts, [0, 1]);
    }
  }
});

test('question view hides the correct answer and shows options in the shuffled order', () => {
  const a = attempt({ plan: [{ q: 0, opts: [2, 0, 1] }, { q: 1, opts: [0, 1, 2] }, { q: 2, opts: [0, 1] }] });
  const view = hw.questionView(assignment, a, T0 + 100);
  assert.deepEqual(view.options, ['c', 'a', 'b']);
  assert.equal('correctIndex' in view, false);
  assert.equal(view.endsAt, T0 + 10000);
  assert.equal(view.serverNow, T0 + 100);
});

test('correct answer: points by speed, mapped back through the shuffled options', () => {
  const a = attempt({ plan: [{ q: 0, opts: [2, 0, 1] }, { q: 1, opts: [0, 1, 2] }, { q: 2, opts: [0, 1] }] });
  // correct option is original index 0, which is shown at position 1
  const r = hw.resolveCurrent(assignment, a, 1, T0 + 5000);
  assert.equal(r.answer.correct, true);
  assert.equal(r.answer.optionIndex, 0);
  assert.equal(r.answer.points, 750);
  assert.equal(r.score, 750);
  assert.equal(r.streak, 1);
  assert.equal(r.fastestCorrectMs, 5000);
  assert.equal(r.finished, false);

  const wrong = hw.resolveCurrent(assignment, a, 0, T0 + 1000); // position 0 is original option 2
  assert.equal(wrong.answer.correct, false);
  assert.equal(wrong.score, 0);
});

test('timeout counts as unanswered and breaks the streak', () => {
  const a = attempt({ streak: 3, longestStreak: 3, score: 900 });
  const r = hw.resolveCurrent(assignment, a, -1, T0 + 20000);
  assert.equal(r.answer.choice, -1);
  assert.equal(r.answer.points, 0);
  assert.equal(r.answer.timeMs, null);
  assert.equal(r.streak, 0);
  assert.equal(r.longestStreak, 3);
  assert.equal(r.score, 900);
});

test('streak bonus, double points and no points questions behave like live games', () => {
  const second = attempt({ answers: [{}], streak: 1, longestStreak: 1, score: 1000, current: { startedAt: new Date(T0) } });
  const r = hw.resolveCurrent(assignment, second, 2, T0); // Q2 double, correct is option 2
  assert.equal(r.answer.points, 2000 + 100);
  assert.equal(r.streak, 2);

  const third = attempt({ answers: [{}, {}], streak: 2, longestStreak: 2, score: 3000 });
  const none = hw.resolveCurrent(assignment, third, 1, T0); // Q3 no points, correct
  assert.equal(none.answer.points, 0);
  assert.equal(none.streak, 2); // untouched
  assert.equal(none.finished, true);
});

test('expiry has a 300ms grace and only applies to a started question', () => {
  const a = attempt();
  assert.equal(hw.isExpired(assignment, a, T0 + 10000 + 300), false);
  assert.equal(hw.isExpired(assignment, a, T0 + 10000 + 301), true);
  assert.equal(hw.isExpired(assignment, attempt({ current: null }), T0 + 999999), false);
});

test('ranking orders by score and ties share a rank', () => {
  const ranked = hw.rankAttempts([
    { nickname: 'Cat', score: 500 },
    { nickname: 'Ann', score: 500 },
    { nickname: 'Ben', score: 900 },
    { nickname: 'Dan', score: 100 },
  ]);
  assert.deepEqual(ranked.map((r) => [r.nickname, r.rank]), [['Ben', 1], ['Ann', 2], ['Cat', 2], ['Dan', 4]]);
});

test('results use the same shape as a live game and count by original option', () => {
  const done = (nickname, answers) => ({ nickname, avatar: 'x', score: answers.reduce((s, a) => s + a.points, 0), longestStreak: 1, fastestCorrectMs: 2500, correct: answers.filter((a) => a.correct).length, plan: hw.buildPlan(questions), answers, finishedAt: new Date() });
  const attempts = [
    done('Ann', [
      { questionIndex: 0, choice: 1, optionIndex: 0, correct: true, points: 900, timeMs: 1000 },
      { questionIndex: 1, choice: 0, optionIndex: 0, correct: false, points: 0, timeMs: 3000 },
      { questionIndex: 2, choice: -1, optionIndex: -1, correct: false, points: 0, timeMs: null },
    ]),
    done('Ben', [
      { questionIndex: 0, choice: 0, optionIndex: 1, correct: false, points: 0, timeMs: 2000 },
      { questionIndex: 1, choice: 2, optionIndex: 2, correct: true, points: 1800, timeMs: 1000 },
      { questionIndex: 2, choice: 1, optionIndex: 1, correct: true, points: 0, timeMs: 1000 },
    ]),
  ];
  const { players, questionStats } = hw.buildResults(assignment, attempts);
  assert.deepEqual(players.map((p) => [p.nickname, p.rank]), [['Ben', 1], ['Ann', 2]]);
  assert.equal(players[0].answers[1].choice, 2); // original option index, so it lines up with the stats
  assert.deepEqual(questionStats[0].distribution, [1, 1, 0]);
  assert.equal(questionStats[0].correctCount, 1);
  assert.equal(questionStats[2].totalAnswers, 1); // the timeout isn't an answer
  assert.equal(questionStats[1].avgTimeMs, 2000);
});

test('weak questions are those under 50% correct with at least one answer', () => {
  const stats = [
    { text: 'half', correctCount: 1, totalAnswers: 2 },
    { text: 'bad', correctCount: 1, totalAnswers: 3 },
    { text: 'good', correctCount: 3, totalAnswers: 4 },
    { text: 'nobody', correctCount: 0, totalAnswers: 0 },
  ];
  assert.deepEqual(weakStats(stats).map((q) => q.text), ['bad']);
});

test('revision quiz keeps the weak questions and is a valid quiz', () => {
  const stats = [
    { questionIndex: 0, text: 'Hard one', options: ['x', 'y', 'z'], correctIndex: 2, correctCount: 0, totalAnswers: 4, timeLimitSec: 30, pointsMode: 'double', type: 'mcq' },
    { questionIndex: 1, text: 'Easy one', options: ['x', 'y'], correctIndex: 0, correctCount: 4, totalAnswers: 4 },
    { questionIndex: 2, text: 'Old session tf', options: ['True', 'False'], correctIndex: 1, correctCount: 0, totalAnswers: 2 },
  ];
  const { quiz, error } = buildRevisionQuiz('Space', stats);
  assert.equal(error, undefined);
  assert.equal(quiz.title, 'Revision: Space');
  assert.deepEqual(quiz.tags, ['revision']);
  assert.deepEqual(quiz.questions.map((q) => q.text), ['Hard one', 'Old session tf']);
  assert.equal(quiz.questions[0].timeLimitSec, 30);
  assert.equal(quiz.questions[0].pointsMode, 'double');
  assert.equal(quiz.questions[1].type, 'tf'); // worked out from the options
  assert.equal(quiz.questions[1].timeLimitSec, 20); // default for old data
});

test('revision quiz title is capped and an easy game has nothing to revise', () => {
  const weak = [{ text: 'Q', options: ['a', 'b'], correctIndex: 0, correctCount: 0, totalAnswers: 1 }];
  assert.equal(buildRevisionQuiz('x'.repeat(200), weak).quiz.title.length, 100);
  assert.match(buildRevisionQuiz('Easy', [{ text: 'Q', options: ['a', 'b'], correctIndex: 0, correctCount: 5, totalAnswers: 5 }]).error, /No weak/);
});

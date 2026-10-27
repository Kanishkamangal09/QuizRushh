import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../game/engine.js';
import { saveGame, getGame, sweep } from '../game/store.js';

const quiz = (over = {}) => ({
  title: 'Test quiz',
  settings: {},
  questions: [
    { type: 'mcq', text: 'Q1', options: ['a', 'b', 'c'], correctIndex: 0, timeLimitSec: 10, pointsMode: 'standard' },
    { type: 'mcq', text: 'Q2', options: ['a', 'b', 'c'], correctIndex: 1, timeLimitSec: 10, pointsMode: 'standard' },
    { type: 'tf', text: 'Q3', options: ['True', 'False'], correctIndex: 1, timeLimitSec: 10, pointsMode: 'double' },
  ],
  ...over,
});

// a game with 3 players, already started. returns times relative to T0 so tests control the clock
const T0 = 1_000_000;
function setup(over) {
  const game = engine.createGame({ quiz: quiz(over), hostUserId: 'host1', code: '123456' }, T0);
  const ids = ['Ann', 'Ben', 'Cat'].map((nickname) => engine.addPlayer(game, { nickname, avatar: 'x' }).player.id);
  engine.startGame(game, T0);
  return { game, ids };
}
const done = (game) => engine.finishGame(game, 'ended'); // clears timers

test('add player rejects duplicates, bad words, full, locked and started games', () => {
  const game = engine.createGame({ quiz: quiz(), hostUserId: 'h', code: '111111', maxPlayers: 2 });
  assert.ok(engine.addPlayer(game, { nickname: 'Ann', avatar: 'x' }).player);
  assert.match(engine.addPlayer(game, { nickname: ' ann ', avatar: 'x' }).error, /taken/);
  assert.match(engine.addPlayer(game, { nickname: 'sh1t', avatar: 'x' }).error, /different/);
  assert.ok(engine.addPlayer(game, { nickname: 'Ben', avatar: 'x' }).player);
  assert.match(engine.addPlayer(game, { nickname: 'Cat', avatar: 'x' }).error, /full/);

  const g2 = engine.createGame({ quiz: quiz(), hostUserId: 'h', code: '222222' });
  engine.setLocked(g2, true);
  assert.match(engine.addPlayer(g2, { nickname: 'Dan', avatar: 'x' }).error, /locked/);
  engine.setLocked(g2, false);
  engine.addPlayer(g2, { nickname: 'Dan', avatar: 'x' });
  engine.startGame(g2);
  assert.match(engine.addPlayer(g2, { nickname: 'Eve', avatar: 'x' }).error, /started/);
  done(g2);
});

test('cannot start without players', () => {
  const game = engine.createGame({ quiz: quiz(), hostUserId: 'h', code: '333333' });
  assert.match(engine.startGame(game).error, /player/);
});

test('question payload never includes the correct answer', () => {
  const { game } = setup();
  const payload = engine.questionPayload(game, T0);
  assert.equal('correctIndex' in payload, false);
  assert.equal(payload.endsAt, T0 + 10000);
  assert.equal(payload.serverNow, T0);
  done(game);
});

test('duplicate answers are rejected', () => {
  const { game, ids } = setup();
  assert.equal(engine.submitAnswer(game, ids[0], 0, T0 + 1000).ok, true);
  const second = engine.submitAnswer(game, ids[0], 1, T0 + 2000);
  assert.equal(second.ok, false);
  assert.match(second.reason, /Already/);
  done(game);
});

test('late answers are rejected, but the grace window is allowed', () => {
  const { game, ids } = setup();
  assert.equal(engine.submitAnswer(game, ids[0], 0, T0 + 10000 + engine.GRACE_MS).ok, true);
  const late = engine.submitAnswer(game, ids[1], 0, T0 + 10000 + engine.GRACE_MS + 1);
  assert.equal(late.ok, false);
  assert.match(late.reason, /late/i);
  done(game);
});

test('answers outside the QUESTION state are rejected', () => {
  const lobby = engine.createGame({ quiz: quiz(), hostUserId: 'h', code: '444444' });
  const p = engine.addPlayer(lobby, { nickname: 'Ann', avatar: 'x' }).player;
  assert.equal(engine.submitAnswer(lobby, p.id, 0).ok, false);

  const { game, ids } = setup();
  engine.endQuestion(game, T0 + 1000);
  assert.equal(game.state, 'REVEAL');
  assert.equal(engine.submitAnswer(game, ids[0], 0, T0 + 1100).ok, false);
  done(game);
});

test('invalid choices and unknown players are rejected', () => {
  const { game, ids } = setup();
  assert.equal(engine.submitAnswer(game, ids[0], 7, T0 + 100).ok, false);
  assert.equal(engine.submitAnswer(game, ids[0], -1, T0 + 100).ok, false);
  assert.equal(engine.submitAnswer(game, 'nobody', 0, T0 + 100).ok, false);
  done(game);
});

test('allAnswered turns true only when every connected player answered', () => {
  const { game, ids } = setup();
  assert.equal(engine.submitAnswer(game, ids[0], 0, T0 + 100).allAnswered, false);
  assert.equal(engine.submitAnswer(game, ids[1], 0, T0 + 100).allAnswered, false);
  assert.equal(engine.submitAnswer(game, ids[2], 0, T0 + 100).allAnswered, true);
  done(game);
});

test('disconnected players do not block everyone-answered', () => {
  const { game, ids } = setup();
  game.players.get(ids[2]).connected = false;
  engine.submitAnswer(game, ids[0], 0, T0 + 100);
  assert.equal(engine.submitAnswer(game, ids[1], 0, T0 + 100).allAnswered, true);
  done(game);
});

test('reveal scores answers, builds stats and ranks players', () => {
  const { game, ids } = setup();
  engine.submitAnswer(game, ids[0], 0, T0); // correct, instant -> 1000
  engine.submitAnswer(game, ids[1], 0, T0 + 10000); // correct, last moment -> 500
  engine.submitAnswer(game, ids[2], 2, T0 + 1000); // wrong
  const out = engine.endQuestion(game, T0 + 10000);

  assert.equal(out.results.get(ids[0]).points, 1000);
  assert.equal(out.results.get(ids[1]).points, 500);
  assert.equal(out.results.get(ids[2]).points, 0);
  assert.equal(out.results.get(ids[0]).rank, 1);
  assert.equal(out.results.get(ids[2]).rank, 3);

  assert.deepEqual(game.stats[0].distribution, [2, 0, 1]);
  assert.equal(game.stats[0].correctCount, 2);
  assert.equal(game.stats[0].totalAnswers, 3);
  assert.equal(game.stats[0].avgTimeMs, Math.round((0 + 10000 + 1000) / 3));
  assert.equal(out.reveal.correctIndex, 0);
  assert.equal(out.reveal.isLast, false);
  done(game);
});

test('leaderboard is ordered by score and ties share a rank', () => {
  const { game, ids } = setup();
  game.players.get(ids[0]).score = 500;
  game.players.get(ids[1]).score = 900;
  game.players.get(ids[2]).score = 500;
  const board = engine.leaderboard(game);
  assert.deepEqual(board.map((e) => [e.nickname, e.rank]), [['Ben', 1], ['Ann', 2], ['Cat', 2]]);

  game.players.get(ids[1]).score = 100;
  assert.deepEqual(engine.leaderboard(game).map((e) => e.rank), [1, 1, 3]);
  done(game);
});

test('rank change compares against the previous reveal', () => {
  const { game, ids } = setup();
  engine.submitAnswer(game, ids[0], 0, T0 + 5000); // correct but slow, 750 points
  engine.submitAnswer(game, ids[1], 1, T0);
  engine.submitAnswer(game, ids[2], 1, T0);
  const first = engine.endQuestion(game, T0 + 6000);
  assert.ok(first.reveal.leaderboard.every((e) => e.change === 0));

  engine.nextQuestion(game, T0 + 7000);
  engine.submitAnswer(game, ids[0], 0, T0 + 7000); // wrong now
  engine.submitAnswer(game, ids[1], 1, T0 + 7000); // instant, 1000 points
  engine.submitAnswer(game, ids[2], 1, T0 + 7000);
  const second = engine.endQuestion(game, T0 + 8000);
  const ann = second.reveal.leaderboard.find((e) => e.nickname === 'Ann');
  const ben = second.reveal.leaderboard.find((e) => e.nickname === 'Ben');
  assert.equal(ann.change, -2); // 1st -> 3rd
  assert.equal(ben.change, 1); // 2nd -> 1st (tied)
  done(game);
});

test('streak builds, resets on a miss, and no points questions leave it alone', () => {
  const { game, ids } = setup();
  const id = ids[0];
  const p = game.players.get(id);

  engine.submitAnswer(game, id, 0, T0);
  engine.endQuestion(game, T0 + 1);
  assert.equal(p.streak, 1);

  engine.nextQuestion(game, T0 + 2);
  engine.submitAnswer(game, id, 1, T0 + 2);
  engine.endQuestion(game, T0 + 3);
  assert.equal(p.streak, 2);
  assert.equal(p.score, 1000 + 1100);

  game.questions[2].pointsMode = 'none';
  engine.nextQuestion(game, T0 + 4);
  engine.endQuestion(game, T0 + 5); // player did not answer
  assert.equal(p.streak, 2);
  assert.equal(p.longestStreak, 2);
  done(game);
});

test('pause freezes the timer and resume extends endsAt by the paused time', () => {
  const { game, ids } = setup();
  const paused = engine.pauseGame(game, T0 + 3000);
  assert.equal(paused.remainingMs, 7000);
  assert.equal(engine.submitAnswer(game, ids[0], 0, T0 + 4000).ok, false); // frozen
  assert.equal(engine.pauseGame(game, T0 + 4000).error, 'Nothing to pause');

  const resumed = engine.resumeGame(game, T0 + 8000); // paused for 5s
  assert.equal(resumed.endsAt, T0 + 8000 + 7000);
  assert.equal(game.q.endsAt, T0 + 10000 + 5000);

  // elapsed ignores the pause: answering 1s after resume counts as 4s in
  engine.submitAnswer(game, ids[0], 0, T0 + 9000);
  assert.equal(game.q.answers.get(ids[0]).timeMs, 4000);
  assert.equal(engine.resumeGame(game, T0 + 9000).error, 'The game is not paused');
  done(game);
});

test('the question timer fires once and not while paused', async () => {
  const game = engine.createGame({
    quiz: quiz({ questions: [{ type: 'mcq', text: 'Fast', options: ['a', 'b'], correctIndex: 0, timeLimitSec: 0.05, pointsMode: 'standard' }] }),
    hostUserId: 'h',
    code: '555555',
    onTimeUp: () => fired++,
  });
  let fired = 0;
  engine.addPlayer(game, { nickname: 'Ann', avatar: 'x' });
  engine.startGame(game);
  engine.pauseGame(game);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(fired, 0);

  engine.resumeGame(game);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(fired, 1);
  done(game);
});

test('skip (endQuestion) moves to reveal and a second call does nothing', () => {
  const { game } = setup();
  assert.ok(engine.endQuestion(game, T0 + 500));
  assert.equal(engine.endQuestion(game, T0 + 600), null);
  assert.equal(game.state, 'REVEAL');
  done(game);
});

test('illegal transitions are blocked', () => {
  const { game } = setup();
  assert.match(engine.nextQuestion(game).error, /not finished/);
  assert.match(engine.startGame(game).error, /already/);
  done(game);
  assert.equal(engine.finishGame(game, 'ended'), false);
  assert.equal(engine.endQuestion(game), null);
});

test('a full game completes with final summaries', () => {
  const { game, ids } = setup();
  const picks = [0, 1, 1]; // correct answers for Q1..Q3
  for (let q = 0; q < 3; q++) {
    const t = T0 + q * 20000; // each question starts at t
    engine.submitAnswer(game, ids[0], picks[q], t + 1000);
    engine.submitAnswer(game, ids[1], q === 0 ? 0 : 2, t + 1000);
    engine.endQuestion(game, t + 5000);
    if (engine.hasNext(game)) engine.nextQuestion(game, t + 20000);
  }
  assert.equal(engine.hasNext(game), false);
  assert.equal(engine.finishGame(game, 'complete', T0 + 90000), true);

  const ann = engine.summaryFor(game, ids[0]);
  assert.equal(ann.rank, 1);
  assert.equal(ann.accuracy, 100);
  assert.equal(ann.longestStreak, 3);
  assert.ok(ann.achievements.includes('Perfect Score'));
  assert.ok(ann.achievements.includes('Streak Master'));

  const data = engine.sessionData(game);
  assert.equal(data.players.length, 3);
  assert.equal(data.questionStats.length, 3);
  assert.equal(data.players[0].nickname, 'Ann');
});

test('kick removes a player and stops them blocking the question', () => {
  const { game, ids } = setup();
  engine.submitAnswer(game, ids[0], 0, T0 + 100);
  engine.submitAnswer(game, ids[1], 0, T0 + 100);
  assert.equal(engine.everyoneAnswered(game), false);
  engine.removePlayer(game, ids[2]);
  assert.equal(game.players.has(ids[2]), false);
  assert.equal(engine.everyoneAnswered(game), true);
  done(game);
});

test('shuffle keeps the correct answer pointing at the same text', () => {
  for (let i = 0; i < 30; i++) {
    const game = engine.createGame({
      quiz: quiz({ settings: { shuffleOptions: true, shuffleQuestions: true } }),
      hostUserId: 'h',
      code: '666666',
    });
    const q1 = game.questions.find((q) => q.text === 'Q1');
    assert.equal(q1.options[q1.correctIndex], 'a');
    const tf = game.questions.find((q) => q.type === 'tf');
    assert.deepEqual(tf.options, ['True', 'False']);
  }
});

test('rejoin finds a player by their secret token', () => {
  const { game, ids } = setup();
  const p = game.players.get(ids[0]);
  assert.equal(engine.findByToken(game, p.token).id, ids[0]);
  assert.equal(engine.findByToken(game, 'nope'), null);
  done(game);
});

test('sweep removes games that were idle for over 30 minutes', () => {
  const old = engine.createGame({ quiz: quiz(), hostUserId: 'h', code: '777777' }, T0);
  const fresh = engine.createGame({ quiz: quiz(), hostUserId: 'h', code: '888888' }, T0 + 25 * 60 * 1000);
  saveGame(old);
  saveGame(fresh);
  sweep(T0 + 31 * 60 * 1000);
  assert.equal(getGame('777777'), undefined);
  assert.ok(getGame('888888'));
  sweep(T0 + 60 * 60 * 1000);
  assert.equal(getGame('888888'), undefined);
});

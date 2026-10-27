import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod;
let app;
let base;
let Attempt;
let Session;

before(async () => {
  mongod = await MongoMemoryServer.create();
  Object.assign(process.env, { MONGO_URI: mongod.getUri(), JWT_SECRET: 'test-secret', PORT: '0', NODE_ENV: 'test' });
  const { startServer } = await import('../index.js');
  app = await startServer();
  base = `http://localhost:${app.server.address().port}`;
  Attempt = (await import('../models/Attempt.js')).default;
  Session = (await import('../models/Session.js')).default;
  await Attempt.init(); // wait for the unique index
});

after(async () => {
  await app.stop();
  await mongod.stop();
});

async function call(path, { method = 'GET', body, cookie, token } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(token ? { 'x-attempt-token': token } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})), text: null, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

const register = async (email) => (await call('/auth/register', { method: 'POST', body: { name: 'T', email, password: 'secret123' } })).cookie;
const q = (text, options, correctIndex, extra = {}) => ({ type: 'mcq', text, options, correctIndex, timeLimitSec: 20, ...extra });

async function setupHomework(cookie, opts = {}) {
  const quiz = await call('/quizzes', {
    method: 'POST',
    cookie,
    body: {
      title: 'Homework quiz',
      questions: [q('Q1', ['right', 'wrong', 'nope'], 0), q('Q2', ['no', 'yes'], 1), q('Q3', ['left', 'right'], 0, { pointsMode: 'double' })],
    },
  });
  const made = await call('/homework', { method: 'POST', cookie, body: { quizId: quiz.data.quiz._id, ...opts } });
  return { quizId: quiz.data.quiz._id, id: made.data.assignment?.id, code: made.data.assignment?.code, status: made.status, error: made.data.error };
}

const join = (code, nickname) => call(`/hw/${code}/join`, { method: 'POST', body: { nickname, avatar: '🐼' } });
const next = (code, token) => call(`/hw/${code}/next`, { method: 'POST', token });
const answer = (code, token, choice) => call(`/hw/${code}/answer`, { method: 'POST', token, body: { choice } });

test('teacher creates homework, students play through it, and results come back', async () => {
  const cookie = await register('hw-teacher@example.com');
  const hwk = await setupHomework(cookie);
  assert.equal(hwk.status, 201);
  assert.match(hwk.code, /^[A-HJ-NP-Z2-9]{7}$/);

  // public info needs no login and shows no answers
  const info = await call(`/hw/${hwk.code.toLowerCase()}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.questionCount, 3);
  assert.equal(info.data.open, true);
  assert.equal((await call('/hw/ZZZZZZZ')).status, 404);
  assert.equal((await call('/hw/nope')).status, 404);

  // joining
  const asha = await join(hwk.code, 'Asha');
  assert.equal(asha.status, 201);
  const ashaToken = asha.data.token;
  assert.equal(asha.data.state.phase, 'ready');
  assert.equal(JSON.stringify(asha.data.state).includes('correctIndex'), false);
  assert.equal((await join(hwk.code, 'asha')).status, 409);
  assert.equal((await join(hwk.code, 'sh1t')).status, 400);
  assert.equal((await call(`/hw/${hwk.code}/join`, { method: 'POST', body: { nickname: 'x', avatar: '🐼' } })).status, 400);

  // you need your own token
  assert.equal((await call(`/hw/${hwk.code}/state`)).status, 401);
  assert.equal((await call(`/hw/${hwk.code}/state`, { token: 'made-up' })).status, 401);
  assert.equal((await answer(hwk.code, ashaToken, 0)).status, 409); // nothing started yet

  // question 1: the question only appears after next, and a refresh keeps the same timer
  const started = await next(hwk.code, ashaToken);
  const question = started.data.state.question;
  assert.equal(question.index, 0);
  assert.equal(question.text, 'Q1');
  assert.equal('correctIndex' in question, false);
  const again = await next(hwk.code, ashaToken); // double click does not restart the clock
  assert.equal(again.data.state.question.endsAt, question.endsAt);
  const refreshed = await call(`/hw/${hwk.code}/state`, { token: ashaToken });
  assert.equal(refreshed.data.state.question.endsAt, question.endsAt);

  assert.equal((await answer(hwk.code, ashaToken, 9)).status, 400);
  const first = await answer(hwk.code, ashaToken, 0); // correct
  assert.equal(first.status, 200);
  assert.equal(first.data.state.phase, 'ready');
  assert.equal(first.data.state.last.correct, true);
  assert.equal(first.data.state.last.correctText, 'right');
  assert.ok(first.data.state.score > 900);
  assert.equal((await answer(hwk.code, ashaToken, 0)).status, 409); // already answered

  // question 2: Asha lets the clock run out. fake it by moving the start time back
  await next(hwk.code, ashaToken);
  const row = await Attempt.findOne({ nicknameKey: 'asha' });
  await Attempt.updateOne({ _id: row._id }, { $set: { 'current.startedAt': new Date(Date.now() - 60_000) } });
  const late = await answer(hwk.code, ashaToken, 1);
  assert.equal(late.status, 409);
  const afterTimeout = await call(`/hw/${hwk.code}/state`, { token: ashaToken });
  assert.equal(afterTimeout.data.state.phase, 'ready');
  assert.equal(afterTimeout.data.state.last.answered, false);
  assert.equal(afterTimeout.data.state.streak, 0);

  // question 3 and finish
  await next(hwk.code, ashaToken);
  const done = await answer(hwk.code, ashaToken, 0);
  const final = done.data.state.final;
  assert.equal(done.data.state.phase, 'done');
  assert.equal(final.totalQuestions, 3);
  assert.equal(final.correct, 2);
  assert.equal(final.accuracy, 67);
  assert.equal(final.review.length, 3);
  assert.equal(final.rank, 1);

  // a second student answers everything wrong
  const ben = (await join(hwk.code, 'Ben')).data;
  for (const choice of [1, 0, 1]) {
    await next(hwk.code, ben.token);
    await answer(hwk.code, ben.token, choice);
  }
  const benDone = (await call(`/hw/${hwk.code}/state`, { token: ben.token })).data.state;
  assert.equal(benDone.phase, 'done');
  assert.equal(benDone.final.rank, 2);
  assert.deepEqual(benDone.final.leaderboard.map((e) => e.nickname), ['Asha', 'Ben']);

  // a third student stops half way, so the teacher sees them as in progress
  const cleo = (await join(hwk.code, 'Cleo')).data;
  await next(hwk.code, cleo.token);
  await answer(hwk.code, cleo.token, 0);

  // teacher results
  const results = await call(`/homework/${hwk.id}`, { cookie });
  assert.equal(results.status, 200);
  const s = results.data.session;
  assert.equal(s.kind, 'homework');
  assert.deepEqual(s.players.map((p) => [p.nickname, p.finished]).sort(), [['Asha', true], ['Ben', true], ['Cleo', false]]);
  assert.equal(s.players.find((p) => p.nickname === 'Asha').rank, 1);
  assert.equal(s.questionStats.length, 3);
  assert.deepEqual(s.questionStats[0].distribution, [2, 1, 0]); // Asha and Cleo right, Ben wrong
  assert.equal(JSON.stringify(s).includes('tokenHash'), false);

  const list = await call('/homework', { cookie });
  assert.deepEqual([list.data.homework[0].attempts, list.data.homework[0].finished], [3, 2]);

  const csv = await fetch(`${base}/api/homework/${hwk.id}/export`, { headers: { cookie } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /Asha/);

  // revision quiz: Q2 was answered wrong or timed out, only Ben answered it (wrong)
  const revision = await call(`/homework/${hwk.id}/revision`, { method: 'POST', cookie });
  assert.equal(revision.status, 201);
  assert.ok(revision.data.quiz.questions.length >= 1);
  assert.equal(revision.data.quiz.title, 'Revision: Homework quiz');
  assert.deepEqual(revision.data.quiz.tags, ['revision']);

  // only the owner can see any of it
  const other = await register('hw-other@example.com');
  assert.equal((await call(`/homework/${hwk.id}`, { cookie: other })).status, 404);
  assert.equal((await call(`/homework/${hwk.id}`, { method: 'DELETE', cookie: other })).status, 404);
  assert.equal((await call(`/homework/${hwk.id}`)).status, 401);

  // closing stops new joins and new answers, reopening brings them back
  assert.equal((await call(`/homework/${hwk.id}`, { method: 'PATCH', cookie, body: { closed: true } })).status, 200);
  assert.equal((await join(hwk.code, 'Latecomer')).status, 403);
  assert.equal((await next(hwk.code, cleo.token)).status, 403);
  const closedView = (await call(`/hw/${hwk.code}/state`, { token: cleo.token })).data.state;
  assert.equal(closedView.phase, 'closed');
  await call(`/homework/${hwk.id}`, { method: 'PATCH', cookie, body: { closed: false } });
  assert.equal((await join(hwk.code, 'Latecomer')).status, 201);

  // deleting removes the attempts too
  assert.equal((await call(`/homework/${hwk.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.equal(await Attempt.countDocuments({ nicknameKey: 'asha' }), 0);
  assert.equal((await call(`/hw/${hwk.code}`)).status, 404);
});

test('homework settings: hidden answers, hidden leaderboard, deadlines and ownership of the quiz', async () => {
  const cookie = await register('hw-settings@example.com');
  const hwk = await setupHomework(cookie, { revealAnswers: false, showLeaderboard: false });
  const kid = (await join(hwk.code, 'Quietly')).data;
  await next(hwk.code, kid.token);
  const first = await answer(hwk.code, kid.token, 1); // wrong
  assert.equal(first.data.state.last.correct, false);
  assert.equal(first.data.state.last.correctText, null); // not revealed
  for (const choice of [0, 0]) {
    await next(hwk.code, kid.token);
    await answer(hwk.code, kid.token, choice);
  }
  const final = (await call(`/hw/${hwk.code}/state`, { token: kid.token })).data.state.final;
  assert.equal(final.review, null);
  assert.equal(final.rank, null);
  assert.deepEqual(final.leaderboard, []);

  const past = await setupHomework(cookie, { deadline: new Date(Date.now() - 1000).toISOString() });
  assert.equal(past.status, 400);
  const soon = await setupHomework(cookie, { deadline: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(soon.status, 201);
  assert.equal((await call(`/hw/${soon.code}`)).data.open, true);

  // someone else's quiz can't be assigned
  const other = await register('hw-thief@example.com');
  const stolen = await call('/homework', { method: 'POST', cookie: other, body: { quizId: hwk.quizId } });
  assert.equal(stolen.status, 404);
});

test('revision quiz from a saved live game', async () => {
  const cookie = await register('rev-teacher@example.com');
  const me = await call('/auth/me', { cookie });
  const stat = (i, text, correctCount, totalAnswers) => ({ questionIndex: i, text, options: ['a', 'b'], correctIndex: 0, correctCount, totalAnswers, avgTimeMs: 1000, distribution: [correctCount, totalAnswers - correctCount] });

  const session = await Session.create({
    quizTitle: 'Live game',
    host: me.data.user.id,
    code: '123456',
    startedAt: new Date(),
    endedAt: new Date(),
    players: [],
    questionStats: [stat(0, 'Hard', 1, 4), stat(1, 'Easy', 4, 4), stat(2, 'Also hard', 0, 3)],
  });

  const made = await call(`/sessions/${session._id}/revision`, { method: 'POST', cookie });
  assert.equal(made.status, 201);
  assert.deepEqual(made.data.quiz.questions.map((x) => x.text), ['Hard', 'Also hard']);
  assert.equal(made.data.quiz.owner, me.data.user.id);

  const fine = await Session.create({ quizTitle: 'Good game', host: me.data.user.id, code: '654321', startedAt: new Date(), endedAt: new Date(), players: [], questionStats: [stat(0, 'Easy', 5, 5)] });
  assert.equal((await call(`/sessions/${fine._id}/revision`, { method: 'POST', cookie })).status, 400);

  const other = await register('rev-other@example.com');
  assert.equal((await call(`/sessions/${session._id}/revision`, { method: 'POST', cookie: other })).status, 404);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as connectClient } from 'socket.io-client';
import { EV } from '../../public/js/constants.js';

let mongod;
let app;
let base;
let Session;
const sockets = [];

before(async () => {
  mongod = await MongoMemoryServer.create();
  Object.assign(process.env, { MONGO_URI: mongod.getUri(), JWT_SECRET: 'test-secret', PORT: '0', NODE_ENV: 'test', HOST_GRACE_MS: '700' });
  const { startServer } = await import('../index.js');
  app = await startServer();
  base = `http://localhost:${app.server.address().port}`;
  Session = (await import('../models/Session.js')).default;
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await app.stop();
  await mongod.stop();
});

function connect(cookie) {
  const socket = connectClient(base, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : {}, forceNew: true });
  sockets.push(socket);
  return new Promise((resolve) => socket.on('connect', () => resolve(socket)));
}

const emitAck = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

function waitFor(socket, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

const question = (text, options, correctIndex, extra = {}) => ({ type: 'mcq', text, options, correctIndex, timeLimitSec: 10, ...extra });

test('a full 3 question game: scoring, reveal, rejoin, finish and saved session', async () => {
  const reg = await api('/auth/register', { method: 'POST', body: { name: 'Hosty', email: 'host@example.com', password: 'secret123' } });
  assert.equal(reg.status, 201);
  const cookie = reg.cookie;

  const made = await api('/quizzes', {
    method: 'POST',
    cookie,
    body: {
      title: 'Integration quiz',
      questions: [
        question('Q1', ['right', 'wrong', 'nope'], 0),
        question('Q2', ['no', 'yes'], 1),
        { type: 'tf', text: 'Q3', options: ['True', 'False'], correctIndex: 1, timeLimitSec: 10, pointsMode: 'double' },
      ],
    },
  });
  assert.equal(made.status, 201);

  const host = await connect(cookie);
  const created = await emitAck(host, EV.HOST_CREATE, { quizId: made.data.quiz._id });
  assert.equal(created.ok, true);
  const code = created.code;
  assert.match(code, /^\d{6}$/);

  // players join
  const names = ['Ann', 'Ben', 'Cat'];
  const players = [];
  for (const nickname of names) {
    const socket = await connect();
    const joined = await emitAck(socket, EV.PLAYER_JOIN, { code, nickname, avatar: '🦊' });
    assert.equal(joined.ok, true, joined.error);
    players.push({ nickname, socket, token: joined.token, id: joined.playerId });
  }

  const dup = await connect();
  assert.equal((await emitAck(dup, EV.PLAYER_JOIN, { code, nickname: 'ann', avatar: '🦊' })).error, 'That nickname is taken');
  assert.match((await emitAck(dup, EV.PLAYER_JOIN, { code: '000000', nickname: 'Zed', avatar: '🦊' })).error, /No game/);
  assert.match((await emitAck(dup, EV.PLAYER_JOIN, { code, nickname: 'x', avatar: '🦊' })).error, /at least 2/);

  // a player trying a host event gets rejected and nothing starts
  const sneaky = waitFor(players[0].socket, EV.ERROR);
  players[0].socket.emit(EV.HOST_START);
  assert.equal((await sneaky).message, 'Only the host can do that');

  // so does a logged in host who did not create this game
  const other = await api('/auth/register', { method: 'POST', body: { name: 'Other', email: 'other@example.com', password: 'secret123' } });
  const otherHost = await connect(other.cookie);
  assert.equal((await emitAck(otherHost, EV.HOST_CREATE, { code })).error, 'That game no longer exists');

  // play
  // picks[q][player]: Ann always right, Ben right for Q1 and Q2, Cat always wrong
  const picks = [
    [0, 0, 1],
    [1, 1, 0],
    [1, 0, 0],
  ];

  async function playQuestion(q) {
    const starts = players.map((p) => waitFor(p.socket, EV.QUESTION_START));
    if (q === 0) host.emit(EV.HOST_START);
    else host.emit(EV.HOST_NEXT);
    const payloads = await Promise.all(starts);
    assert.equal(payloads[0].index, q);
    assert.equal('correctIndex' in payloads[0], false);
    assert.ok(payloads[0].endsAt > payloads[0].serverNow);

    const reveal = waitFor(host, EV.QUESTION_REVEAL);
    const results = players.map((p) => waitFor(p.socket, EV.ANSWER_RESULT));
    for (let i = 0; i < players.length; i++) {
      const res = await emitAck(players[i].socket, EV.PLAYER_ANSWER, { choice: picks[q][i] });
      assert.equal(res.ok, true);
    }
    // everyone answered, so the reveal comes right away without waiting 10s
    const revealed = await reveal;
    assert.equal(revealed.index, q);
    assert.equal(revealed.isLast, q === 2);
    return { revealed, results: await Promise.all(results) };
  }

  const q1 = await playQuestion(0);
  assert.equal(q1.revealed.correctIndex, 0);
  assert.deepEqual(q1.revealed.distribution, [2, 1, 0]);
  assert.equal(q1.results[0].correct, true);
  assert.equal(q1.results[2].correct, false);
  assert.equal(q1.results[2].points, 0);
  const annAfterQ1 = q1.results[0].score;
  assert.ok(annAfterQ1 > 900);

  // a late answer after the reveal is refused
  assert.equal((await emitAck(players[0].socket, EV.PLAYER_ANSWER, { choice: 0 })).ok, false);

  // Cat refreshes the page: new socket, same token, score and state come back
  players[2].socket.disconnect();
  const cat2 = await connect();
  const rejoined = await emitAck(cat2, EV.PLAYER_REJOIN, { code, token: players[2].token });
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.snapshot.state, 'REVEAL');
  assert.equal(rejoined.snapshot.result.index, 0);
  players[2].socket = cat2;
  assert.equal((await emitAck(await connect(), EV.PLAYER_REJOIN, { code, token: crypto.randomUUID() })).ok, false);

  await playQuestion(1);
  const q3 = await playQuestion(2);
  const annAfterQ3 = q3.results[0].score;
  assert.ok(annAfterQ3 > annAfterQ1);

  // finish
  const finishedHost = waitFor(host, EV.GAME_FINISHED);
  const finishedAnn = waitFor(players[0].socket, EV.GAME_FINISHED);
  host.emit(EV.HOST_NEXT);
  const done = await finishedHost;
  const annDone = await finishedAnn;

  assert.equal(done.reason, 'complete');
  assert.deepEqual(done.leaderboard.map((e) => e.nickname), ['Ann', 'Ben', 'Cat']);
  assert.deepEqual(done.leaderboard.map((e) => e.rank), [1, 2, 3]);
  assert.equal(done.leaderboard[0].score, annAfterQ3);
  assert.equal(annDone.you.rank, 1);
  assert.equal(annDone.you.accuracy, 100);
  assert.equal(annDone.you.longestStreak, 3);
  assert.ok(annDone.you.achievements.includes('Perfect Score'));

  // saved in the database and readable by the host only
  assert.ok(done.sessionId);
  const saved = await Session.findById(done.sessionId);
  assert.equal(saved.quizTitle, 'Integration quiz');
  assert.equal(saved.code, code);
  assert.equal(saved.players.length, 3);
  assert.equal(saved.questionStats.length, 3);
  assert.equal(saved.players.find((p) => p.nickname === 'Ann').rank, 1);
  assert.deepEqual(saved.questionStats[0].distribution.toObject(), [2, 1, 0]);

  const viaApi = await api(`/sessions/${done.sessionId}`, { cookie });
  assert.equal(viaApi.status, 200);
  assert.equal((await api(`/sessions/${done.sessionId}`, { cookie: other.cookie })).status, 404);
  assert.equal((await api(`/sessions/${done.sessionId}`)).status, 401);

  const list = await api('/sessions', { cookie });
  assert.equal(list.data.sessions[0].playerCount, 3);

  const csv = await fetch(`${base}/api/sessions/${done.sessionId}/export`, { headers: { cookie } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /Rank,Nickname,Score/);
  assert.match(text, /Ann/);
});

test('host can kick and lock, and skip ends a question early', async () => {
  const reg = await api('/auth/register', { method: 'POST', body: { name: 'Kicker', email: 'kick@example.com', password: 'secret123' } });
  const made = await api('/quizzes', { method: 'POST', cookie: reg.cookie, body: { title: 'Kick quiz', questions: [question('Only', ['a', 'b'], 0)] } });
  const host = await connect(reg.cookie);
  const { code } = await emitAck(host, EV.HOST_CREATE, { quizId: made.data.quiz._id });

  const a = await connect();
  const b = await connect();
  await emitAck(a, EV.PLAYER_JOIN, { code, nickname: 'Alpha', avatar: '🐼' });
  await emitAck(b, EV.PLAYER_JOIN, { code, nickname: 'Beta', avatar: '🐼' });

  const kicked = waitFor(b, EV.PLAYER_KICKED);
  const lobbyAfterKick = waitFor(host, EV.LOBBY_UPDATE);
  host.emit(EV.HOST_KICK, { playerId: 'p2' }); // Beta joined second
  await kicked;
  assert.deepEqual((await lobbyAfterKick).players.map((p) => p.nickname), ['Alpha']);

  host.emit(EV.HOST_LOCK, { locked: true });
  await waitFor(host, EV.LOBBY_UPDATE);
  const late = await connect();
  assert.equal((await emitAck(late, EV.PLAYER_JOIN, { code, nickname: 'Latecomer', avatar: '🐼' })).error, 'The lobby is locked');

  const started = waitFor(a, EV.QUESTION_START);
  host.emit(EV.HOST_START);
  await started;

  const paused = waitFor(a, EV.GAME_PAUSED);
  host.emit(EV.HOST_PAUSE);
  assert.ok((await paused).remainingMs > 0);
  assert.equal((await emitAck(a, EV.PLAYER_ANSWER, { choice: 0 })).ok, false);

  const resumed = waitFor(a, EV.GAME_RESUMED);
  host.emit(EV.HOST_RESUME);
  assert.ok((await resumed).endsAt > Date.now());

  const reveal = waitFor(host, EV.QUESTION_REVEAL);
  host.emit(EV.HOST_SKIP);
  assert.equal((await reveal).isLast, true);

  const ended = waitFor(host, EV.GAME_FINISHED);
  host.emit(EV.HOST_END);
  assert.equal((await ended).reason, 'ended');
});

test('a socket that spams join attempts gets throttled', async () => {
  const socket = await connect();
  let acks = 0;
  let slowDown = 0;
  socket.on(EV.ERROR, (e) => e.message === 'Slow down a little' && slowDown++);
  for (let i = 0; i < 12; i++) socket.emit(EV.PLAYER_JOIN, { code: '000000', nickname: 'spam', avatar: '🦊' }, () => acks++);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(acks <= 5, `expected at most 5 handled, got ${acks}`);
  assert.ok(slowDown >= 1);
});

test('socket.io client module is served for the browser', async () => {
  const res = await fetch(`${base}/socket.io/socket.io.esm.min.js`);
  assert.equal(res.status, 200);
});

test('host disconnect: control comes back inside the grace period, otherwise the game ends', async () => {
  const reg = await api('/auth/register', { method: 'POST', body: { name: 'Flaky', email: 'flaky@example.com', password: 'secret123' } });
  const made = await api('/quizzes', { method: 'POST', cookie: reg.cookie, body: { title: 'Grace quiz', questions: [question('Only', ['a', 'b'], 0)] } });

  // 1. host drops and returns in time
  let host = await connect(reg.cookie);
  const { code } = await emitAck(host, EV.HOST_CREATE, { quizId: made.data.quiz._id });
  const player = await connect();
  await emitAck(player, EV.PLAYER_JOIN, { code, nickname: 'Steady', avatar: '🐧' });

  const awayUpdate = waitFor(player, EV.LOBBY_UPDATE);
  host.disconnect();
  assert.equal((await awayUpdate).hostConnected, false);

  host = await connect(reg.cookie);
  const back = await emitAck(host, EV.HOST_CREATE, { code });
  assert.equal(back.ok, true);
  assert.equal(back.snapshot.state, 'LOBBY');
  await new Promise((r) => setTimeout(r, 1000)); // longer than the grace period
  const started = waitFor(player, EV.QUESTION_START);
  host.emit(EV.HOST_START);
  await started; // still alive and the returning host is in control

  // 2. host drops and stays away
  const finished = waitFor(player, EV.GAME_FINISHED, 3000);
  host.disconnect();
  const result = await finished;
  assert.equal(result.reason, 'host-left');
});

test('ai routes: status is off without a key, generate is refused, bad input is a 400, and login is required', async () => {
  const reg = await api('/auth/register', { method: 'POST', body: { name: 'Ai', email: 'ai@example.com', password: 'secret123' } });
  assert.equal((await api('/ai/status')).status, 401);
  assert.equal((await api('/ai/status', { cookie: reg.cookie })).data.enabled, false);
  assert.equal((await api('/ai/generate', { method: 'POST', cookie: reg.cookie, body: { topic: 'Space', count: 3 } })).status, 503);
  assert.equal((await api('/ai/generate', { method: 'POST', cookie: reg.cookie, body: { topic: 'x', count: 99 } })).status, 400);
});

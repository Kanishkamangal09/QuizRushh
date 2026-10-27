import { EV, STATES, AVATARS, NICK_MIN, NICK_MAX } from './constants.js';
import { connect } from './socket.js';
import { el, toast, makeCountdown, leaderboardList, distributionBars, letter } from './ui.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SAVE_KEY = 'qr-player';

const screens = ['loading', 'join', 'lobby', 'question', 'reveal', 'finished', 'kicked'];
function show(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle('hidden', s !== name);
}
const announce = (text) => ($('announce').textContent = text);

// seats live in localStorage so a refresh or a reopened tab gets the same player back.
// shape: { "<game code>": [{ token, playerId }] }. the token is secret, it only goes to the server
function loadSeats() {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY)) || {};
  } catch {
    return {};
  }
}

function addSeat(code, token) {
  const seats = loadSeats();
  seats[code] = [...(seats[code] || []), { token }];
  localStorage.setItem(SAVE_KEY, JSON.stringify(seats));
}

function removeSeat(token) {
  const seats = loadSeats();
  for (const code of Object.keys(seats)) {
    seats[code] = seats[code].filter((s) => s.token !== token);
    if (seats[code].length === 0) delete seats[code];
  }
  localStorage.setItem(SAVE_KEY, JSON.stringify(seats));
}

// one tab per seat: the lock is held until the tab closes, so a second tab in the same
// browser can't steal the seat and can join as its own player instead.
// no navigator.locks on plain http (phone over wifi), there we just skip the check
function claimSeat(token) {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request(`qr-seat-${token}`, { ifAvailable: true }, (lock) => {
      resolve(Boolean(lock));
      return lock ? new Promise(() => {}) : undefined;
    });
  });
}

async function pickSeat(onlyCode) {
  for (const [code, list] of Object.entries(loadSeats())) {
    if (onlyCode && code !== onlyCode) continue;
    for (const seat of list) {
      if (await claimSeat(seat.token)) return { code, token: seat.token };
    }
  }
  return null;
}

let me = null; // { code, token, playerId }
const urlCode = params.get('code');

let state = STATES.LOBBY;
let lobby = null;
let question = null;
let paused = false;
let answered = false;
let lastResult = null;
const countdown = makeCountdown();
$('q-countdown').append(countdown.box);

const POINTS_TEXT = { standard: 'Standard points', double: 'Double points', none: 'No points' };

// ---------- join form ----------

AVATARS.forEach((a, i) => {
  $('avatars').append(
    el(
      'label',
      { class: 'avatar-pick' },
      el('input', { class: 'sr-only', type: 'radio', name: 'avatar', value: a, checked: i === 0 }),
      el('span', {}, a)
    )
  );
});

function showJoin(message = '') {
  show('join');
  $('code').value = urlCode || '';
  $('join-error').textContent = message;
  (urlCode ? $('nickname') : $('code')).focus();
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  const nickname = $('nickname').value.trim();
  const avatar = document.querySelector('input[name="avatar"]:checked')?.value;
  const err = $('join-error');

  if (!/^\d{6}$/.test(code)) return (err.textContent = 'The game code is 6 digits');
  if (nickname.length < NICK_MIN || nickname.length > NICK_MAX) return (err.textContent = `Nickname must be ${NICK_MIN} to ${NICK_MAX} characters`);

  err.textContent = '';
  $('join-btn').disabled = true;
  socket.emit(EV.PLAYER_JOIN, { code, nickname, avatar }, (res) => {
    $('join-btn').disabled = false;
    if (!res.ok) return (err.textContent = res.error);
    me = { code, token: res.token, playerId: res.playerId };
    addSeat(code, res.token);
    claimSeat(res.token);
    apply(res.snapshot);
  });
});

// ---------- screens ----------

const hostAway = (away) => $('host-away').classList.toggle('hidden', !away);

function renderLobby() {
  show('lobby');
  const mine = lobby.players.find((p) => p.id === me.playerId);
  $('me-avatar').textContent = mine?.avatar ?? '';
  $('me-name').textContent = mine?.nickname ?? '';
  $('count').textContent = lobby.players.length;
  $('players').replaceChildren(
    ...lobby.players.map((p) =>
      el(
        'li',
        { class: `player-chip${p.connected ? '' : ' away'}` },
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, p.avatar),
        p.nickname,
        p.id === me.playerId && el('small', {}, '(you)')
      )
    )
  );
}

function lockAnswers(picked) {
  document.querySelectorAll('#answers .answer').forEach((btn, i) => {
    btn.disabled = true;
    btn.classList.toggle('picked', i === picked);
    btn.setAttribute('aria-pressed', String(i === picked));
  });
}

function sendAnswer(choice) {
  if (answered || paused) return;
  answered = true;
  lockAnswers(choice);
  $('answer-note').textContent = 'Locked in. Waiting for everyone else...';
  socket.emit(EV.PLAYER_ANSWER, { choice }, (res) => {
    if (res.ok) return;
    $('answer-note').textContent = res.error;
    toast(res.error, 'error');
  });
}

function renderQuestion(q, snap) {
  state = STATES.QUESTION;
  question = q;
  lastResult = null;
  answered = snap?.myChoice != null;
  paused = !!snap?.paused;
  show('question');

  $('q-badge').textContent = `Question ${q.index + 1} of ${q.total}`;
  $('q-points').textContent = POINTS_TEXT[q.pointsMode];
  $('q-text').textContent = q.text;
  $('answer-note').textContent = answered ? 'Locked in. Waiting for everyone else...' : '';
  $('paused-note').classList.toggle('hidden', !paused);

  $('answers').replaceChildren(
    ...q.options.map((text, i) =>
      el(
        'button',
        { class: `btn answer opt-${i}`, type: 'button', disabled: answered || paused, 'aria-pressed': 'false', onclick: () => sendAnswer(i) },
        el('span', { class: 'letter' }, letter(i)),
        el('span', {}, text)
      )
    )
  );
  if (answered) lockAnswers(snap.myChoice);

  if (paused) countdown.freeze(snap.remainingMs, q.timeLimitSec * 1000);
  else countdown.run(q.endsAt, q.serverNow, q.timeLimitSec * 1000);
  announce(`Question ${q.index + 1} of ${q.total}: ${q.text}`);
}

function renderReveal(r, result) {
  state = STATES.REVEAL;
  countdown.stop();
  show('reveal');

  const card = $('result-card');
  card.className = 'result-card';
  let title = 'Round over';
  let detail = '';
  let points = '';

  if (result && result.index === r.index) {
    if (!result.answered) {
      title = 'Time ran out';
      card.classList.add('bad');
    } else if (result.correct) {
      title = 'Correct!';
      card.classList.add('good');
    } else {
      title = 'Not quite';
      card.classList.add('bad');
    }
    points = result.answered ? `+${result.points.toLocaleString()}` : '+0';
    const streak = result.streak > 1 ? ` · ${result.streak} in a row` : '';
    detail = `Rank #${result.rank} · ${result.score.toLocaleString()} points${streak}`;
  }
  $('result-title').textContent = title;
  $('result-points').textContent = points;
  $('result-detail').textContent = detail;

  const correctText = question ? `${letter(r.correctIndex)}. ${question.options[r.correctIndex]}` : letter(r.correctIndex);
  $('p-correct').textContent = `Correct answer: ${correctText}`;
  $('p-dist').replaceChildren(question ? distributionBars(question.options, r.distribution, r.correctIndex) : '');
  $('p-board').replaceChildren(leaderboardList(r.leaderboard, me.playerId));
  announce(`${title}. ${points} points. ${detail}`);
}

const FINISH_BANNERS = {
  ended: 'The host ended the game early.',
  'host-left': 'The host left, so the game ended.',
};

function renderFinished(f) {
  state = STATES.FINISHED;
  countdown.stop();
  show('finished');
  hostAway(false);

  const banner = $('f-banner');
  banner.textContent = FINISH_BANNERS[f.reason] || '';
  banner.classList.toggle('hidden', !FINISH_BANNERS[f.reason]);

  const you = f.you;
  const played = you && you.totalQuestions > 0;
  $('f-title').textContent = played ? `You finished #${you.rank} of ${f.leaderboard.length}` : 'The game ended before any questions were played';

  const stat = (label, value) => el('div', { class: 'card stat' }, el('b', {}, value), label);
  $('f-stats').replaceChildren(
    ...(played
      ? [
          stat('Score', you.score.toLocaleString()),
          stat('Accuracy', `${you.accuracy}%`),
          stat('Longest streak', you.longestStreak),
          stat('Fastest correct', you.fastestCorrectMs == null ? '-' : `${(you.fastestCorrectMs / 1000).toFixed(1)}s`),
        ]
      : [])
  );

  $('f-badges').replaceChildren(
    ...(you && you.achievements.length ? you.achievements.map((a) => el('span', { class: 'badge' }, a)) : [el('span', { class: 'muted' }, 'No badges this time. Next game!')])
  );
  $('f-board').replaceChildren(leaderboardList(f.leaderboard.slice(0, 10), me.playerId));
  announce(played ? `Game over. You finished number ${you.rank}.` : 'Game over');
}

function apply(snap) {
  lobby = snap.lobby;
  hostAway(!lobby.hostConnected && snap.state !== STATES.FINISHED);
  if (snap.state === STATES.LOBBY) {
    state = STATES.LOBBY;
    renderLobby();
  } else if (snap.state === STATES.QUESTION) {
    renderQuestion(snap.question, snap);
  } else if (snap.state === STATES.REVEAL) {
    question = snap.question;
    lastResult = snap.result;
    renderReveal(snap.reveal, snap.result);
  } else {
    renderFinished(snap.finished);
  }
}

// ---------- connection ----------

const socket = connect($('conn'));

// first connect and every reconnect: if we have a saved seat, take it back
function rejoin() {
  socket.emit(EV.PLAYER_REJOIN, { code: me.code, token: me.token }, (res) => {
    if (res.ok) {
      me.playerId = res.playerId;
      return apply(res.snapshot);
    }
    removeSeat(me.token);
    me = null;
    showJoin('That game is over or you were removed. Join again with a code.');
  });
}

let started = false;
socket.on('connect', async () => {
  if (!started) {
    started = true;
    me = await pickSeat(urlCode);
    return me ? rejoin() : showJoin();
  }
  // later reconnects: take our seat back, or leave the join form alone
  if (me) rejoin();
});

socket.on(EV.LOBBY_UPDATE, (payload) => {
  lobby = payload;
  hostAway(!payload.hostConnected && state !== STATES.FINISHED);
  if (state === STATES.LOBBY && me && !$('screen-lobby').classList.contains('hidden')) renderLobby();
});
socket.on(EV.QUESTION_START, (q) => renderQuestion(q));
socket.on(EV.ANSWER_RESULT, (result) => (lastResult = result));
socket.on(EV.QUESTION_REVEAL, (r) => renderReveal(r, lastResult));
socket.on(EV.GAME_PAUSED, ({ remainingMs }) => {
  paused = true;
  countdown.freeze(remainingMs, question.timeLimitSec * 1000);
  $('paused-note').classList.remove('hidden');
  document.querySelectorAll('#answers .answer').forEach((b) => (b.disabled = true));
  announce('Game paused by the host');
});
socket.on(EV.GAME_RESUMED, ({ endsAt, serverNow }) => {
  paused = false;
  countdown.run(endsAt, serverNow, question.timeLimitSec * 1000);
  $('paused-note').classList.add('hidden');
  if (!answered) document.querySelectorAll('#answers .answer').forEach((b) => (b.disabled = false));
  announce('Game resumed');
});
socket.on(EV.GAME_FINISHED, renderFinished);
socket.on(EV.PLAYER_KICKED, () => {
  removeSeat(me.token);
  me = null;
  countdown.stop();
  hostAway(false);
  show('kicked');
});
socket.on(EV.ERROR, ({ message }) => toast(message, 'error'));

$('again').addEventListener('click', () => {
  removeSeat(me.token);
  location.href = '/';
});

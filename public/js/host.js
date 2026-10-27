import { requireLogin } from './api.js';
import { EV, STATES } from './constants.js';
import { connect } from './socket.js';
import { el, toast, confirmDialog, makeCountdown, leaderboardList, distributionBars, copyText, letter } from './ui.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const quizId = params.get('quiz');
let code = params.get('code');

const screens = ['loading', 'error', 'lobby', 'question', 'reveal', 'finished'];
function show(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle('hidden', s !== name);
}
const announce = (text) => ($('announce').textContent = text);

let socket;
let question = null;
let locked = false;
let knownPlayers = new Set();
const countdown = makeCountdown();
$('q-countdown').append(countdown.box);

const POINTS_TEXT = { standard: 'Standard points', double: 'Double points', none: 'No points' };

function fatal(message) {
  $('error-msg').textContent = message;
  show('error');
}

function renderLobby(lobby) {
  show('lobby');
  const link = `${location.origin}/play.html?code=${lobby.code}`;
  $('code').textContent = lobby.code;
  $('join-url-text').textContent = `${location.host}/play.html`;
  $('join-link').value = link;

  locked = lobby.locked;
  $('lock').textContent = locked ? 'Unlock lobby' : 'Lock lobby';
  $('lock').setAttribute('aria-pressed', String(locked));

  $('count').textContent = `${lobby.players.length} / ${lobby.maxPlayers}`;
  $('no-players').classList.toggle('hidden', lobby.players.length > 0);
  $('start').disabled = lobby.players.length === 0;

  const items = lobby.players.map((p) => {
    // only animate people who just arrived, not the whole list on every update
    const isNew = !knownPlayers.has(p.id);
    const chip = el(
      'li',
      { class: `player-chip${p.connected ? '' : ' away'}` },
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, p.avatar),
      p.nickname,
      !p.connected && el('small', {}, '(away)'),
      el('button', { class: 'btn btn-small', type: 'button', 'aria-label': `Remove ${p.nickname}`, onclick: () => socket.emit(EV.HOST_KICK, { playerId: p.id }) }, 'Kick')
    );
    if (!isNew) chip.style.animation = 'none';
    return chip;
  });
  knownPlayers = new Set(lobby.players.map((p) => p.id));
  $('players').replaceChildren(...items);
}

function renderQuestion(q, snap) {
  question = q;
  show('question');
  $('q-badge').textContent = `Question ${q.index + 1} of ${q.total}`;
  $('q-points').textContent = POINTS_TEXT[q.pointsMode];
  $('q-text').textContent = q.text;
  $('q-options').replaceChildren(
    ...q.options.map((text, i) => el('div', { class: `answer opt-${i}` }, el('span', { class: 'letter' }, letter(i)), el('span', {}, text)))
  );
  $('progress').textContent = snap?.progress ? `${snap.progress.answered} of ${snap.progress.total} answered` : '';

  const paused = snap?.paused;
  $('pause').classList.toggle('hidden', !!paused);
  $('resume').classList.toggle('hidden', !paused);
  if (paused) countdown.freeze(snap.remainingMs, q.timeLimitSec * 1000);
  else countdown.run(q.endsAt, q.serverNow, q.timeLimitSec * 1000);
  announce(`Question ${q.index + 1} of ${q.total}: ${q.text}`);
}

function renderReveal(r) {
  countdown.stop();
  show('reveal');
  $('r-title').textContent = `Question ${r.index + 1} of ${r.total}`;
  const answerText = question ? `${letter(r.correctIndex)}. ${question.options[r.correctIndex]}` : letter(r.correctIndex);
  $('r-correct').textContent = `Correct answer: ${answerText}`;
  $('r-dist').replaceChildren(question ? distributionBars(question.options, r.distribution, r.correctIndex) : '');
  $('r-board').replaceChildren(leaderboardList(r.leaderboard));
  $('next').textContent = r.isLast ? 'Finish game' : 'Next question';
  announce(`Results for question ${r.index + 1}. Correct answer: ${answerText}`);
}

const FINISH_NOTES = {
  complete: 'All questions are done.',
  ended: 'The game was ended early.',
  'host-left': 'The game ended because the host connection was lost for over a minute.',
};

function renderFinished(f) {
  countdown.stop();
  show('finished');
  $('f-note').textContent = FINISH_NOTES[f.reason] || '';
  $('f-board').replaceChildren(leaderboardList(f.leaderboard.slice(0, 10)));
  const link = $('f-results');
  link.classList.toggle('hidden', !f.sessionId);
  if (f.sessionId) link.href = `/results.html?id=${f.sessionId}`;
  else $('f-note').textContent += ' No questions were played, so nothing was saved.';
  announce('Game over');
}

function apply(snap) {
  if (snap.state === STATES.LOBBY) renderLobby(snap.lobby);
  else if (snap.state === STATES.QUESTION) renderQuestion(snap.question, snap);
  else if (snap.state === STATES.REVEAL) {
    question = snap.question;
    renderReveal(snap.reveal);
  } else renderFinished(snap.finished);
}

async function endGame() {
  if (await confirmDialog('End the game for everyone?', 'End game')) socket.emit(EV.HOST_END);
}

function wireButtons() {
  $('copy').addEventListener('click', () => copyText($('join-link').value));
  $('join-link').addEventListener('focus', (e) => e.target.select());
  $('lock').addEventListener('click', () => socket.emit(EV.HOST_LOCK, { locked: !locked }));
  $('start').addEventListener('click', () => socket.emit(EV.HOST_START));
  $('cancel').addEventListener('click', endGame);
  $('end-q').addEventListener('click', endGame);
  $('end-r').addEventListener('click', endGame);
  $('pause').addEventListener('click', () => socket.emit(EV.HOST_PAUSE));
  $('resume').addEventListener('click', () => socket.emit(EV.HOST_RESUME));
  $('skip').addEventListener('click', () => socket.emit(EV.HOST_SKIP));
  $('next').addEventListener('click', () => socket.emit(EV.HOST_NEXT));
}

function wireSocket() {
  // runs on the first connect and after every reconnect, the code gets us back into our game
  socket.on('connect', () => {
    socket.emit(EV.HOST_CREATE, code ? { code } : { quizId }, (res) => {
      if (!res.ok) return fatal(res.error);
      code = res.code;
      history.replaceState(null, '', `?code=${code}`);
      apply(res.snapshot);
    });
  });

  socket.on(EV.LOBBY_UPDATE, (lobby) => {
    if (!$('screen-lobby').classList.contains('hidden')) renderLobby(lobby);
  });
  socket.on(EV.QUESTION_START, (q) => renderQuestion(q));
  socket.on(EV.ANSWER_PROGRESS, (p) => ($('progress').textContent = `${p.answered} of ${p.total} answered`));
  socket.on(EV.QUESTION_REVEAL, renderReveal);
  socket.on(EV.GAME_PAUSED, ({ remainingMs }) => {
    countdown.freeze(remainingMs, question.timeLimitSec * 1000);
    $('pause').classList.add('hidden');
    $('resume').classList.remove('hidden');
    announce('Game paused');
  });
  socket.on(EV.GAME_RESUMED, ({ endsAt, serverNow }) => {
    countdown.run(endsAt, serverNow, question.timeLimitSec * 1000);
    $('pause').classList.remove('hidden');
    $('resume').classList.add('hidden');
    announce('Game resumed');
  });
  socket.on(EV.GAME_FINISHED, renderFinished);
  socket.on(EV.ERROR, ({ message }) => toast(message, 'error'));
}

try {
  if (!(await requireLogin())) throw new Error('redirecting');
  if (!quizId && !code) {
    fatal('Pick a quiz on your dashboard to host a game.');
  } else {
    wireButtons();
    socket = connect($('conn'));
    wireSocket();
  }
} catch (err) {
  if (err.message !== 'redirecting') fatal(err.message);
}

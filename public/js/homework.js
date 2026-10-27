import { api } from './api.js';
import { NICK_MIN, NICK_MAX } from './constants.js';
import { el, toast, makeCountdown, leaderboardList, letter, avatarPicker } from './ui.js';

const $ = (id) => document.getElementById(id);
const code = (new URLSearchParams(location.search).get('c') || '').trim().toUpperCase();
const KEY = 'qr-hw';

const screens = ['loading', 'error', 'join', 'ready', 'question', 'done', 'closed'];
function show(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle('hidden', s !== name);
}
const announce = (text) => ($('announce').textContent = text);

const POINTS_TEXT = { standard: 'Standard points', double: 'Double points', none: 'No points' };

// the attempt token is kept per homework code, it is the only thing that identifies this student
function readTokens() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
function saveToken(value) {
  const all = readTokens();
  if (value) all[code] = value;
  else delete all[code];
  localStorage.setItem(KEY, JSON.stringify(all));
}

let token = readTokens()[code] ?? null;
let timeoutId;
let picked = false;
const countdown = makeCountdown();
$('q-countdown').append(countdown.box);

const call = (path, method = 'GET', body) => api(`/hw/${code}${path}`, { method, body, headers: token ? { 'X-Attempt-Token': token } : {} });

function fail(message) {
  $('error-msg').textContent = message;
  show('error');
}

// ---------- screens ----------

function showJoin(info) {
  show('join');
  $('j-title').textContent = info.title;
  $('j-desc').textContent = info.description;
  const due = info.deadline ? ` · due ${new Date(info.deadline).toLocaleString()}` : '';
  $('j-meta').textContent = `${info.questionCount} question${info.questionCount === 1 ? '' : 's'}${due}`;
  $('nickname').focus();
}

function renderReady(s) {
  show('ready');
  $('r-title').textContent = s.title;
  $('r-progress').textContent =
    s.answered === 0
      ? `${s.total} questions. Each one has its own timer, and it only starts when you press the button.`
      : `${s.answered} of ${s.total} done · ${s.score.toLocaleString()} points`;

  const box = $('r-last');
  box.replaceChildren();
  if (s.last) {
    const l = s.last;
    const title = !l.answered ? 'Time ran out' : l.correct ? 'Correct!' : 'Not quite';
    box.append(
      el(
        'div',
        { class: `result-card ${l.correct ? 'good' : 'bad'}` },
        el('h2', {}, title),
        el('p', { class: 'big' }, `+${l.points.toLocaleString()}`),
        s.streak > 1 && el('p', {}, `${s.streak} in a row`),
        l.correctText && !l.correct && el('p', {}, `Correct answer: ${letter(l.correctIndex)}. ${l.correctText}`)
      )
    );
    announce(`${title}. ${l.points} points.`);
  }
  $('go').textContent = s.answered === 0 ? 'Start' : 'Next question';
  $('go').disabled = false;
  $('go').focus();
}

function lockAnswers(chosen) {
  document.querySelectorAll('#answers .answer').forEach((btn, i) => {
    btn.disabled = true;
    btn.classList.toggle('picked', i === chosen);
    btn.setAttribute('aria-pressed', String(i === chosen));
  });
}

async function pick(choice) {
  if (picked) return;
  picked = true;
  lockAnswers(choice);
  $('answer-note').textContent = 'Checking...';
  try {
    const { state } = await call('/answer', 'POST', { choice });
    render(state);
  } catch (err) {
    toast(err.message, 'error');
    await refresh();
  }
}

function renderQuestion(s) {
  const q = s.question;
  show('question');
  picked = false;
  $('q-badge').textContent = `Question ${q.index + 1} of ${q.total}`;
  $('q-points').textContent = POINTS_TEXT[q.pointsMode];
  $('q-text').textContent = q.text;
  $('answer-note').textContent = '';
  $('answers').replaceChildren(
    ...q.options.map((text, i) =>
      el('button', { class: `btn answer opt-${i}`, type: 'button', 'aria-pressed': 'false', onclick: () => pick(i) }, el('span', { class: 'letter' }, letter(i)), el('span', {}, text))
    )
  );
  countdown.run(q.endsAt, q.serverNow, q.timeLimitSec * 1000);
  announce(`Question ${q.index + 1} of ${q.total}: ${q.text}`);

  // when time is up, ask the server so the question is closed and we move on
  const msLeft = q.endsAt - q.serverNow;
  timeoutId = setTimeout(refresh, Math.max(0, msLeft) + 700);
}

function renderDone(s) {
  show('done');
  const f = s.final;
  $('f-title').textContent = f.rank ? `You finished #${f.rank}` : 'All done!';

  const stat = (label, value) => el('div', { class: 'card stat' }, el('b', {}, value), label);
  $('f-stats').replaceChildren(
    stat('Score', f.score.toLocaleString()),
    stat('Accuracy', `${f.accuracy}%`),
    stat('Longest streak', f.longestStreak),
    stat('Fastest correct', f.fastestCorrectMs == null ? '-' : `${(f.fastestCorrectMs / 1000).toFixed(1)}s`)
  );
  $('f-badges').replaceChildren(...(f.achievements.length ? f.achievements.map((a) => el('span', { class: 'badge' }, a)) : [el('span', { class: 'muted' }, 'No badges this time.')]));

  const optionText = (options, i) => (i >= 0 ? `${letter(i)}. ${options[i]}` : 'No answer');
  $('f-review').replaceChildren(
    ...(f.review
      ? [
          el('h2', {}, 'Your answers'),
          ...f.review.map((r, i) =>
            el(
              'div',
              { class: 'card review-item' },
              el('h3', {}, `Q${i + 1}. ${r.text}`),
              el('p', { class: r.choice === r.correctIndex ? 'text-good' : 'text-bad' }, `You: ${optionText(r.options, r.choice)}`),
              r.choice !== r.correctIndex && el('p', {}, `Correct: ${optionText(r.options, r.correctIndex)}`)
            )
          ),
        ]
      : [])
  );

  $('f-board-box').classList.toggle('hidden', f.leaderboard.length === 0);
  $('f-board').replaceChildren(leaderboardList(f.leaderboard, f.me));
  announce(`Homework finished. Score ${f.score}.`);
}

function renderClosed(s) {
  show('closed');
  $('closed-msg').textContent = `Your score so far: ${s.score.toLocaleString()} points. Ask your teacher if you need more time.`;
}

function render(state) {
  clearTimeout(timeoutId);
  countdown.stop();
  if (state.phase === 'question') renderQuestion(state);
  else if (state.phase === 'done') renderDone(state);
  else if (state.phase === 'closed') renderClosed(state);
  else renderReady(state);
}

async function refresh() {
  try {
    render((await call('/state')).state);
  } catch (err) {
    if (err.status === 401) {
      saveToken(null);
      token = null;
      return fail('We lost your place in this homework. Open the link again to start over.');
    }
    toast(err.message, 'error');
  }
}

// ---------- events ----------

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  try {
    render((await call('/next', 'POST')).state);
  } catch (err) {
    toast(err.message, 'error');
    $('go').disabled = false;
  }
});

// on a shared computer the next student has to be able to leave the previous student's attempt
document.querySelectorAll('.switch').forEach((btn) =>
  btn.addEventListener('click', () => {
    saveToken(null);
    location.reload();
  })
);

avatarPicker($('avatars'));

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nickname = $('nickname').value.trim();
  const avatar = document.querySelector('input[name="avatar"]:checked')?.value;
  const err = $('join-error');
  if (nickname.length < NICK_MIN || nickname.length > NICK_MAX) return (err.textContent = `Your name must be ${NICK_MIN} to ${NICK_MAX} characters`);

  err.textContent = '';
  $('join-btn').disabled = true;
  try {
    const res = await call('/join', 'POST', { nickname, avatar });
    token = res.token;
    saveToken(token);
    render(res.state);
  } catch (e2) {
    err.textContent = e2.message;
  }
  $('join-btn').disabled = false;
});

// ---------- start ----------

async function start() {
  if (!code) return fail('This link is missing its homework code.');
  try {
    const info = await call('');
    if (token) {
      try {
        return render((await call('/state')).state);
      } catch (err) {
        if (err.status !== 401) throw err;
        saveToken(null); // the attempt is gone, start fresh
        token = null;
      }
    }
    if (!info.open) {
      show('closed');
      $('closed-msg').textContent = 'The deadline has passed or your teacher closed it.';
      return;
    }
    showJoin(info);
  } catch (err) {
    fail(err.message);
  }
}

start();

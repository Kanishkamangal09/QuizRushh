import { api, requireLogin } from './api.js';
import { el, toast, showLoading, distributionBars, letter, formatDate } from './ui.js';

const content = document.getElementById('content');
const params = new URLSearchParams(location.search);
const id = params.get('id');
const hwId = params.get('hw');
// a result page is either a live game (id) or a homework assignment (hw)
const source = hwId ? `/homework/${hwId}` : `/sessions/${id}`;
const csvLink = `/api${source}/export`;

// same rule as the server: weak means fewer than half of the answers were right
const weakQuestions = (stats) => stats.filter((q) => q.totalAnswers > 0 && q.correctCount / q.totalAnswers < 0.5);

const seconds = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);
const percent = (n, total) => (total ? Math.round((n / total) * 100) : 0);

function podium(players) {
  const top = players.slice(0, 3);
  // 2nd, 1st, 3rd so the winner sits in the middle
  const order = [top[1], top[0], top[2]].filter(Boolean);
  return el(
    'div',
    { class: 'podium' },
    order.map((p) =>
      el(
        'div',
        { class: `podium-slot podium-${p.rank}` },
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, p.avatar),
        p.nickname,
        el('div', {}, p.score.toLocaleString()),
        el('div', { class: 'podium-block' }, p.rank)
      )
    )
  );
}

function leaderboardTable(players) {
  const head = ['Rank', 'Player', 'Score', 'Accuracy', 'Best streak', 'Fastest', 'Badges'];
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el('caption', { class: 'sr-only' }, 'Final leaderboard'),
      el('thead', {}, el('tr', {}, head.map((h) => el('th', { scope: 'col' }, h)))),
      el(
        'tbody',
        {},
        players.map((p) =>
          el(
            'tr',
            {},
            el('td', {}, p.rank),
            el('td', {}, `${p.avatar} ${p.nickname}${p.finished === false ? ' (in progress)' : ''}`),
            el('td', {}, p.score.toLocaleString()),
            el('td', {}, `${p.accuracy}%`),
            el('td', {}, p.longestStreak),
            el('td', {}, seconds(p.fastestCorrectMs)),
            el('td', {}, p.achievements.join(', ') || '-')
          )
        )
      )
    )
  );
}

function questionCards(stats) {
  // hardest and easiest only mean something with 2+ questions that differ
  const ratios = stats.map((q) => (q.totalAnswers ? q.correctCount / q.totalAnswers : null));
  const valid = ratios.filter((r) => r !== null);
  const hardest = ratios.indexOf(Math.min(...valid));
  const easiest = ratios.indexOf(Math.max(...valid));
  const showTags = valid.length > 1 && hardest !== easiest;

  return stats.map((q, i) =>
    el(
      'article',
      { class: 'card stack' },
      el(
        'div',
        { class: 'row spread' },
        el('h3', {}, `Q${i + 1}. ${q.text}`),
        el('div', { class: 'row' }, showTags && i === hardest && el('span', { class: 'badge hard' }, 'Hardest'), showTags && i === easiest && el('span', { class: 'badge easy' }, 'Easiest'))
      ),
      el('p', { class: 'muted' }, `${percent(q.correctCount, q.totalAnswers)}% correct · ${q.totalAnswers} answer${q.totalAnswers === 1 ? '' : 's'} · average ${seconds(q.avgTimeMs)}`),
      distributionBars(q.options, q.distribution, q.correctIndex)
    )
  );
}

function playerBreakdown(players, stats) {
  return players.map((p) =>
    el(
      'details',
      { class: 'card' },
      el('summary', {}, `#${p.rank} ${p.avatar} ${p.nickname}${p.finished === false ? ' (in progress)' : ''} · ${p.score.toLocaleString()} points`),
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, ['Question', 'Result', 'Points', 'Time'].map((h) => el('th', { scope: 'col' }, h)))),
          el(
            'tbody',
            {},
            stats.map((q) => {
              const a = p.answers.find((x) => x.questionIndex === q.questionIndex);
              const result = !a || a.choice < 0 ? 'No answer' : a.correct ? 'Correct' : `Wrong (${letter(a.choice)})`;
              return el('tr', {}, el('td', {}, `Q${q.questionIndex + 1}`), el('td', {}, result), el('td', {}, a ? a.points : 0), el('td', {}, seconds(a?.timeMs)));
            })
          )
        )
      )
    )
  );
}

async function makeRevision(button) {
  button.disabled = true;
  try {
    const { quiz } = await api(`${source}/revision`, { method: 'POST' });
    location.href = `/editor.html?id=${quiz._id}`;
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
}

function render(s) {
  const players = [...s.players].sort((a, b) => a.rank - b.rank);
  const weak = weakQuestions(s.questionStats);

  let subtitle;
  if (s.kind === 'homework') {
    const finished = players.filter((p) => p.finished).length;
    subtitle = `Homework · ${players.length} students, ${finished} finished · ${s.deadline ? `due ${formatDate(s.deadline)}` : 'no deadline'}${s.closed ? ' · closed' : ''}`;
  } else {
    const minutes = Math.max(1, Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000));
    subtitle = `${formatDate(s.endedAt)} · ${players.length} players · ${s.questionStats.length} questions · about ${minutes} min`;
  }

  const revision = el('button', { class: 'btn', type: 'button' }, `Make revision quiz (${weak.length})`);
  revision.addEventListener('click', () => makeRevision(revision));

  content.replaceChildren(
    el(
      'div',
      { class: 'row spread' },
      el('div', {}, el('h1', {}, s.quizTitle), el('p', { class: 'muted' }, subtitle)),
      el('div', { class: 'row' }, weak.length > 0 && revision, el('a', { class: 'btn', href: csvLink, download: '' }, 'Download CSV'))
    ),
    weak.length > 0 && el('p', { class: 'hint' }, `Revision quiz: copies the ${weak.length} question${weak.length === 1 ? '' : 's'} that fewer than half answered correctly into a new quiz you can edit.`),
    podium(players),
    el('h2', {}, 'Leaderboard'),
    leaderboardTable(players),
    el('h2', { class: 'section-gap' }, 'Questions'),
    el('div', { class: 'stack' }, questionCards(s.questionStats)),
    el('h2', { class: 'section-gap' }, 'Player breakdown'),
    el('div', { class: 'stack' }, playerBreakdown(players, s.questionStats))
  );
}

async function start() {
  showLoading(content);
  try {
    if (!(await requireLogin())) return;
    if (!id && !hwId) throw new Error('No game selected');
    const { session } = await api(source);
    render(session);
  } catch (err) {
    content.replaceChildren(el('div', { class: 'empty' }, el('p', {}, err.message), el('a', { class: 'btn', href: '/dashboard.html' }, 'Back to dashboard')));
  }
}

start();

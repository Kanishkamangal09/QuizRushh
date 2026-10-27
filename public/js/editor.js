import { api, requireLogin } from './api.js';
import { el, toast, showLoading, confirmDialog } from './ui.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const POINTS_LABEL = { standard: 'Standard points', double: 'Double points', none: 'No points' };

const $ = (id) => document.getElementById(id);
const titleIn = $('title');
const descIn = $('description');
const tagsIn = $('tags');
const shuffleQ = $('shuffle-q');
const shuffleO = $('shuffle-o');
const questionsBox = $('questions');
const previewBox = $('preview');
const errorBox = $('error');
const saveBtn = $('save');

let quizId = new URLSearchParams(location.search).get('id');
let quiz;
let saved = '';
let current = 0;
let showErrors = false;

const blankQuestion = () => ({ type: 'mcq', text: '', options: ['', '', '', ''], correctIndex: 0, timeLimitSec: 20, pointsMode: 'standard' });

function fromServer(q) {
  return {
    title: q.title,
    description: q.description,
    tags: q.tags.join(', '),
    settings: { ...q.settings },
    questions: q.questions.map((x) => ({ ...x, options: [...x.options] })),
  };
}

function toPayload() {
  return {
    title: quiz.title.trim(),
    description: quiz.description.trim(),
    tags: quiz.tags.split(',').map((t) => t.trim()).filter(Boolean),
    settings: quiz.settings,
    questions: quiz.questions.map((q) => ({ ...q, text: q.text.trim(), options: q.options.map((o) => o.trim()) })),
  };
}

// same rules as the server schema, so errors show before a round trip
function check() {
  const problems = { top: [], questions: {} };
  const p = toPayload();
  if (!p.title) problems.top.push('Give the quiz a title');
  if (p.description.length > 300) problems.top.push('Description is over 300 characters');
  if (p.tags.length > 5) problems.top.push('Use at most 5 tags');
  if (p.tags.some((t) => t.length > 20)) problems.top.push('Tags are 20 characters max');

  p.questions.forEach((q, i) => {
    const lower = q.options.map((o) => o.toLowerCase());
    let msg = '';
    if (!q.text) msg = 'Write the question text';
    else if (q.text.length > 200) msg = 'Question text is over 200 characters';
    else if (q.options.some((o) => !o)) msg = 'Fill in every option, or remove the empty ones';
    else if (new Set(lower).size !== lower.length) msg = 'Options must be different from each other';
    else if (!Number.isInteger(q.timeLimitSec) || q.timeLimitSec < 5 || q.timeLimitSec > 60) msg = 'Time limit must be 5 to 60 seconds';
    if (msg) problems.questions[i] = msg;
  });
  problems.count = problems.top.length + Object.keys(problems.questions).length;
  return problems;
}

function renderErrors() {
  const problems = showErrors ? check() : { top: [], questions: {} };
  errorBox.textContent = problems.top.join('. ');
  questionsBox.querySelectorAll('.q-card').forEach((card, i) => {
    card.querySelector('.q-error').textContent = problems.questions[i] || '';
  });
}

function renderPreview() {
  const q = quiz.questions[current];
  const answers = q.options.map((text, j) =>
    el(
      'div',
      { class: `answer opt-${j}${j === q.correctIndex ? ' is-correct' : ''}` },
      el('span', { class: 'letter' }, LETTERS[j]),
      el('span', {}, text || `Option ${j + 1}`),
      j === q.correctIndex && el('span', { class: 'tick' }, 'Correct')
    )
  );
  previewBox.replaceChildren(
    el(
      'div',
      { class: 'preview-phone' },
      el(
        'div',
        { class: 'preview-top' },
        el('span', { class: 'badge' }, `${current + 1} / ${quiz.questions.length}`),
        q.pointsMode !== 'standard' && el('span', { class: 'badge' }, POINTS_LABEL[q.pointsMode]),
        el('span', { class: 'timer' }, `${q.timeLimitSec || 0}s`)
      ),
      el('h2', { class: q.text.trim() ? '' : 'placeholder' }, q.text.trim() || 'Your question shows up here'),
      el('div', { class: 'answers' }, answers)
    )
  );
  $('prev-q').disabled = current === 0;
  $('next-q').disabled = current === quiz.questions.length - 1;
}

function changed() {
  renderPreview();
  renderErrors();
  $('dirty').textContent = JSON.stringify(quiz) !== saved ? 'Unsaved changes' : '';
}

function move(i, dir) {
  const j = i + dir;
  [quiz.questions[i], quiz.questions[j]] = [quiz.questions[j], quiz.questions[i]];
  current = j;
  renderQuestions();
  const card = questionsBox.children[j];
  const btn = card.querySelector(dir < 0 ? '.move-up' : '.move-down');
  (btn.disabled ? card.querySelector(dir < 0 ? '.move-down' : '.move-up') : btn).focus();
  changed();
}

function setType(q, type) {
  q.type = type;
  q.options = type === 'tf' ? ['True', 'False'] : ['', '', '', ''];
  q.correctIndex = 0;
}

function questionCard(q, i) {
  const total = quiz.questions.length;

  const optionRows = q.options.map((text, j) =>
    el(
      'div',
      { class: 'opt-row' },
      el('input', {
        type: 'radio',
        name: `correct-${i}`,
        checked: j === q.correctIndex,
        'aria-label': `Mark option ${j + 1} as correct`,
        onchange: () => {
          q.correctIndex = j;
          changed();
        },
      }),
      el('input', {
        type: 'text',
        value: text,
        maxlength: 100,
        readonly: q.type === 'tf',
        placeholder: `Option ${j + 1}`,
        'aria-label': `Option ${j + 1}`,
        oninput: (e) => {
          q.options[j] = e.target.value;
          changed();
        },
      }),
      q.type === 'mcq' &&
        q.options.length > 2 &&
        el(
          'button',
          {
            class: 'btn btn-small btn-danger',
            type: 'button',
            'aria-label': `Remove option ${j + 1}`,
            onclick: () => {
              q.options.splice(j, 1);
              if (q.correctIndex === j) q.correctIndex = 0;
              else if (q.correctIndex > j) q.correctIndex--;
              renderQuestions();
              changed();
            },
          },
          'X'
        )
    )
  );

  const card = el(
    'section',
    { class: 'card q-card', 'aria-label': `Question ${i + 1}` },
    el(
      'div',
      { class: 'row spread' },
      el('h2', {}, `Question ${i + 1}`),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn btn-small move-up', type: 'button', disabled: i === 0, 'aria-label': `Move question ${i + 1} up`, onclick: () => move(i, -1) }, 'Up'),
        el('button', { class: 'btn btn-small move-down', type: 'button', disabled: i === total - 1, 'aria-label': `Move question ${i + 1} down`, onclick: () => move(i, 1) }, 'Down'),
        el(
          'button',
          {
            class: 'btn btn-small btn-danger',
            type: 'button',
            disabled: total === 1,
            'aria-label': `Remove question ${i + 1}`,
            onclick: () => {
              quiz.questions.splice(i, 1);
              current = Math.min(current, quiz.questions.length - 1);
              renderQuestions();
              changed();
            },
          },
          'Remove'
        )
      )
    ),
    el(
      'label',
      { class: 'field' },
      el('span', {}, 'Type'),
      el(
        'select',
        {
          onchange: (e) => {
            setType(q, e.target.value);
            renderQuestions();
            changed();
          },
        },
        el('option', { value: 'mcq', selected: q.type === 'mcq' }, 'Multiple choice'),
        el('option', { value: 'tf', selected: q.type === 'tf' }, 'True / false')
      )
    ),
    el(
      'label',
      { class: 'field' },
      el('span', {}, 'Question'),
      el('textarea', {
        rows: 2,
        maxlength: 200,
        oninput: (e) => {
          q.text = e.target.value;
          changed();
        },
      }, q.text)
    ),
    el('fieldset', {}, el('legend', {}, 'Answers (pick the correct one)'), optionRows),
    q.type === 'mcq' &&
      q.options.length < 4 &&
      el(
        'button',
        {
          class: 'btn btn-small',
          type: 'button',
          onclick: () => {
            q.options.push('');
            renderQuestions();
            changed();
          },
        },
        'Add option'
      ),
    el(
      'div',
      { class: 'two-col' },
      el(
        'label',
        { class: 'field' },
        el('span', {}, 'Time limit (seconds)'),
        el('input', {
          type: 'number',
          min: 5,
          max: 60,
          value: q.timeLimitSec,
          oninput: (e) => {
            q.timeLimitSec = e.target.value === '' ? NaN : Number(e.target.value);
            changed();
          },
        })
      ),
      el(
        'label',
        { class: 'field' },
        el('span', {}, 'Points'),
        el(
          'select',
          {
            onchange: (e) => {
              q.pointsMode = e.target.value;
              changed();
            },
          },
          Object.entries(POINTS_LABEL).map(([value, label]) => el('option', { value, selected: q.pointsMode === value }, label))
        )
      )
    ),
    el('p', { class: 'error-text q-error', role: 'alert' })
  );

  card.addEventListener('focusin', () => {
    if (current !== i) {
      current = i;
      renderPreview();
    }
  });
  return card;
}

function renderQuestions() {
  questionsBox.replaceChildren(...quiz.questions.map(questionCard));
  $('add-q').disabled = quiz.questions.length >= 50;
}

function fillForm() {
  titleIn.value = quiz.title;
  descIn.value = quiz.description;
  tagsIn.value = quiz.tags;
  shuffleQ.checked = quiz.settings.shuffleQuestions;
  shuffleO.checked = quiz.settings.shuffleOptions;
  renderQuestions();
  saved = JSON.stringify(quiz);
  changed();
}

titleIn.addEventListener('input', () => ((quiz.title = titleIn.value), changed()));
descIn.addEventListener('input', () => ((quiz.description = descIn.value), changed()));
tagsIn.addEventListener('input', () => ((quiz.tags = tagsIn.value), changed()));
shuffleQ.addEventListener('change', () => ((quiz.settings.shuffleQuestions = shuffleQ.checked), changed()));
shuffleO.addEventListener('change', () => ((quiz.settings.shuffleOptions = shuffleO.checked), changed()));

$('add-q').addEventListener('click', () => {
  quiz.questions.push(blankQuestion());
  current = quiz.questions.length - 1;
  renderQuestions();
  questionsBox.lastElementChild.querySelector('textarea').focus();
  changed();
});

$('prev-q').addEventListener('click', () => ((current -= 1), renderPreview()));
$('next-q').addEventListener('click', () => ((current += 1), renderPreview()));

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showErrors = true;
  renderErrors();
  if (check().count) {
    toast('Fix the highlighted problems first', 'error');
    return;
  }

  saveBtn.disabled = true;
  try {
    const body = toPayload();
    const res = quizId
      ? await api(`/quizzes/${quizId}`, { method: 'PUT', body })
      : await api('/quizzes', { method: 'POST', body });
    quizId = res.quiz._id;
    history.replaceState(null, '', `?id=${quizId}`);
    $('heading').textContent = 'Edit quiz';
    saved = JSON.stringify(quiz);
    changed();
    toast('Quiz saved');
  } catch (err) {
    errorBox.textContent = err.message;
    toast(err.message, 'error');
  }
  saveBtn.disabled = false;
});

const isDirty = () => JSON.stringify(quiz) !== saved;

window.addEventListener('beforeunload', (e) => {
  if (quiz && isDirty()) e.preventDefault();
});

// in-app links get a nicer prompt than the browser default
for (const link of [$('back'), $('back-link')]) {
  link.addEventListener('click', async (e) => {
    if (!quiz || !isDirty()) return;
    e.preventDefault();
    if (await confirmDialog('You have unsaved changes. Leave without saving?', 'Leave')) {
      saved = JSON.stringify(quiz);
      location.href = '/dashboard.html';
    }
  });
}

async function setupAi() {
  try {
    const { enabled } = await api('/ai/status');
    if (!enabled) return;
  } catch {
    return;
  }
  $('ai-panel').classList.remove('hidden');

  $('ai-go').addEventListener('click', async () => {
    const err = $('ai-error');
    const topic = $('ai-topic').value.trim();
    const count = Number($('ai-count').value);
    err.textContent = '';
    if (topic.length < 3) return (err.textContent = 'Type a topic first');
    if (!Number.isInteger(count) || count < 1 || count > 15) return (err.textContent = 'Pick 1 to 15 questions');

    const hasContent = quiz.title.trim() || quiz.questions.some((q) => q.text.trim());
    if (hasContent && !(await confirmDialog('Replace what you have so far with the AI draft?', 'Replace'))) return;

    const btn = $('ai-go');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    try {
      const { quiz: draft } = await api('/ai/generate', { method: 'POST', body: { topic, difficulty: $('ai-difficulty').value, count } });
      const before = saved;
      quiz = fromServer(draft);
      current = 0;
      fillForm();
      saved = before; // the draft still counts as unsaved
      changed();
      toast('Draft ready. Check the answers, then save.');
    } catch (e) {
      err.textContent = e.message;
    }
    btn.disabled = false;
    btn.textContent = 'Generate draft';
  });
}

async function start() {
  const status = $('status');
  showLoading(status);
  try {
    if (!(await requireLogin())) return;
    if (quizId) {
      const { quiz: q } = await api(`/quizzes/${quizId}`);
      quiz = fromServer(q);
      $('heading').textContent = 'Edit quiz';
    } else {
      quiz = { title: '', description: '', tags: '', settings: { shuffleQuestions: false, shuffleOptions: false }, questions: [blankQuestion()] };
    }
    status.replaceChildren();
    $('editor').classList.remove('hidden');
    fillForm();
    setupAi();
  } catch (err) {
    status.replaceChildren(el('div', { class: 'empty' }, el('p', {}, err.message), el('a', { class: 'btn', href: '/dashboard.html' }, 'Back to quizzes')));
  }
}

start();

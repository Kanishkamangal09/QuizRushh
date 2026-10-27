import { api, requireLogin, logout } from './api.js';
import { el, toast, showLoading, showEmpty, confirmDialog, formatDate, copyText } from './ui.js';

const list = document.getElementById('list');
const search = document.getElementById('search');
const importFile = document.getElementById('import-file');

let latest = 0;

function quizCard(q) {
  const busy = (btn, work) => async () => {
    btn.disabled = true;
    try {
      await work();
    } catch (err) {
      toast(err.message, 'error');
    }
    btn.disabled = false;
  };

  const dupBtn = el('button', { class: 'btn btn-small', type: 'button' }, 'Duplicate');
  dupBtn.addEventListener(
    'click',
    busy(dupBtn, async () => {
      await api(`/quizzes/${q.id}/duplicate`, { method: 'POST' });
      toast('Quiz duplicated');
      await load();
    })
  );

  const delBtn = el('button', { class: 'btn btn-small btn-danger', type: 'button' }, 'Delete');
  delBtn.addEventListener(
    'click',
    busy(delBtn, async () => {
      if (!(await confirmDialog(`Delete "${q.title}"? This can't be undone.`))) return;
      await api(`/quizzes/${q.id}`, { method: 'DELETE' });
      toast('Quiz deleted');
      await load();
    })
  );

  return el(
    'article',
    { class: 'card quiz-card' },
    el('h2', {}, q.title),
    q.description && el('p', { class: 'muted' }, q.description),
    q.tags.length > 0 && el('div', { class: 'tags' }, q.tags.map((t) => el('span', { class: 'badge' }, t))),
    el('p', { class: 'hint' }, `${q.questionCount} question${q.questionCount === 1 ? '' : 's'} · updated ${formatDate(q.updatedAt)}`),
    el(
      'div',
      { class: 'row actions' },
      el('a', { class: 'btn btn-small btn-primary', href: `/host.html?quiz=${q.id}` }, 'Start game'),
      el('button', { class: 'btn btn-small', type: 'button', onclick: () => assignDialog(q) }, 'Homework'),
      el('a', { class: 'btn btn-small', href: `/editor.html?id=${q.id}` }, 'Edit'),
      dupBtn,
      el('a', { class: 'btn btn-small', href: `/api/quizzes/${q.id}/export`, download: '' }, 'Export'),
      delBtn
    )
  );
}

function render(quizzes) {
  if (quizzes.length === 0) {
    showEmpty(list, search.value.trim() ? 'No quizzes match that search.' : 'No quizzes yet. Hit "New quiz" to build your first one.');
    return;
  }
  list.replaceChildren(el('div', { class: 'quiz-grid' }, quizzes.map(quizCard)));
}

async function load({ spinner = false } = {}) {
  const mine = ++latest;
  if (spinner) showLoading(list);
  try {
    const { quizzes } = await api('/quizzes?q=' + encodeURIComponent(search.value.trim()));
    if (mine === latest) render(quizzes);
  } catch (err) {
    if (mine !== latest) return;
    list.replaceChildren(
      el('div', { class: 'empty' }, el('p', {}, err.message), el('button', { class: 'btn', type: 'button', onclick: () => load({ spinner: true }) }, 'Try again'))
    );
  }
}

const sessionsBox = document.getElementById('sessions');

async function loadSessions() {
  showLoading(sessionsBox);
  try {
    const { sessions } = await api('/sessions');
    if (sessions.length === 0) return showEmpty(sessionsBox, 'No games yet. Host one and the results show up here.');
    sessionsBox.replaceChildren(
      el(
        'div',
        { class: 'stack' },
        sessions.map((s) =>
          el(
            'div',
            { class: 'card session-row' },
            el('div', {}, el('strong', {}, s.quizTitle), el('div', { class: 'hint' }, `${formatDate(s.endedAt)} · ${s.playerCount} player${s.playerCount === 1 ? '' : 's'} · ${s.questionCount} question${s.questionCount === 1 ? '' : 's'}`)),
            el('a', { class: 'btn btn-small', href: `/results.html?id=${s.id}` }, 'Results')
          )
        )
      )
    );
  } catch (err) {
    sessionsBox.replaceChildren(el('div', { class: 'empty' }, el('p', {}, err.message), el('button', { class: 'btn', type: 'button', onclick: loadSessions }, 'Try again')));
  }
}

const hwBox = document.getElementById('homework');
const hwLink = (code) => `${location.origin}/homework.html?c=${code}`;

// asks for the options, creates the homework and then shows the link to share
function assignDialog(quiz) {
  const error = el('p', { class: 'error-text', role: 'alert' });
  const deadline = el('input', { type: 'datetime-local', id: 'hw-deadline' });
  const reveal = el('input', { type: 'checkbox', checked: true });
  const board = el('input', { type: 'checkbox', checked: true });
  const create = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create link');
  const dialog = el('dialog', { class: 'dialog', 'aria-label': 'Assign homework' });
  dialog.addEventListener('close', () => dialog.remove());

  const form = el(
    'form',
    { class: 'stack', novalidate: true },
    el('h2', {}, `Homework: ${quiz.title}`),
    el('p', { class: 'hint' }, 'Students answer on their own time. Each question still has its timer.'),
    el('label', { class: 'field' }, el('span', {}, 'Deadline (optional)'), deadline),
    el('label', { class: 'check' }, reveal, 'Show the correct answers when a student finishes'),
    el('label', { class: 'check' }, board, 'Show a class leaderboard'),
    error,
    el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'), create)
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const when = deadline.value ? new Date(deadline.value) : null;
    if (when && when <= new Date()) return (error.textContent = 'Pick a deadline in the future');

    error.textContent = '';
    create.disabled = true;
    try {
      const { assignment } = await api('/homework', {
        method: 'POST',
        body: { quizId: quiz.id, deadline: when ? when.toISOString() : null, revealAnswers: reveal.checked, showLeaderboard: board.checked },
      });
      const link = hwLink(assignment.code);
      dialog.replaceChildren(
        el(
          'div',
          { class: 'stack' },
          el('h2', {}, 'Ready to share'),
          el('p', {}, 'Send this link to your students. They do not need an account.'),
          el('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Homework link', onfocus: (ev) => ev.target.select() }),
          el('div', { class: 'row' }, el('button', { class: 'btn btn-primary', type: 'button', onclick: () => copyText(link) }, 'Copy link'), el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Close'))
        )
      );
      loadHomework();
    } catch (err) {
      error.textContent = err.message;
      create.disabled = false;
    }
  });

  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}

function homeworkRow(h) {
  const status = h.closed ? 'Closed' : h.open ? 'Open' : 'Past due';
  const deadline = h.deadline ? `due ${new Date(h.deadline).toLocaleString()}` : 'no deadline';

  const act = (btn, work) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await work();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });

  const toggle = el('button', { class: 'btn btn-small', type: 'button' }, h.closed ? 'Reopen' : 'Close');
  act(toggle, async () => {
    await api(`/homework/${h.id}`, { method: 'PATCH', body: { closed: !h.closed } });
    await loadHomework();
  });

  const del = el('button', { class: 'btn btn-small btn-danger', type: 'button' }, 'Delete');
  act(del, async () => {
    if (!(await confirmDialog(`Delete this homework and all ${h.attempts} student attempts?`))) {
      del.disabled = false;
      return;
    }
    await api(`/homework/${h.id}`, { method: 'DELETE' });
    toast('Homework deleted');
    await loadHomework();
  });

  return el(
    'div',
    { class: 'card stack' },
    el('div', { class: 'row spread' }, el('strong', {}, h.quizTitle), el('span', { class: 'badge' }, status)),
    el('p', { class: 'hint' }, `${h.finished} of ${h.attempts} finished · ${deadline}`),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(hwLink(h.code)) }, 'Copy link'),
      el('a', { class: 'btn btn-small btn-primary', href: `/results.html?hw=${h.id}` }, 'Results'),
      toggle,
      del
    )
  );
}

async function loadHomework({ spinner = false } = {}) {
  if (spinner) showLoading(hwBox);
  try {
    const { homework } = await api('/homework');
    if (homework.length === 0) return showEmpty(hwBox, 'No homework yet. Use the Homework button on a quiz to share it with students.');
    hwBox.replaceChildren(el('div', { class: 'stack' }, homework.map(homeworkRow)));
  } catch (err) {
    hwBox.replaceChildren(el('div', { class: 'empty' }, el('p', {}, err.message), el('button', { class: 'btn', type: 'button', onclick: () => loadHomework({ spinner: true }) }, 'Try again')));
  }
}

let timer;
search.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});

document.getElementById('import-btn').addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  if (file.size > 200 * 1024) return toast('That file is too big for a quiz', 'error');

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('That file is not valid JSON', 'error');
  }
  try {
    await api('/quizzes/import', { method: 'POST', body: data });
    toast('Quiz imported');
    load();
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'error');
  }
});

document.getElementById('logout').addEventListener('click', () => logout().catch((err) => toast(err.message, 'error')));

try {
  const user = await requireLogin();
  if (user) {
    document.getElementById('who').textContent = user.name;
    load({ spinner: true });
    loadHomework({ spinner: true });
    loadSessions();
  }
} catch (err) {
  list.replaceChildren(el('div', { class: 'empty' }, err.message));
}

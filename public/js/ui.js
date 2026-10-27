import { AVATARS } from './constants.js';

// el('button', { class: 'btn', onclick: fn }, 'Text', otherNode)
// strings always become text nodes, so user text can't inject markup
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function toast(message, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = el('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  box.append(t);
  setTimeout(() => t.remove(), 4000);
}

export function setTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// call once per page, wires the toggle button if the page has one
function initTheme() {
  const saved = localStorage.getItem('qr-theme');
  if (saved) setTheme(saved);

  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const current = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('qr-theme', next);
    setTheme(next);
  });
}

export function showLoading(container) {
  container.replaceChildren(el('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' }));
}

export function showEmpty(container, message) {
  container.replaceChildren(el('div', { class: 'empty' }, message));
}

const LETTERS = ['A', 'B', 'C', 'D'];
export const letter = (i) => LETTERS[i];

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    toast('Could not copy, select the link and copy it by hand', 'error');
  }
}

// countdown that corrects for clock skew: serverNow is the server clock when the payload was sent,
// so offset = how far the server is ahead of this device
export function makeCountdown() {
  const num = el('span', { class: 'count-num' }, '0');
  const fill = el('div', { class: 'count-fill' });
  const box = el('div', { class: 'countdown' }, num, el('div', { class: 'count-bar', 'aria-hidden': 'true' }, fill));
  let timer;
  let totalMs = 1;

  const show = (leftMs) => {
    num.textContent = Math.ceil(leftMs / 1000);
    fill.style.width = `${Math.min(100, (leftMs / totalMs) * 100)}%`;
  };

  return {
    box,
    run(endsAt, serverNow, total) {
      clearInterval(timer);
      totalMs = total;
      const offset = serverNow - Date.now();
      const tick = () => {
        const left = Math.max(0, endsAt - (Date.now() + offset));
        show(left);
        if (left === 0) clearInterval(timer);
      };
      tick();
      timer = setInterval(tick, 100);
    },
    freeze(leftMs, total) {
      clearInterval(timer);
      totalMs = total;
      show(leftMs);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// entries from a reveal carry a rank change, final boards don't
export function leaderboardList(entries, meId) {
  if (entries.length === 0) return el('p', { class: 'empty' }, 'No players yet');

  const move = (change) => {
    if (change > 0) return el('span', { class: 'move up' }, `▲${change}`, el('span', { class: 'sr-only' }, ' places up'));
    if (change < 0) return el('span', { class: 'move down' }, `▼${-change}`, el('span', { class: 'sr-only' }, ' places down'));
    return el('span', { class: 'move' }, '–', el('span', { class: 'sr-only' }, ' no change'));
  };

  return el(
    'ol',
    { class: 'board' },
    entries.map((e) =>
      el(
        'li',
        { class: `board-row${e.id === meId ? ' me' : ''}` },
        el('span', { class: 'rank' }, e.rank),
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, e.avatar),
        el('span', { class: 'name' }, e.nickname, e.connected === false && el('small', {}, ' (away)')),
        e.change !== undefined && move(e.change),
        el('span', { class: 'pts' }, e.score.toLocaleString())
      )
    )
  );
}

export function distributionBars(options, counts, correctIndex) {
  const max = Math.max(1, ...counts);
  return el(
    'div',
    { class: 'dist' },
    options.map((text, i) => {
      const fill = el('div', { class: `dist-fill opt-${i}` });
      fill.style.width = `${(counts[i] / max) * 100}%`;
      return el(
        'div',
        { class: `dist-row${i === correctIndex ? ' is-correct' : ''}` },
        el('span', { class: 'dist-label' }, `${LETTERS[i]}. ${text}`, i === correctIndex && el('strong', {}, ' (correct)')),
        el('div', { class: 'dist-track' }, fill),
        el('span', { class: 'dist-count' }, counts[i])
      );
    })
  );
}

export function avatarPicker(box) {
  AVATARS.forEach((avatar, i) => {
    box.append(
      el(
        'label',
        { class: 'avatar-pick' },
        el('input', { class: 'sr-only', type: 'radio', name: 'avatar', value: avatar, checked: i === 0 }),
        el('span', {}, avatar)
      )
    );
  });
}

// native dialog gives focus trapping and Esc for free
export function confirmDialog(message, okText = 'Delete') {
  return new Promise((resolve) => {
    const dialog = el(
      'dialog',
      { class: 'dialog', 'aria-label': 'Please confirm' },
      el('p', { class: 'dialog-text' }, message),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn', type: 'button', onclick: () => dialog.close('no') }, 'Cancel'),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => dialog.close('yes') }, okText)
      )
    );
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'yes');
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

initTheme();

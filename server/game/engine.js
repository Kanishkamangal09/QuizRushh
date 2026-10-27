import { randomUUID } from 'node:crypto';
import { STATES } from '../../public/js/constants.js';
import { scoreAnswer } from './scoring.js';
import { computeAchievements } from './achievements.js';
import { isClean } from './profanity.js';

// answers sent right at the buzzer can land a bit late because of network lag
export const GRACE_MS = 300;

const { LOBBY, QUESTION, REVEAL, FINISHED } = STATES;

const allowed = {
  [LOBBY]: [QUESTION, FINISHED],
  [QUESTION]: [REVEAL, FINISHED],
  [REVEAL]: [QUESTION, FINISHED],
  [FINISHED]: [],
};

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shuffleOptions(q) {
  const order = shuffle(q.options.map((_, i) => i));
  return { ...q, options: order.map((i) => q.options[i]), correctIndex: order.indexOf(q.correctIndex) };
}

// shuffling happens once per game, so every player sees the same order
function prepareQuestions(quiz) {
  let list = quiz.questions.map((q) => ({
    type: q.type,
    text: q.text,
    options: [...q.options],
    correctIndex: q.correctIndex,
    timeLimitSec: q.timeLimitSec,
    pointsMode: q.pointsMode,
  }));
  if (quiz.settings?.shuffleOptions) list = list.map((q) => (q.type === 'tf' ? q : shuffleOptions(q)));
  if (quiz.settings?.shuffleQuestions) list = shuffle(list);
  return list;
}

export function createGame({ quiz, hostUserId, code, maxPlayers = 100, onTimeUp = () => {} }, now = Date.now()) {
  return {
    code,
    hostUserId,
    hostSocketId: null,
    hostTimer: null,
    quizId: quiz._id ?? null,
    quizTitle: quiz.title,
    settings: {
      shuffleQuestions: !!quiz.settings?.shuffleQuestions,
      shuffleOptions: !!quiz.settings?.shuffleOptions,
    },
    questions: prepareQuestions(quiz),
    maxPlayers,
    onTimeUp,
    state: LOBBY,
    locked: false,
    paused: false,
    players: new Map(),
    nextPlayerNo: 1,
    index: -1,
    q: null,
    stats: [],
    prevRanks: new Map(),
    lastReveal: null,
    sessionId: null,
    finishReason: null,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    lastActivity: now,
  };
}

function go(game, to) {
  if (!allowed[game.state].includes(to)) return false;
  game.state = to;
  return true;
}

const touch = (game, now) => {
  game.lastActivity = now;
};

// ---------- players ----------

export function addPlayer(game, { nickname, avatar }, now = Date.now()) {
  if (game.state !== LOBBY) return { error: 'This game has already started' };
  if (game.locked) return { error: 'The lobby is locked' };
  if (game.players.size >= game.maxPlayers) return { error: 'This game is full' };

  const name = nickname.trim();
  if (!isClean(name)) return { error: 'Pick a different nickname' };
  const taken = [...game.players.values()].some((p) => p.nickname.toLowerCase() === name.toLowerCase());
  if (taken) return { error: 'That nickname is taken' };

  const player = {
    id: `p${game.nextPlayerNo++}`,
    token: randomUUID(), // secret, only the player's own browser knows it
    nickname: name,
    avatar,
    socketId: null,
    connected: true,
    score: 0,
    streak: 0,
    longestStreak: 0,
    correct: 0,
    fastestCorrectMs: null,
    rankHistory: [],
    answers: [],
    lastResult: null,
  };
  game.players.set(player.id, player);
  touch(game, now);
  return { player };
}

export function findByToken(game, token) {
  return [...game.players.values()].find((p) => p.token === token) ?? null;
}

export function removePlayer(game, playerId, now = Date.now()) {
  touch(game, now);
  game.prevRanks.delete(playerId);
  return game.players.delete(playerId);
}

export function setLocked(game, locked) {
  game.locked = locked;
}

// ---------- questions ----------

function arm(game, ms) {
  clearTimeout(game.q.timer);
  const index = game.index;
  game.q.timer = setTimeout(() => {
    // guard against a timer firing after the question already moved on
    if (game.state === QUESTION && game.index === index && !game.paused) game.onTimeUp(game);
  }, ms);
  game.q.timer.unref();
}

function startQuestion(game, now) {
  const limitMs = game.questions[game.index].timeLimitSec * 1000;
  game.q = { startedAt: now, endsAt: now + limitMs, limitMs, answers: new Map(), timer: null, pausedAt: null, remainingMs: 0 };
  game.paused = false;
  arm(game, limitMs + GRACE_MS);
}

export function startGame(game, now = Date.now()) {
  if (game.state !== LOBBY) return { error: 'The game has already started' };
  if (game.players.size === 0) return { error: 'Wait for at least one player' };
  go(game, QUESTION);
  game.index = 0;
  game.startedAt = now;
  startQuestion(game, now);
  touch(game, now);
  return { ok: true };
}

export const hasNext = (game) => game.index + 1 < game.questions.length;

export function nextQuestion(game, now = Date.now()) {
  if (game.state !== REVEAL) return { error: 'The current question is not finished' };
  if (!hasNext(game)) return { error: 'No more questions' };
  go(game, QUESTION);
  game.index++;
  startQuestion(game, now);
  touch(game, now);
  return { ok: true };
}

export function questionPayload(game, now = Date.now()) {
  const q = game.questions[game.index];
  // correctIndex is left out on purpose, it only goes out at reveal
  return {
    index: game.index,
    total: game.questions.length,
    type: q.type,
    text: q.text,
    options: q.options,
    timeLimitSec: q.timeLimitSec,
    pointsMode: q.pointsMode,
    endsAt: game.q.endsAt,
    serverNow: now,
  };
}

export function connectedPlayers(game) {
  return [...game.players.values()].filter((p) => p.connected);
}

export function progress(game) {
  const connected = connectedPlayers(game);
  const answered = connected.filter((p) => game.q?.answers.has(p.id)).length;
  return { answered, total: connected.length };
}

// disconnected players don't hold the question open
export function everyoneAnswered(game) {
  const { answered, total } = progress(game);
  return total > 0 && answered === total;
}

export function submitAnswer(game, playerId, choice, now = Date.now()) {
  const player = game.players.get(playerId);
  if (!player) return { ok: false, reason: 'You are not in this game' };
  if (game.state !== QUESTION || game.paused) return { ok: false, reason: 'No question is open right now' };
  if (now > game.q.endsAt + GRACE_MS) return { ok: false, reason: 'Too late' };

  const q = game.questions[game.index];
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return { ok: false, reason: 'Invalid answer' };
  if (game.q.answers.has(playerId)) return { ok: false, reason: 'Already answered' };

  game.q.answers.set(playerId, { choice, timeMs: now - game.q.startedAt });
  touch(game, now);
  return { ok: true, allAnswered: everyoneAnswered(game) };
}

export function pauseGame(game, now = Date.now()) {
  if (game.state !== QUESTION || game.paused) return { error: 'Nothing to pause' };
  clearTimeout(game.q.timer);
  game.paused = true;
  game.q.pausedAt = now;
  game.q.remainingMs = Math.max(0, game.q.endsAt - now);
  touch(game, now);
  return { ok: true, remainingMs: game.q.remainingMs };
}

// startedAt moves forward by the paused time too, so elapsed time ignores the pause
export function resumeGame(game, now = Date.now()) {
  if (game.state !== QUESTION || !game.paused) return { error: 'The game is not paused' };
  game.q.startedAt += now - game.q.pausedAt;
  game.q.endsAt = now + game.q.remainingMs;
  game.paused = false;
  arm(game, game.q.remainingMs + GRACE_MS);
  touch(game, now);
  return { ok: true, endsAt: game.q.endsAt };
}

// ---------- leaderboard ----------

// highest score first, ties share a rank (1, 1, 3) and are listed by nickname
export function leaderboard(game) {
  const sorted = [...game.players.values()].sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
  let rank = 0;
  return sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score) rank = i + 1;
    return { id: p.id, nickname: p.nickname, avatar: p.avatar, score: p.score, rank, connected: p.connected };
  });
}

// ---------- reveal ----------

export function endQuestion(game, now = Date.now()) {
  if (game.state !== QUESTION) return null;
  clearTimeout(game.q.timer);
  go(game, REVEAL);
  game.paused = false;

  const q = game.questions[game.index];
  const distribution = q.options.map(() => 0);
  let correctCount = 0;
  let totalAnswers = 0;
  let timeSum = 0;

  for (const p of game.players.values()) {
    const a = game.q.answers.get(p.id);
    if (!a) {
      // a no-points question never touches streaks
      if (q.pointsMode !== 'none') p.streak = 0;
      p.answers.push({ questionIndex: game.index, choice: -1, correct: false, points: 0, timeMs: null });
      continue;
    }

    const correct = a.choice === q.correctIndex;
    const timeMs = Math.min(Math.max(a.timeMs, 0), game.q.limitMs);
    const points = scoreAnswer({ correct, elapsedMs: timeMs, timeLimitMs: game.q.limitMs, pointsMode: q.pointsMode, streakBefore: p.streak });

    if (q.pointsMode !== 'none') p.streak = correct ? p.streak + 1 : 0;
    p.longestStreak = Math.max(p.longestStreak, p.streak);
    p.score += points;
    if (correct) {
      p.correct++;
      correctCount++;
      if (p.fastestCorrectMs === null || timeMs < p.fastestCorrectMs) p.fastestCorrectMs = timeMs;
    }
    distribution[a.choice]++;
    totalAnswers++;
    timeSum += timeMs;
    p.answers.push({ questionIndex: game.index, choice: a.choice, correct, points, timeMs });
  }

  game.stats.push({
    questionIndex: game.index,
    text: q.text,
    type: q.type,
    timeLimitSec: q.timeLimitSec,
    pointsMode: q.pointsMode,
    options: q.options,
    correctIndex: q.correctIndex,
    correctCount,
    totalAnswers,
    avgTimeMs: totalAnswers ? Math.round(timeSum / totalAnswers) : 0,
    distribution,
  });

  const board = leaderboard(game);
  const results = new Map();
  const withChange = board.map((entry) => {
    const prev = game.prevRanks.get(entry.id);
    const p = game.players.get(entry.id);
    p.rankHistory.push(entry.rank);
    const last = p.answers[p.answers.length - 1];
    results.set(entry.id, {
      index: game.index,
      answered: last.choice >= 0,
      choice: last.choice,
      correct: last.correct,
      points: last.points,
      streak: p.streak,
      score: p.score,
      rank: entry.rank,
      correctIndex: q.correctIndex,
    });
    p.lastResult = results.get(entry.id);
    return { ...entry, change: prev ? prev - entry.rank : 0 }; // positive = moved up
  });
  game.prevRanks = new Map(board.map((e) => [e.id, e.rank]));

  game.lastReveal = {
    index: game.index,
    total: game.questions.length,
    correctIndex: q.correctIndex,
    distribution,
    leaderboard: withChange.slice(0, 10),
    isLast: !hasNext(game),
  };
  touch(game, now);
  return { reveal: game.lastReveal, results };
}

// ---------- finish ----------

export function finishGame(game, reason, now = Date.now()) {
  if (!go(game, FINISHED)) return false;
  clearTimeout(game.q?.timer);
  clearTimeout(game.hostTimer);
  game.paused = false;
  game.endedAt = now;
  game.finishReason = reason;
  touch(game, now);
  return true;
}

export function summaryFor(game, playerId) {
  const p = game.players.get(playerId);
  const entry = leaderboard(game).find((e) => e.id === playerId);
  const totalQuestions = game.stats.length;
  const summary = {
    rank: entry.rank,
    score: p.score,
    correct: p.correct,
    totalQuestions,
    accuracy: totalQuestions ? Math.round((p.correct / totalQuestions) * 100) : 0,
    longestStreak: p.longestStreak,
    fastestCorrectMs: p.fastestCorrectMs,
    rankHistory: p.rankHistory,
  };
  return { ...summary, achievements: computeAchievements(summary) };
}

export function sessionData(game) {
  const board = leaderboard(game);
  return {
    quiz: game.quizId,
    quizTitle: game.quizTitle,
    host: game.hostUserId,
    code: game.code,
    startedAt: new Date(game.startedAt),
    endedAt: new Date(game.endedAt),
    settings: game.settings,
    players: board.map((e) => {
      const p = game.players.get(e.id);
      const s = summaryFor(game, e.id);
      return {
        nickname: p.nickname,
        avatar: p.avatar,
        score: p.score,
        rank: s.rank,
        accuracy: s.accuracy,
        longestStreak: p.longestStreak,
        fastestCorrectMs: p.fastestCorrectMs,
        achievements: s.achievements,
        answers: p.answers,
      };
    }),
    questionStats: game.stats,
  };
}

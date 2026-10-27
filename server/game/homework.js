import { scoreAnswer } from './scoring.js';
import { computeAchievements } from './achievements.js';
import { GRACE_MS } from './engine.js';

// no I, O, 0 or 1 so codes are easy to read out loud
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-HJ-NP-Z2-9]{7}$/;

export function makeCode() {
  let code = '';
  for (let i = 0; i < 7; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}

export const isOpen = (assignment, now = Date.now()) =>
  !assignment.closed && (!assignment.deadline || new Date(assignment.deadline).getTime() > now);

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// each student gets their own order. opts[shownIndex] = original option index
export function buildPlan(questions, settings = {}) {
  let order = questions.map((_, i) => i);
  if (settings.shuffleQuestions) order = shuffle(order);
  return order.map((q) => {
    let opts = questions[q].options.map((_, i) => i);
    if (settings.shuffleOptions && questions[q].type !== 'tf') opts = shuffle(opts);
    return { q, opts };
  });
}

export function currentStep(assignment, attempt) {
  const step = attempt.plan[attempt.answers.length];
  return step ? { step, q: assignment.questions[step.q] } : null;
}

const startedAtOf = (attempt) => new Date(attempt.current.startedAt).getTime();

// what the student sees, never includes the correct answer
export function questionView(assignment, attempt, now = Date.now()) {
  const { step, q } = currentStep(assignment, attempt);
  return {
    index: attempt.answers.length,
    total: attempt.plan.length,
    type: q.type,
    text: q.text,
    options: step.opts.map((i) => q.options[i]),
    timeLimitSec: q.timeLimitSec,
    pointsMode: q.pointsMode,
    endsAt: startedAtOf(attempt) + q.timeLimitSec * 1000,
    serverNow: now,
  };
}

export function isExpired(assignment, attempt, now = Date.now()) {
  if (!attempt.current) return false;
  const { q } = currentStep(assignment, attempt);
  return now > startedAtOf(attempt) + q.timeLimitSec * 1000 + GRACE_MS;
}

// choice -1 means no answer (time ran out). returns the new totals, the caller saves them
export function resolveCurrent(assignment, attempt, choice, now = Date.now()) {
  const { step, q } = currentStep(assignment, attempt);
  const limitMs = q.timeLimitSec * 1000;
  const timeMs = Math.min(Math.max(now - startedAtOf(attempt), 0), limitMs);
  const answered = choice >= 0;
  const optionIndex = answered ? step.opts[choice] : -1;
  const correct = answered && optionIndex === q.correctIndex;
  const points = answered
    ? scoreAnswer({ correct, elapsedMs: timeMs, timeLimitMs: limitMs, pointsMode: q.pointsMode, streakBefore: attempt.streak })
    : 0;

  // same streak rule as live games: no points questions leave it alone
  let streak = attempt.streak;
  if (q.pointsMode !== 'none') streak = correct ? streak + 1 : 0;

  let fastest = attempt.fastestCorrectMs ?? null;
  if (correct && (fastest === null || timeMs < fastest)) fastest = timeMs;

  return {
    answer: { questionIndex: step.q, choice, optionIndex, correct, points, timeMs: answered ? timeMs : null },
    score: attempt.score + points,
    streak,
    longestStreak: Math.max(attempt.longestStreak, streak),
    correct: attempt.correct + (correct ? 1 : 0),
    fastestCorrectMs: fastest,
    finished: attempt.answers.length + 1 === attempt.plan.length,
  };
}

// highest score first, ties share a rank, same as the live leaderboard
export function rankAttempts(items) {
  const sorted = [...items].sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
  let rank = 0;
  return sorted.map((item, i) => {
    if (i === 0 || item.score !== sorted[i - 1].score) rank = i + 1;
    return { ...item, rank };
  });
}

export function summarize(attempt) {
  const total = attempt.plan.length;
  const answered = attempt.answers.length;
  const finished = Boolean(attempt.finishedAt);
  return {
    finished,
    answered,
    total,
    accuracy: answered ? Math.round((attempt.correct / answered) * 100) : 0,
    achievements: finished
      ? computeAchievements({
          rank: 0,
          correct: attempt.correct,
          totalQuestions: total,
          longestStreak: attempt.longestStreak,
          fastestCorrectMs: attempt.fastestCorrectMs,
          rankHistory: [], // rank over time isn't tracked here, so no Comeback Kid
        })
      : [],
  };
}

// same shape as a saved live game, so the results page and csv export work for both
export function buildResults(assignment, attempts) {
  const players = rankAttempts(
    attempts.map((a) => {
      const s = summarize(a);
      return {
        nickname: a.nickname,
        avatar: a.avatar,
        score: a.score,
        accuracy: s.accuracy,
        longestStreak: a.longestStreak,
        fastestCorrectMs: a.fastestCorrectMs,
        achievements: s.achievements,
        finished: s.finished,
        answered: s.answered,
        answers: a.answers.map((x) => ({ questionIndex: x.questionIndex, choice: x.optionIndex, correct: x.correct, points: x.points, timeMs: x.timeMs })),
      };
    })
  );

  const questionStats = assignment.questions.map((q, i) => {
    const distribution = q.options.map(() => 0);
    let correctCount = 0;
    let totalAnswers = 0;
    let timeSum = 0;
    for (const a of attempts) {
      for (const x of a.answers) {
        if (x.questionIndex !== i || x.optionIndex < 0) continue;
        distribution[x.optionIndex]++;
        totalAnswers++;
        timeSum += x.timeMs;
        if (x.correct) correctCount++;
      }
    }
    return {
      questionIndex: i,
      text: q.text,
      type: q.type,
      options: q.options,
      correctIndex: q.correctIndex,
      timeLimitSec: q.timeLimitSec,
      pointsMode: q.pointsMode,
      correctCount,
      totalAnswers,
      avgTimeMs: totalAnswers ? Math.round(timeSum / totalAnswers) : 0,
      distribution,
    };
  });

  return { players, questionStats };
}

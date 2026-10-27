import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import Assignment from '../models/Assignment.js';
import Attempt from '../models/Attempt.js';
import { validate } from '../middleware/validate.js';
import { hwLimiter, hwJoinLimiter } from '../middleware/rateLimits.js';
import { AVATARS, NICK_MIN, NICK_MAX } from '../../public/js/constants.js';
import { isClean } from '../game/profanity.js';
import * as hw from '../game/homework.js';

// student side of homework. no login, a secret token from join identifies the attempt
const router = Router();
router.use(hwLimiter);

const MAX_ATTEMPTS = 500;
const hash = (token) => createHash('sha256').update(token).digest('hex');

const joinSchema = z.object({
  nickname: z.string().trim().min(NICK_MIN, `Nickname needs at least ${NICK_MIN} characters`).max(NICK_MAX, `Nickname is ${NICK_MAX} characters max`),
  avatar: z.enum(AVATARS, 'Pick an avatar'),
});
const answerSchema = z.object({ choice: z.number().int().min(0).max(3) });

router.param('code', async (req, res, next, raw) => {
  const code = raw.toUpperCase();
  const assignment = hw.CODE_RE.test(code) ? await Assignment.findOne({ code }) : null;
  if (!assignment) return res.status(404).json({ error: 'Homework not found' });
  req.assignment = assignment;
  next();
});

async function loadAttempt(req, res, next) {
  const token = req.get('x-attempt-token');
  const attempt = token && token.length <= 64 ? await Attempt.findOne({ assignment: req.assignment._id, tokenHash: hash(token) }) : null;
  if (!attempt) return res.status(401).json({ error: 'Join this homework first' });
  req.attempt = attempt;
  next();
}

// saves an answer (or a timeout). the filter makes sure only one request can resolve a question
function applyResolution(attempt, r, now) {
  return Attempt.findOneAndUpdate(
    { _id: attempt._id, 'current.startedAt': attempt.current.startedAt, finishedAt: null },
    {
      $push: { answers: r.answer },
      $set: {
        current: null,
        score: r.score,
        streak: r.streak,
        longestStreak: r.longestStreak,
        correct: r.correct,
        fastestCorrectMs: r.fastestCorrectMs,
        ...(r.finished && { finishedAt: new Date(now) }),
      },
    },
    { returnDocument: 'after' }
  );
}

// a question nobody answered in time counts as unanswered, found out lazily on the next request
async function settle(assignment, attempt, now) {
  if (!hw.isExpired(assignment, attempt, now)) return attempt;
  const updated = await applyResolution(attempt, hw.resolveCurrent(assignment, attempt, -1, now), now);
  return updated ?? (await Attempt.findById(attempt._id));
}

async function finalFor(a, attempt) {
  const summary = hw.summarize(attempt);
  const out = {
    score: attempt.score,
    correct: attempt.correct,
    totalQuestions: summary.total,
    accuracy: summary.accuracy,
    longestStreak: attempt.longestStreak,
    fastestCorrectMs: attempt.fastestCorrectMs,
    achievements: summary.achievements,
    rank: null,
    leaderboard: [],
    review: null,
  };

  if (a.showLeaderboard) {
    const done = await Attempt.find({ assignment: a._id, finishedAt: { $ne: null } }).select('nickname avatar score');
    const ranked = hw.rankAttempts(done.map((d) => ({ id: String(d._id), nickname: d.nickname, avatar: d.avatar, score: d.score })));
    out.rank = ranked.find((r) => r.id === String(attempt._id))?.rank ?? null;
    out.leaderboard = ranked.slice(0, 10);
    out.me = String(attempt._id);
  }

  if (a.revealAnswers) {
    out.review = attempt.plan.map((step, i) => {
      const q = a.questions[step.q];
      return {
        text: q.text,
        options: step.opts.map((o) => q.options[o]),
        choice: attempt.answers[i].choice,
        correctIndex: step.opts.indexOf(q.correctIndex),
      };
    });
  }
  return out;
}

async function stateFor(a, attempt, now) {
  const base = {
    title: a.quizTitle,
    nickname: attempt.nickname,
    avatar: attempt.avatar,
    total: attempt.plan.length,
    answered: attempt.answers.length,
    score: attempt.score,
    streak: attempt.streak,
    deadline: a.deadline,
  };

  if (attempt.finishedAt) return { ...base, phase: 'done', final: await finalFor(a, attempt) };
  if (!hw.isOpen(a, now)) return { ...base, phase: 'closed' };
  if (attempt.current) return { ...base, phase: 'question', question: hw.questionView(a, attempt, now) };

  let last = null;
  if (attempt.answers.length > 0) {
    const i = attempt.answers.length - 1;
    const ans = attempt.answers[i];
    const step = attempt.plan[i];
    const q = a.questions[step.q];
    last = {
      answered: ans.choice >= 0,
      correct: ans.correct,
      points: ans.points,
      correctIndex: a.revealAnswers ? step.opts.indexOf(q.correctIndex) : null,
      correctText: a.revealAnswers ? q.options[q.correctIndex] : null,
    };
  }
  return { ...base, phase: 'ready', last };
}

router.get('/:code', hwJoinLimiter, (req, res) => {
  const a = req.assignment;
  res.json({
    title: a.quizTitle,
    description: a.description,
    questionCount: a.questions.length,
    deadline: a.deadline,
    open: hw.isOpen(a),
  });
});

router.post('/:code/join', hwJoinLimiter, validate(joinSchema), async (req, res) => {
  const a = req.assignment;
  if (!hw.isOpen(a)) return res.status(403).json({ error: 'This homework is closed' });
  if (!isClean(req.body.nickname)) return res.status(400).json({ error: 'Pick a different nickname' });
  if ((await Attempt.countDocuments({ assignment: a._id })) >= MAX_ATTEMPTS) {
    return res.status(403).json({ error: 'This homework is full' });
  }

  // checked up front because the unique index may still be building right after startup.
  // the index stays as the backstop for two students joining with the same name at once
  const nicknameKey = req.body.nickname.toLowerCase();
  if (await Attempt.exists({ assignment: a._id, nicknameKey })) return res.status(409).json({ error: 'That nickname is taken' });

  const token = randomUUID();
  let attempt;
  try {
    attempt = await Attempt.create({
      assignment: a._id,
      tokenHash: hash(token),
      nickname: req.body.nickname,
      nicknameKey,
      avatar: req.body.avatar,
      plan: hw.buildPlan(a.questions, a.settings),
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'That nickname is taken' });
    throw err;
  }
  res.status(201).json({ token, state: await stateFor(a, attempt, Date.now()) });
});

router.get('/:code/state', loadAttempt, async (req, res) => {
  const now = Date.now();
  const attempt = await settle(req.assignment, req.attempt, now);
  res.json({ state: await stateFor(req.assignment, attempt, now) });
});

router.post('/:code/next', loadAttempt, async (req, res) => {
  const now = Date.now();
  const a = req.assignment;
  if (!hw.isOpen(a, now)) return res.status(403).json({ error: 'This homework is closed' });

  let attempt = await settle(a, req.attempt, now);
  if (!attempt.finishedAt && !attempt.current) {
    const started = await Attempt.findOneAndUpdate(
      { _id: attempt._id, current: null, finishedAt: null },
      { $set: { current: { startedAt: new Date(now) } } },
      { returnDocument: 'after' }
    );
    attempt = started ?? (await Attempt.findById(attempt._id));
  }
  res.json({ state: await stateFor(a, attempt, now) });
});

router.post('/:code/answer', loadAttempt, validate(answerSchema), async (req, res) => {
  const now = Date.now();
  const a = req.assignment;
  if (!hw.isOpen(a, now)) return res.status(403).json({ error: 'This homework is closed' });

  const attempt = await settle(a, req.attempt, now);
  if (!attempt.current) return res.status(409).json({ error: 'Too late, that question timed out' });

  const { step } = hw.currentStep(a, attempt);
  if (req.body.choice >= step.opts.length) return res.status(400).json({ error: 'Invalid answer' });

  const updated = await applyResolution(attempt, hw.resolveCurrent(a, attempt, req.body.choice, now), now);
  if (!updated) return res.status(409).json({ error: 'Already answered' });
  res.json({ state: await stateFor(a, updated, now) });
});

export default router;

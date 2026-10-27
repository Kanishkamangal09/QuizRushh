import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import Assignment from '../models/Assignment.js';
import Attempt from '../models/Attempt.js';
import Quiz from '../models/Quiz.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as hw from '../game/homework.js';
import { sessionToCsv } from '../services/exportCsv.js';
import { buildRevisionQuiz } from '../services/revision.js';

// teacher side of homework
const router = Router();
router.use(requireAuth);

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const createSchema = z.object({
  quizId: z.string().regex(/^[a-f0-9]{24}$/i, 'Pick a quiz'),
  deadline: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional()
    .refine((d) => !d || new Date(d) > new Date(), 'The deadline has to be in the future')
    .refine((d) => !d || new Date(d) < new Date(Date.now() + YEAR_MS), 'The deadline is too far away'),
  revealAnswers: z.boolean().default(true),
  showLeaderboard: z.boolean().default(true),
});

const patchSchema = z.object({ closed: z.boolean() });

router.param('id', async (req, res, next, id) => {
  const assignment = mongoose.isValidObjectId(id) ? await Assignment.findById(id) : null;
  if (!assignment || String(assignment.owner) !== req.userId) {
    return res.status(404).json({ error: 'Homework not found' });
  }
  req.assignment = assignment;
  next();
});

async function resultsFor(a) {
  const attempts = (await Attempt.find({ assignment: a._id })).map((x) => x.toObject());
  const { players, questionStats } = hw.buildResults(a.toObject(), attempts);
  return {
    _id: a._id,
    kind: 'homework',
    code: a.code,
    quizTitle: a.quizTitle,
    startedAt: a.createdAt,
    endedAt: a.deadline ?? new Date(),
    deadline: a.deadline,
    closed: a.closed,
    players,
    questionStats,
  };
}

router.post('/', validate(createSchema), async (req, res) => {
  const quiz = mongoose.isValidObjectId(req.body.quizId) ? await Quiz.findById(req.body.quizId).lean() : null;
  if (!quiz || String(quiz.owner) !== req.userId) return res.status(404).json({ error: 'Quiz not found' });

  const data = {
    owner: req.userId,
    quiz: quiz._id,
    quizTitle: quiz.title,
    description: quiz.description,
    questions: quiz.questions,
    settings: quiz.settings,
    deadline: req.body.deadline ? new Date(req.body.deadline) : null,
    revealAnswers: req.body.revealAnswers,
    showLeaderboard: req.body.showLeaderboard,
  };

  // codes are random, so a clash is very unlikely, retry a few times anyway
  for (let tries = 0; tries < 5; tries++) {
    try {
      const assignment = await Assignment.create({ ...data, code: hw.makeCode() });
      return res.status(201).json({ assignment: { id: assignment._id, code: assignment.code } });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  res.status(500).json({ error: 'Could not create a homework code, try again' });
});

router.get('/', async (req, res) => {
  const list = await Assignment.find({ owner: req.userId }).sort({ createdAt: -1 }).limit(100);
  const counts = await Attempt.aggregate([
    { $match: { assignment: { $in: list.map((a) => a._id) } } },
    { $group: { _id: '$assignment', total: { $sum: 1 }, finished: { $sum: { $cond: [{ $ne: ['$finishedAt', null] }, 1, 0] } } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c]));

  res.json({
    homework: list.map((a) => ({
      id: a._id,
      code: a.code,
      quizTitle: a.quizTitle,
      deadline: a.deadline,
      closed: a.closed,
      open: hw.isOpen(a),
      createdAt: a.createdAt,
      attempts: byId.get(String(a._id))?.total ?? 0,
      finished: byId.get(String(a._id))?.finished ?? 0,
    })),
  });
});

router.get('/:id', async (req, res) => {
  res.json({ session: await resultsFor(req.assignment) });
});

router.patch('/:id', validate(patchSchema), async (req, res) => {
  req.assignment.closed = req.body.closed;
  await req.assignment.save();
  res.json({ ok: true, closed: req.assignment.closed });
});

router.delete('/:id', async (req, res) => {
  await Attempt.deleteMany({ assignment: req.assignment._id });
  await req.assignment.deleteOne();
  res.json({ ok: true });
});

router.get('/:id/export', async (req, res) => {
  const results = await resultsFor(req.assignment);
  const name = results.quizTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') || 'homework';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-homework.csv"`);
  res.send(sessionToCsv(results));
});

router.post('/:id/revision', async (req, res) => {
  const results = await resultsFor(req.assignment);
  const out = buildRevisionQuiz(results.quizTitle, results.questionStats);
  if (out.error) return res.status(400).json({ error: out.error });
  const quiz = await Quiz.create({ ...out.quiz, owner: req.userId });
  res.status(201).json({ quiz });
});

export default router;

import { Router } from 'express';
import mongoose from 'mongoose';
import Quiz, { quizSchema } from '../models/Quiz.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();
router.use(requireAuth);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const summary = (q) => ({
  id: q._id,
  title: q.title,
  description: q.description,
  tags: q.tags,
  questionCount: q.questions.length,
  updatedAt: q.updatedAt,
});

// loads the quiz and checks the owner, 404 for both missing and someone else's
router.param('id', async (req, res, next, id) => {
  const quiz = mongoose.isValidObjectId(id) ? await Quiz.findById(id) : null;
  if (!quiz || String(quiz.owner) !== req.userId) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  req.quiz = quiz;
  next();
});

router.get('/', async (req, res) => {
  const filter = { owner: req.userId };
  const q = String(req.query.q || '').trim().slice(0, 50);
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ title: re }, { tags: re }];
  }
  const quizzes = await Quiz.find(filter).sort({ updatedAt: -1 }).limit(200);
  res.json({ quizzes: quizzes.map(summary) });
});

router.post('/', validate(quizSchema), async (req, res) => {
  const quiz = await Quiz.create({ ...req.body, owner: req.userId });
  res.status(201).json({ quiz });
});

// import takes the same shape as export, and goes through the same schema
router.post('/import', validate(quizSchema), async (req, res) => {
  const quiz = await Quiz.create({ ...req.body, owner: req.userId });
  res.status(201).json({ quiz });
});

router.get('/:id', (req, res) => {
  res.json({ quiz: req.quiz });
});

router.put('/:id', validate(quizSchema), async (req, res) => {
  req.quiz.set(req.body);
  await req.quiz.save();
  res.json({ quiz: req.quiz });
});

router.delete('/:id', async (req, res) => {
  await req.quiz.deleteOne();
  res.json({ ok: true });
});

router.post('/:id/duplicate', async (req, res) => {
  const { title, description, tags, settings, questions } = req.quiz.toObject();
  const copy = await Quiz.create({
    owner: req.userId,
    title: `Copy of ${title}`.slice(0, 100),
    description,
    tags,
    settings,
    questions,
  });
  res.status(201).json({ quiz: copy });
});

router.get('/:id/export', (req, res) => {
  const { title, description, tags, settings, questions } = req.quiz.toObject();
  const fileName = title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') || 'quiz';
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}.json"`);
  res.json({ title, description, tags, settings, questions });
});

export default router;

import { Router } from 'express';
import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Quiz from '../models/Quiz.js';
import { buildRevisionQuiz } from '../services/revision.js';
import { requireAuth } from '../middleware/auth.js';
import { sessionToCsv } from '../services/exportCsv.js';

const router = Router();
router.use(requireAuth);

router.param('id', async (req, res, next, id) => {
  const session = mongoose.isValidObjectId(id) ? await Session.findById(id) : null;
  if (!session || String(session.host) !== req.userId) {
    return res.status(404).json({ error: 'Game not found' });
  }
  req.session = session;
  next();
});

router.get('/', async (req, res) => {
  const sessions = await Session.find({ host: req.userId })
    .sort({ endedAt: -1 })
    .limit(50)
    .select('quizTitle startedAt endedAt players.nickname questionStats.questionIndex');
  res.json({
    sessions: sessions.map((s) => ({
      id: s._id,
      quizTitle: s.quizTitle,
      endedAt: s.endedAt,
      playerCount: s.players.length,
      questionCount: s.questionStats.length,
    })),
  });
});

router.get('/:id', (req, res) => {
  res.json({ session: req.session });
});

router.get('/:id/export', (req, res) => {
  const name = req.session.quizTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') || 'results';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-results.csv"`);
  res.send(sessionToCsv(req.session));
});

router.post('/:id/revision', async (req, res) => {
  const out = buildRevisionQuiz(req.session.quizTitle, req.session.toObject().questionStats);
  if (out.error) return res.status(400).json({ error: out.error });
  const quiz = await Quiz.create({ ...out.quiz, owner: req.userId });
  res.status(201).json({ quiz });
});

export default router;

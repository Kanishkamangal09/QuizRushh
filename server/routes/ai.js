import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { aiLimiter } from '../middleware/rateLimits.js';
import { aiEnabled, generateQuiz } from '../services/aiQuiz.js';

const router = Router();
router.use(requireAuth);

const generateSchema = z.object({
  topic: z.string().trim().min(3, 'Topic is too short').max(100, 'Topic is too long'),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  count: z.number().int().min(1, 'Ask for at least 1 question').max(15, 'At most 15 questions'),
});

router.get('/status', (req, res) => {
  res.json({ enabled: aiEnabled });
});

router.post('/generate', aiLimiter, validate(generateSchema), async (req, res) => {
  if (!aiEnabled) return res.status(503).json({ error: 'AI generation is not set up on this server' });

  try {
    const quiz = await generateQuiz(req.body);
    res.json({ quiz });
  } catch (err) {
    if (err.code === 'invalid') {
      return res.status(502).json({ error: 'The AI gave a quiz we could not use. Try again or change the topic.' });
    }
    if (err.code === 'refused') {
      return res.status(422).json({ error: 'The AI could not write a quiz on that topic. Try a different one.' });
    }
    logger.error('AI generation failed', err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err);
    res.status(502).json({ error: 'The AI service is not responding right now. Try again in a moment.' });
  }
});

export default router;

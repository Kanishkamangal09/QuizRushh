import { quizSchema } from '../models/Quiz.js';

// weak = answered by someone, and fewer than half of the answers were right
export const weakStats = (stats) => stats.filter((q) => q.totalAnswers > 0 && q.correctCount / q.totalAnswers < 0.5);

// older saved games don't have the type, so tell true/false apart by its options
const typeOf = (q) => q.type || (q.options.length === 2 && q.options[0] === 'True' && q.options[1] === 'False' ? 'tf' : 'mcq');

export function buildRevisionQuiz(title, stats) {
  const weak = weakStats(stats);
  if (weak.length === 0) return { error: 'No weak questions here, everyone did well' };

  const result = quizSchema.safeParse({
    title: `Revision: ${title}`.slice(0, 100),
    description: 'The questions most people got wrong.',
    tags: ['revision'],
    questions: weak.map((q) => ({
      type: typeOf(q),
      text: q.text,
      options: q.options,
      correctIndex: q.correctIndex,
      timeLimitSec: q.timeLimitSec || 20,
      pointsMode: q.pointsMode || 'standard',
    })),
  });
  if (!result.success) return { error: 'Those questions could not be turned into a quiz' };
  return { quiz: result.data };
}

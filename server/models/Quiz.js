import mongoose from 'mongoose';
import { z } from 'zod';

// one schema for create, update, import and ai output
const questionSchema = z
  .object({
    type: z.enum(['mcq', 'tf']),
    text: z.string().trim().min(1, 'Question text is required').max(200, 'Question is too long'),
    options: z
      .array(z.string().trim().min(1, 'Options cannot be empty').max(100, 'Option is too long'))
      .min(2, 'Need at least 2 options')
      .max(4, 'At most 4 options'),
    correctIndex: z.number().int().min(0),
    timeLimitSec: z.number().int().min(5, 'Min time is 5s').max(60, 'Max time is 60s').default(20),
    pointsMode: z.enum(['standard', 'double', 'none']).default('standard'),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'tf' && q.options.length !== 2) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'True/false needs exactly 2 options' });
    }
    if (q.correctIndex >= q.options.length) {
      ctx.addIssue({ code: 'custom', path: ['correctIndex'], message: 'Correct answer must be one of the options' });
    }
    const lower = q.options.map((o) => o.toLowerCase());
    if (new Set(lower).size !== lower.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be different from each other' });
    }
  });

export const quizSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(100, 'Title is too long'),
  description: z.string().trim().max(300, 'Description is too long').default(''),
  tags: z
    .array(z.string().trim().toLowerCase().min(1).max(20, 'Tags are 20 characters max'))
    .max(5, 'At most 5 tags')
    .default([]),
  settings: z
    .object({
      shuffleQuestions: z.boolean().default(false),
      shuffleOptions: z.boolean().default(false),
    })
    .default({ shuffleQuestions: false, shuffleOptions: false }),
  questions: z.array(questionSchema).min(1, 'Add at least one question').max(50, 'At most 50 questions'),
});

const questionDb = new mongoose.Schema(
  {
    type: { type: String, enum: ['mcq', 'tf'], required: true },
    text: { type: String, required: true },
    options: { type: [String], required: true },
    correctIndex: { type: Number, required: true },
    timeLimitSec: { type: Number, default: 20 },
    pointsMode: { type: String, enum: ['standard', 'double', 'none'], default: 'standard' },
  },
  { _id: false }
);

const quizDb = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    tags: { type: [String], default: [], index: true },
    settings: {
      shuffleQuestions: { type: Boolean, default: false },
      shuffleOptions: { type: Boolean, default: false },
    },
    questions: [questionDb],
  },
  { timestamps: true }
);

export default mongoose.model('Quiz', quizDb);

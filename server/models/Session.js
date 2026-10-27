import mongoose from 'mongoose';

const playerDb = new mongoose.Schema(
  {
    nickname: String,
    avatar: String,
    score: Number,
    rank: Number,
    accuracy: Number,
    longestStreak: Number,
    fastestCorrectMs: Number,
    achievements: [String],
    answers: [{ questionIndex: Number, choice: Number, correct: Boolean, points: Number, timeMs: Number, _id: false }],
  },
  { _id: false }
);

const statDb = new mongoose.Schema(
  {
    questionIndex: Number,
    text: String,
    type: String,
    timeLimitSec: Number,
    pointsMode: String,
    options: [String],
    correctIndex: Number,
    correctCount: Number,
    totalAnswers: Number,
    avgTimeMs: Number,
    distribution: [Number],
  },
  { _id: false }
);

// quiz title and question text are copied in, so history survives edits and deletes
const sessionDb = new mongoose.Schema({
  quiz: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' },
  quizTitle: { type: String, required: true },
  host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  code: { type: String, required: true },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, required: true },
  settings: { shuffleQuestions: Boolean, shuffleOptions: Boolean },
  players: [playerDb],
  questionStats: [statDb],
});

export default mongoose.model('Session', sessionDb);

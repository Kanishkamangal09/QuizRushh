import mongoose from 'mongoose';

const questionDb = new mongoose.Schema(
  {
    type: String,
    text: String,
    options: [String],
    correctIndex: Number,
    timeLimitSec: Number,
    pointsMode: String,
  },
  { _id: false }
);

// the questions are copied in, so editing or deleting the quiz later doesn't change a running assignment
const assignmentDb = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    quiz: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' },
    quizTitle: { type: String, required: true },
    description: { type: String, default: '' },
    code: { type: String, required: true, unique: true },
    questions: [questionDb],
    settings: { shuffleQuestions: Boolean, shuffleOptions: Boolean },
    deadline: { type: Date, default: null },
    closed: { type: Boolean, default: false },
    revealAnswers: { type: Boolean, default: true },
    showLeaderboard: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('Assignment', assignmentDb);

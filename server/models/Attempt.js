import mongoose from 'mongoose';

const answerDb = new mongoose.Schema(
  {
    questionIndex: Number, // original question number in the assignment
    choice: Number, // what the student tapped (-1 = ran out of time)
    optionIndex: Number, // same choice in the original option order
    correct: Boolean,
    points: Number,
    timeMs: Number,
  },
  { _id: false }
);

const stepDb = new mongoose.Schema({ q: Number, opts: [Number] }, { _id: false });
const currentDb = new mongoose.Schema({ startedAt: Date }, { _id: false });

const attemptDb = new mongoose.Schema(
  {
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', required: true },
    tokenHash: { type: String, required: true, index: true }, // the token itself is only in the student's browser
    nickname: { type: String, required: true },
    nicknameKey: { type: String, required: true },
    avatar: String,
    plan: [stepDb], // the order this student gets the questions and options in
    current: { type: currentDb, default: null },
    answers: [answerDb],
    score: { type: Number, default: 0 },
    streak: { type: Number, default: 0 },
    longestStreak: { type: Number, default: 0 },
    correct: { type: Number, default: 0 },
    fastestCorrectMs: { type: Number, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// one attempt per nickname per assignment
attemptDb.index({ assignment: 1, nicknameKey: 1 }, { unique: true });

export default mongoose.model('Attempt', attemptDb);

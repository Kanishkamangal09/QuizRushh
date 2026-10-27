// cells starting with = + - @ (or tab/cr) can run as formulas in Excel, so they get a leading '
function cell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function sessionToCsv(session) {
  const header = [
    'Rank',
    'Nickname',
    'Score',
    'Accuracy %',
    'Longest streak',
    'Fastest correct (s)',
    'Achievements',
    ...session.questionStats.map((q, i) => `Q${i + 1} points`),
  ];

  const rows = [...session.players]
    .sort((a, b) => a.rank - b.rank)
    .map((p) => [
      p.rank,
      p.nickname,
      p.score,
      p.accuracy,
      p.longestStreak,
      p.fastestCorrectMs == null ? '' : (p.fastestCorrectMs / 1000).toFixed(2),
      p.achievements.join('; '),
      ...session.questionStats.map((q) => p.answers.find((a) => a.questionIndex === q.questionIndex)?.points ?? 0),
    ]);

  // the BOM makes Excel read the file as utf-8, otherwise emoji and accents break
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionToCsv } from '../services/exportCsv.js';

const session = (nickname) => ({
  questionStats: [{ questionIndex: 0 }, { questionIndex: 1 }],
  players: [
    { nickname, rank: 1, score: 1500, accuracy: 100, longestStreak: 2, fastestCorrectMs: 1234, achievements: ['Speed Demon', 'Perfect Score'], answers: [{ questionIndex: 0, points: 1000 }, { questionIndex: 1, points: 500 }] },
  ],
});

test('csv has a header, a row per player and per question points', () => {
  const lines = sessionToCsv(session('Asha')).replace('﻿', '').trim().split('\r\n');
  assert.equal(lines[0], 'Rank,Nickname,Score,Accuracy %,Longest streak,Fastest correct (s),Achievements,Q1 points,Q2 points');
  assert.equal(lines[1], '1,Asha,1500,100,2,1.23,Speed Demon; Perfect Score,1000,500');
});

test('formula characters at the start of a cell are neutralised', () => {
  for (const bad of ['=SUM(A1)', '+1', '-2', '@cmd', '\tx']) {
    const row = sessionToCsv(session(bad)).split('\r\n')[1];
    assert.ok(row.startsWith(`1,'${bad[0] === '\t' ? '\t' : bad[0]}`) || row.startsWith(`1,"'`), `not escaped: ${JSON.stringify(row)}`);
  }
});

test('commas, quotes and newlines are quoted', () => {
  const row = sessionToCsv(session('a,"b"\nc')).split('\r\n').slice(1).join('\r\n');
  assert.ok(row.startsWith('1,"a,""b""\nc",'));
});

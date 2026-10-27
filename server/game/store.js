import { randomInt } from 'node:crypto';

// live games only exist in memory, a server restart loses them on purpose
const games = new Map();

const MAX_AGE_MS = 30 * 60 * 1000;
let sweeper = null;

export function newCode() {
  let code;
  do {
    code = String(randomInt(100000, 1000000));
  } while (games.has(code));
  return code;
}

export const saveGame = (game) => games.set(game.code, game);
export const getGame = (code) => games.get(code);

export function activeGamesFor(userId) {
  return [...games.values()].filter((g) => g.hostUserId === userId && g.state !== 'FINISHED').length;
}

export function removeGame(code) {
  const game = games.get(code);
  if (!game) return;
  clearTimeout(game.q?.timer);
  clearTimeout(game.hostTimer);
  games.delete(code);
}

// finished or abandoned games go after 30 minutes without activity
export function sweep(now = Date.now()) {
  for (const game of games.values()) {
    if (now - game.lastActivity > MAX_AGE_MS) removeGame(game.code);
  }
}

export function startSweeper() {
  sweeper = setInterval(sweep, 60 * 1000);
  sweeper.unref();
}

export function clearAll() {
  clearInterval(sweeper);
  for (const code of [...games.keys()]) removeGame(code);
}

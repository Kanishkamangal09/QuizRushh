import { z } from 'zod';
import config from '../config.js';
import logger from '../logger.js';
import Quiz from '../models/Quiz.js';
import Session from '../models/Session.js';
import { userIdFromCookieHeader } from '../middleware/auth.js';
import { EV, STATES, AVATARS, NICK_MIN, NICK_MAX } from '../../public/js/constants.js';
import * as engine from '../game/engine.js';
import { newCode, saveGame, getGame, activeGamesFor } from '../game/store.js';
import { applyGuard } from './socketGuard.js';

const MAX_GAMES_PER_HOST = 5;

const roomOf = (code) => `game:${code}`;
const hostRoomOf = (code) => `host:${code}`;

const codeSchema = z.string().regex(/^\d{6}$/, 'Game code is 6 digits');
const emptySchema = z.object({}).optional();

const schemas = {
  hostCreate: z
    .object({ quizId: z.string().regex(/^[a-f0-9]{24}$/i, 'Bad quiz id').optional(), code: codeSchema.optional() })
    .refine((d) => d.quizId || d.code, 'Pick a quiz to host'),
  kick: z.object({ playerId: z.string().max(10) }),
  lock: z.object({ locked: z.boolean() }),
  join: z.object({
    code: codeSchema,
    nickname: z.string().trim().min(NICK_MIN, `Nickname needs at least ${NICK_MIN} characters`).max(NICK_MAX, `Nickname is ${NICK_MAX} characters max`),
    avatar: z.enum(AVATARS, 'Pick an avatar'),
  }),
  rejoin: z.object({ code: codeSchema, token: z.string().uuid() }),
  answer: z.object({ choice: z.number().int().min(0).max(3) }),
};

function lobbyPayload(game) {
  return {
    code: game.code,
    locked: game.locked,
    hostConnected: !!game.hostSocketId,
    maxPlayers: game.maxPlayers,
    players: [...game.players.values()].map((p) => ({ id: p.id, nickname: p.nickname, avatar: p.avatar, connected: p.connected })),
  };
}

// everything a client needs to draw the current screen, used on join, rejoin and host reconnect
function snapshotFor(game, role, player) {
  const snap = {
    role,
    code: game.code,
    state: game.state,
    quizTitle: game.quizTitle,
    lobby: lobbyPayload(game),
    question: null,
    paused: game.paused,
    remainingMs: game.paused ? game.q.remainingMs : null,
    progress: null,
    myChoice: null,
    reveal: null,
    result: null,
    finished: null,
  };

  if (game.state === STATES.QUESTION) {
    snap.question = engine.questionPayload(game);
    if (role === 'host') snap.progress = engine.progress(game);
    if (player) snap.myChoice = game.q.answers.get(player.id)?.choice ?? null;
  }
  if (game.state === STATES.REVEAL) {
    snap.question = engine.questionPayload(game);
    snap.reveal = game.lastReveal;
    if (player) snap.result = player.lastResult;
  }
  if (game.state === STATES.FINISHED) {
    snap.finished = {
      reason: game.finishReason,
      leaderboard: engine.leaderboard(game),
      sessionId: role === 'host' ? game.sessionId : null,
      you: player ? engine.summaryFor(game, player.id) : null,
    };
  }
  return snap;
}

export function registerSockets(io) {
  const emitLobby = (game) => io.to(roomOf(game.code)).emit(EV.LOBBY_UPDATE, lobbyPayload(game));
  const emitProgress = (game) => io.to(hostRoomOf(game.code)).emit(EV.ANSWER_PROGRESS, engine.progress(game));

  function emitQuestion(game) {
    io.to(roomOf(game.code)).emit(EV.QUESTION_START, engine.questionPayload(game));
    emitProgress(game);
  }

  function revealNow(game) {
    const out = engine.endQuestion(game);
    if (!out) return;
    for (const p of game.players.values()) {
      if (p.connected && p.socketId) io.to(p.socketId).emit(EV.ANSWER_RESULT, out.results.get(p.id));
    }
    io.to(roomOf(game.code)).emit(EV.QUESTION_REVEAL, out.reveal);
  }

  // the timer in the engine calls this when time runs out
  const onTimeUp = (game) => revealNow(game);

  async function finish(game, reason) {
    if (!engine.finishGame(game, reason)) return;

    // nothing worth saving if no question was ever played
    if (game.stats.length > 0) {
      try {
        const saved = await Session.create(engine.sessionData(game));
        game.sessionId = String(saved._id);
      } catch (err) {
        logger.error('Could not save session', err);
      }
    }

    const board = engine.leaderboard(game);
    io.to(hostRoomOf(game.code)).emit(EV.GAME_FINISHED, { reason, leaderboard: board, sessionId: game.sessionId, you: null });
    for (const p of game.players.values()) {
      if (p.socketId) io.to(p.socketId).emit(EV.GAME_FINISHED, { reason, leaderboard: board, sessionId: null, you: engine.summaryFor(game, p.id) });
    }
  }

  // after someone leaves or disconnects, the question may now be fully answered
  function checkAllAnswered(game) {
    if (game.state !== STATES.QUESTION || game.paused) return;
    emitProgress(game);
    if (engine.everyoneAnswered(game)) revealNow(game);
  }

  // identify the host from the login cookie. players have no account so they just pass through
  io.use((socket, next) => {
    socket.data.userId = userIdFromCookieHeader(socket.handshake.headers.cookie);
    next();
  });

  io.on('connection', (socket) => {
    applyGuard(socket);

    // wraps a handler: validates the payload, catches errors, gives it reply/fail helpers
    function on(event, schema, handler) {
      socket.on(event, async (payload, ack) => {
        if (typeof payload === 'function') {
          ack = payload;
          payload = undefined;
        }
        const hasAck = typeof ack === 'function';
        const fail = (message) => (hasAck ? ack({ ok: false, error: message }) : socket.emit(EV.ERROR, { message }));
        const reply = (data) => hasAck && ack({ ok: true, ...data });

        const parsed = schema.safeParse(payload);
        if (!parsed.success) return fail(parsed.error.issues[0].message);

        try {
          await handler(parsed.data, { reply, fail });
        } catch (err) {
          logger.error(`socket ${event} failed`, err);
          fail('Something went wrong');
        }
      });
    }

    // only the authenticated host who owns this game, on the socket that attached to it
    function hostGame(fail) {
      const game = getGame(socket.data.hostCode);
      const ok = game && game.hostUserId === socket.data.userId && game.hostSocketId === socket.id;
      if (!ok) {
        fail('Only the host can do that');
        return null;
      }
      return game;
    }

    function playerGame() {
      const game = getGame(socket.data.playerCode);
      return game?.players.has(socket.data.playerId) ? game : null;
    }

    function attachHost(game) {
      clearTimeout(game.hostTimer);
      game.hostSocketId = socket.id;
      socket.data.hostCode = game.code;
      socket.join([roomOf(game.code), hostRoomOf(game.code)]);
    }

    function attachPlayer(game, player) {
      player.socketId = socket.id;
      player.connected = true;
      socket.data.playerCode = game.code;
      socket.data.playerId = player.id;
      socket.join(roomOf(game.code));
    }

    // ---------- host ----------

    // also used to take control back after a refresh or reconnect, by passing the code
    on(EV.HOST_CREATE, schemas.hostCreate, async (data, { reply, fail }) => {
      if (!socket.data.userId) return fail('Please log in again');

      let game;
      if (data.code) {
        game = getGame(data.code);
        if (!game || game.hostUserId !== socket.data.userId) return fail('That game no longer exists');
      } else {
        if (activeGamesFor(socket.data.userId) >= MAX_GAMES_PER_HOST) return fail('You have too many live games open');
        const quiz = await Quiz.findById(data.quizId).lean();
        if (!quiz || String(quiz.owner) !== socket.data.userId) return fail('Quiz not found');
        game = engine.createGame({ quiz, hostUserId: socket.data.userId, code: newCode(), maxPlayers: config.maxPlayers, onTimeUp });
        saveGame(game);
      }

      attachHost(game);
      emitLobby(game);
      reply({ code: game.code, snapshot: snapshotFor(game, 'host') });
    });

    on(EV.HOST_START, emptySchema, (data, { fail }) => {
      const game = hostGame(fail);
      if (!game) return;
      const res = engine.startGame(game);
      if (res.error) return fail(res.error);
      emitQuestion(game);
    });

    on(EV.HOST_NEXT, emptySchema, async (data, { fail }) => {
      const game = hostGame(fail);
      if (!game) return;
      if (game.state !== STATES.REVEAL) return fail('Wait for the question to finish');
      if (!engine.hasNext(game)) return finish(game, 'complete');
      engine.nextQuestion(game);
      emitQuestion(game);
    });

    on(EV.HOST_PAUSE, emptySchema, (data, { fail }) => {
      const game = hostGame(fail);
      if (!game) return;
      const res = engine.pauseGame(game);
      if (res.error) return fail(res.error);
      io.to(roomOf(game.code)).emit(EV.GAME_PAUSED, { remainingMs: res.remainingMs });
    });

    on(EV.HOST_RESUME, emptySchema, (data, { fail }) => {
      const game = hostGame(fail);
      if (!game) return;
      const res = engine.resumeGame(game);
      if (res.error) return fail(res.error);
      io.to(roomOf(game.code)).emit(EV.GAME_RESUMED, { endsAt: res.endsAt, serverNow: Date.now() });
    });

    // skip = stop waiting and go to the reveal with the answers so far
    on(EV.HOST_SKIP, emptySchema, (data, { fail }) => {
      const game = hostGame(fail);
      if (!game) return;
      if (game.state !== STATES.QUESTION) return fail('There is no question to skip');
      revealNow(game);
    });

    on(EV.HOST_END, emptySchema, async (data, { fail }) => {
      const game = hostGame(fail);
      if (!game) return;
      await finish(game, 'ended');
    });

    on(EV.HOST_KICK, schemas.kick, (data, { fail }) => {
      const game = hostGame(fail);
      if (!game) return;
      const player = game.players.get(data.playerId);
      if (!player) return fail('That player is already gone');

      engine.removePlayer(game, player.id);
      if (player.socketId) {
        io.to(player.socketId).emit(EV.PLAYER_KICKED, { reason: 'The host removed you from the game' });
        io.in(player.socketId).socketsLeave(roomOf(game.code));
      }
      emitLobby(game);
      checkAllAnswered(game);
    });

    on(EV.HOST_LOCK, schemas.lock, (data, { fail }) => {
      const game = hostGame(fail);
      if (!game) return;
      engine.setLocked(game, data.locked);
      emitLobby(game);
    });

    // ---------- players ----------

    on(EV.PLAYER_JOIN, schemas.join, (data, { reply, fail }) => {
      const game = getGame(data.code);
      if (!game || game.state === STATES.FINISHED) return fail('No game found with that code');

      const res = engine.addPlayer(game, data);
      if (res.error) return fail(res.error);

      attachPlayer(game, res.player);
      emitLobby(game);
      reply({ playerId: res.player.id, token: res.player.token, snapshot: snapshotFor(game, 'player', res.player) });
    });

    on(EV.PLAYER_REJOIN, schemas.rejoin, (data, { reply, fail }) => {
      const game = getGame(data.code);
      const player = game && engine.findByToken(game, data.token);
      if (!player) return fail('Could not rejoin that game');

      attachPlayer(game, player);
      emitLobby(game);
      reply({ playerId: player.id, snapshot: snapshotFor(game, 'player', player) });
    });

    on(EV.PLAYER_ANSWER, schemas.answer, (data, { reply, fail }) => {
      const game = playerGame();
      if (!game) return fail('Join a game first');
      const res = engine.submitAnswer(game, socket.data.playerId, data.choice);
      if (!res.ok) return fail(res.reason);

      reply({});
      emitProgress(game);
      if (res.allAnswered) revealNow(game);
    });

    // ---------- disconnects ----------

    socket.on('disconnect', () => {
      const hostGameNow = getGame(socket.data.hostCode);
      if (hostGameNow && hostGameNow.hostSocketId === socket.id) {
        hostGameNow.hostSocketId = null;
        if (hostGameNow.state !== STATES.FINISHED) {
          emitLobby(hostGameNow);
          hostGameNow.hostTimer = setTimeout(() => finish(hostGameNow, 'host-left'), config.hostGraceMs);
          hostGameNow.hostTimer.unref();
        }
      }

      const game = getGame(socket.data.playerCode);
      const player = game?.players.get(socket.data.playerId);
      // a newer socket may have taken over already (refresh), only the current one counts
      if (player && player.socketId === socket.id) {
        player.connected = false;
        emitLobby(game);
        checkAllAnswered(game);
      }
    });
  });
}

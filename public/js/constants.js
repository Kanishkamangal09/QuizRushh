// shared by the server and the browser modules, so event names can't drift apart
export const EV = Object.freeze({
  HOST_CREATE: 'host:create',
  HOST_START: 'host:start',
  HOST_NEXT: 'host:next',
  HOST_PAUSE: 'host:pause',
  HOST_RESUME: 'host:resume',
  HOST_SKIP: 'host:skip',
  HOST_END: 'host:end',
  HOST_KICK: 'host:kick',
  HOST_LOCK: 'host:lock',
  PLAYER_JOIN: 'player:join',
  PLAYER_REJOIN: 'player:rejoin',
  PLAYER_ANSWER: 'player:answer',

  LOBBY_UPDATE: 'lobby:update',
  QUESTION_START: 'question:start',
  ANSWER_PROGRESS: 'answer:progress',
  ANSWER_RESULT: 'answer:result',
  QUESTION_REVEAL: 'question:reveal',
  GAME_PAUSED: 'game:paused',
  GAME_RESUMED: 'game:resumed',
  GAME_FINISHED: 'game:finished',
  PLAYER_KICKED: 'player:kicked',
  ERROR: 'error:message',
});

export const STATES = Object.freeze({
  LOBBY: 'LOBBY',
  QUESTION: 'QUESTION',
  REVEAL: 'REVEAL',
  FINISHED: 'FINISHED',
});

export const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐙', '🦁', '🐧', '🤖'];

export const NICK_MIN = 2;
export const NICK_MAX = 16;

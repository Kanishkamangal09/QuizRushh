import { EV } from '../../public/js/constants.js';

const MAX_PER_SECOND = 20;

// [max events, window in ms] for the expensive ones
const strict = {
  [EV.PLAYER_JOIN]: [5, 10000],
  [EV.PLAYER_REJOIN]: [5, 10000],
  [EV.HOST_CREATE]: [5, 10000],
  [EV.PLAYER_ANSWER]: [5, 1000],
};

// drops events from a socket that sends too many, and kicks it if it keeps going
export function applyGuard(socket) {
  const recent = []; // timestamps of all events
  const perEvent = new Map();
  let strikes = 0;

  socket.use(([event], next) => {
    const now = Date.now();
    while (recent.length && now - recent[0] > 1000) recent.shift();
    recent.push(now);

    let tooMany = recent.length > MAX_PER_SECOND;

    if (strict[event]) {
      const [max, windowMs] = strict[event];
      const times = (perEvent.get(event) ?? []).filter((t) => now - t < windowMs);
      times.push(now);
      perEvent.set(event, times);
      if (times.length > max) tooMany = true;
    }

    if (!tooMany) return next();

    strikes++;
    socket.emit(EV.ERROR, { message: 'Slow down a little' });
    if (strikes > 30) socket.disconnect(true);
  });
}

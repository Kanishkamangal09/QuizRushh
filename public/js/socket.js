import { io } from '/socket.io/socket.io.esm.min.js';

// connects and keeps a small status indicator up to date. socket.io retries on its own
export function connect(statusEl) {
  const set = (cls, text) => {
    statusEl.className = `conn ${cls}`;
    statusEl.textContent = text;
  };

  const socket = io({ transports: ['websocket', 'polling'] });
  set('', 'Connecting...');

  socket.on('connect', () => set('online', 'Connected'));
  socket.on('disconnect', () => set('offline', 'Connection lost, reconnecting...'));
  socket.on('connect_error', () => set('offline', 'Cannot reach the server, retrying...'));
  socket.io.on('reconnect_attempt', (n) => set('offline', `Reconnecting (try ${n})...`));
  return socket;
}

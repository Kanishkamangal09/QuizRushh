import jwt from 'jsonwebtoken';
import config from '../config.js';

export const COOKIE_NAME = 'qr_token';

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function signToken(userId) {
  return jwt.sign({ id: userId }, config.jwtSecret, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret).id;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Please log in' });
  const id = verifyToken(token);
  if (!id) return res.status(401).json({ error: 'Session expired, please log in again' });
  req.userId = id;
  next();
}

// sockets don't go through cookie-parser, so read the raw header
export function userIdFromCookieHeader(header = '') {
  const part = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return part ? verifyToken(decodeURIComponent(part.slice(COOKIE_NAME.length + 1))) : null;
}

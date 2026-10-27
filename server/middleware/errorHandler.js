import config from '../config.js';
import logger from '../logger.js';

export function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(err, req, res, next) {
  if (err.code === 11000) return res.status(409).json({ error: 'That already exists' });
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });

  const status = err.status || 500;
  if (status >= 500) logger.error(err);

  // body-parser errors (bad json, too large) carry their own status
  const message = status >= 500 && config.isProd ? 'Something went wrong' : err.message;
  res.status(status).json({ error: message });
}

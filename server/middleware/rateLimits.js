import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import config from '../config.js';

function limiter(windowMs, limit, message, keyGenerator) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => config.isTest,
    message: { error: message },
    ...(keyGenerator && { keyGenerator, validate: { keyGeneratorIpFallback: false } }),
  });
}

export const apiLimiter = limiter(60 * 1000, 300, 'Too many requests, slow down');

export const authLimiter = limiter(15 * 60 * 1000, 20, 'Too many attempts, try again in a few minutes');

// runs after requireAuth so it can key on the user, not the ip
export const aiLimiter = limiter(60 * 60 * 1000, 10, 'AI limit reached, try again later', (req) => req.userId);

// homework students are anonymous and a whole class shares one school ip, so play requests are
// limited per attempt token, and only fall back to the ip when there is no token yet
export const hwLimiter = limiter(60 * 1000, 90, 'Slow down a little', (req) => req.get('x-attempt-token') || ipKeyGenerator(req.ip));

export const hwJoinLimiter = limiter(15 * 60 * 1000, 300, 'Too many joins from this network, try again later');

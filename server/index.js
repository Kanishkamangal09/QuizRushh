import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config.js';
import logger from './logger.js';
import { apiLimiter } from './middleware/rateLimits.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import quizRoutes from './routes/quizzes.js';
import sessionRoutes from './routes/sessions.js';
import aiRoutes from './routes/ai.js';
import homeworkRoutes from './routes/homework.js';
import homeworkPlayRoutes from './routes/homeworkPlay.js';
import { registerSockets } from './sockets/handlers.js';
import { startSweeper, clearAll } from './game/store.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function buildApp() {
  const app = express();

  // render sits behind one proxy, needed so rate limits see real client ips
  if (config.isProd) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          // ws: and wss: because some browsers don't treat 'self' as covering websockets
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // would break testing from a phone over plain http on the lan
          upgradeInsecureRequests: null,
        },
      },
    })
  );
  app.use(cors({ origin: config.clientUrl, credentials: true }));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  app.use('/api/health', healthRoutes);
  // student homework routes have their own limiter, a whole class can share one ip
  app.use('/api/hw', homeworkPlayRoutes);
  app.use('/api', apiLimiter);
  app.use('/api/auth', authRoutes);
  app.use('/api/quizzes', quizRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/homework', homeworkRoutes);
  app.use('/api', notFound);

  app.use(express.static(publicDir));
  app.use(errorHandler);
  return app;
}

export async function startServer() {
  await mongoose.connect(config.mongoUri);
  const server = http.createServer(buildApp());

  const io = new Server(server, {
    cors: { origin: config.clientUrl, credentials: true },
    // a bit generous so brief mobile network drops don't count as a disconnect
    pingInterval: 20000,
    pingTimeout: 25000,
    maxHttpBufferSize: 10000,
  });
  registerSockets(io);
  startSweeper();

  await new Promise((resolve) => server.listen(config.port, resolve));

  const stop = async () => {
    clearAll();
    await new Promise((resolve) => io.close(resolve));
    await mongoose.disconnect();
  };
  return { server, io, stop };
}

// only boot when run directly, tests import startServer instead
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer()
    .then(({ server }) => logger.info(`QuizRush listening on port ${server.address().port}`))
    .catch((err) => {
      logger.error('Failed to start:', err.message);
      process.exit(1);
    });
}

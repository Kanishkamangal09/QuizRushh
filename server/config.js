const env = process.env;

const missing = ['MONGO_URI', 'JWT_SECRET'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}. See .env.example`);
  process.exit(1);
}

const config = {
  mongoUri: env.MONGO_URI,
  jwtSecret: env.JWT_SECRET,
  port: Number(env.PORT ?? 3000),
  clientUrl: env.CLIENT_URL || 'http://localhost:3000',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  aiModel: env.AI_MODEL || 'claude-sonnet-5-5',
  maxPlayers: Number(env.MAX_PLAYERS) || 100,
  // how long a game waits for a disconnected host before ending. only tests change this
  hostGraceMs: Number(env.HOST_GRACE_MS) || 60 * 1000,
};

export default config;

import { buildApp } from './app.js';
import { config } from './config.js';
import { db } from './db/index.js';

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'arrêt en cours');
  try {
    await app.close();
    db.close();
  } finally {
    process.exit(0);
  }
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

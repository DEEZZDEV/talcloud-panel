import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(import.meta.dirname, '../shared') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Chaque fichier de test a son propre graphe de modules, donc sa propre base SQLite en mémoire.
    isolate: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Environnement posé AVANT tout import de l'application (config.ts valide process.env à l'import).
    // Les variables vides neutralisent celles d'un éventuel fichier .env local (dotenv ne les écrase pas).
    env: {
      NODE_ENV: 'test',
      DB_PATH: ':memory:',
      PUBLIC_URL: 'https://panel.test',
      MASTER_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      SESSION_SECRET: 'secret-de-test-uniquement-0123456789-abcdefghij',
      TRUST_PROXY: 'false',
      SESSION_IDLE_MINUTES: '15',
      SESSION_MAX_HOURS: '8',
      STEP_UP_MINUTES: '5',
      IP_ALLOWLIST: '',
      SMTP_HOST: '',
      SECURITY_DISCORD_WEBHOOK_URL: '',
      GEOIP_DB_PATH: '',
      // Permet aux tests de simuler le pays de l'appelant avec l'en-tête CF-IPCountry.
      TRUST_CF_COUNTRY_HEADER: 'true',
      WEB_DIST_DIR: './test/.no-web-dist',
      LOG_LEVEL: 'silent',
    },
  },
});

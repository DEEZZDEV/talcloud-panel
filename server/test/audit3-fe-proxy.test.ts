import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Audit 3 (déploiement) — non-régression E-02, E-03, E-05.
 *  - E-02 : TRUST_PROXY=true ou une plage trop large est refusé au démarrage en production.
 *  - E-03 : avec le docker-compose fourni, seule l'IP fixe de Caddy est de confiance ; un autre pair privé
 *           (passerelle docker = processus de l'hôte, machine du LAN) ne peut pas usurper son IP.
 *  - E-05 : le webhook Discord de sécurité doit être une URL https://discord.com/api/webhooks/….
 */
process.env.NODE_ENV = 'production';
process.env.PUBLIC_URL = 'https://panel.exemple.test';
process.env.TRUST_PROXY = '172.30.0.2';
process.env.IP_ALLOWLIST = '203.0.113.0/24';
process.env.SMTP_HOST = 'smtp.invalide.test';
process.env.SMTP_FROM = 'panel@exemple.test';
process.env.LOG_LEVEL = 'silent';

const CADDY = '172.30.0.2';
const base = {
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://panel.exemple.test',
  MASTER_KEY: 'a'.repeat(64),
  SESSION_SECRET: 's'.repeat(40),
  SMTP_HOST: 'smtp.invalide.test',
  SMTP_FROM: 'panel@exemple.test',
};

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import('../src/app.js');
  app = await buildApp();
  app.get('/api/test/whoami', { config: { public: true } }, async (request) => ({ data: request.client }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const whoami = (remoteAddress: string, forwardedFor: string) =>
  app.inject({
    method: 'GET',
    url: '/api/test/whoami',
    remoteAddress,
    headers: { host: 'panel.exemple.test', 'x-forwarded-proto': 'https', 'x-forwarded-for': forwardedFor },
  });

describe('E-02 / E-05 : configuration dangereuse refusée au démarrage en production', () => {
  it.each([['true'], ['0.0.0.0/0'], ['10.0.0.0/8'], ['uniquelocal'], ['::/0'], ['172.30.0.2,0.0.0.0/0']])('TRUST_PROXY=%s est refusé', async (value) => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
  });

  it.each([['172.30.0.2'], ['172.30.0.0/24'], ['false'], ['loopback']])('TRUST_PROXY=%s est accepté', async (value) => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ ...base, TRUST_PROXY: value })).not.toThrow();
  });

  it.each([['http://discord.com/api/webhooks/1/x'], ['https://alertes.exemple.test/hook'], ['https://discord.com.evil.test/api/webhooks/1/x'], ['https://u:p@discord.com/api/webhooks/1/x']])(
    'SECURITY_DISCORD_WEBHOOK_URL=%s est refusé',
    async (value) => {
      const { loadConfig } = await import('../src/config.js');
      expect(() => loadConfig({ ...base, TRUST_PROXY: CADDY, SECURITY_DISCORD_WEBHOOK_URL: value })).toThrow(/SECURITY_DISCORD_WEBHOOK_URL/);
    },
  );

  it('un webhook Discord https valide est accepté', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ ...base, TRUST_PROXY: CADDY, SECURITY_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc' })).not.toThrow();
  });
});

describe('E-03 : seul Caddy peut annoncer l’IP du client', () => {
  it('Caddy (IP de confiance) transmet l’IP réelle du client autorisé', async () => {
    const res = await whoami(CADDY, '203.0.113.50');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ip).toBe('203.0.113.50');
  });

  it.each([['172.30.0.1'], ['172.20.0.1'], ['192.168.1.23']])('un autre pair privé (%s) ne peut pas usurper une IP autorisée', async (peer) => {
    const res = await whoami(peer, '203.0.113.50');
    expect(res.statusCode).not.toBe(200);
  });
});

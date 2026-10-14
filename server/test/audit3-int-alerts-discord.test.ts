/**
 * AUDIT 3 (intégrations) — D-01 : injection Markdown dans le webhook Discord des ALERTES DE SÉCURITÉ.
 *
 * core/alerts.ts envoie les « faits » d'une alerte (dont l'User-Agent de l'appelant, choisi librement par un
 * anonyme) tels quels dans les champs de l'embed Discord. Contrairement au module notifications (discordText),
 * rien n'est échappé : un simple échec de connexion avec un User-Agent piégé fait apparaître, dans le salon de
 * sécurité des administrateurs, un lien masqué cliquable au texte rassurant (hameçonnage).
 *
 * Comportement sûr attendu : aucune valeur venant de la requête ne produit de lien masqué ni de lien cliquable.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { fetchMock, SECURITY_HOOK } = vi.hoisted(() => {
  const url = 'https://discord.com/api/webhooks/123456789012345678/securiteSecuriteSecuriteSecurite0123456789';
  process.env.SECURITY_DISCORD_WEBHOOK_URL = url;
  return { fetchMock: vi.fn(), SECURITY_HOOK: url };
});

vi.mock('../src/core/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/http.js')>()),
  upstreamFetch: fetchMock,
}));

import { flushAlerts } from '../src/core/alerts.js';
import { Browser, buildTestApp, uniqueIp, useFakeClock } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  useFakeClock();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 204, body: null }));
  app = await buildTestApp();
});

afterAll(async () => {
  await flushAlerts();
  await app.close();
});

describe('D-01 — alertes de sécurité vers Discord : Markdown non échappé (User-Agent d’un anonyme)', () => {
  it('un échec de connexion anonyme ne doit pas pouvoir publier un lien masqué cliquable dans le salon de sécurité', async () => {
    const evilUa = 'Mozilla/5.0 [⚠ Session compromise : réinitialisez votre accès ici](https://panel-securite.evil.example/reset) **URGENT**';
    const anonymous = new Browser(app, uniqueIp(), evilUa);
    const res = await anonymous.post('/api/auth/login', { identifier: 'personne-inconnue', password: 'mauvais-mot-de-passe' });
    expect(res.status).toBeGreaterThanOrEqual(400);

    await flushAlerts();

    const calls = fetchMock.mock.calls.filter(([, url]) => String(url) === SECURITY_HOOK);
    expect(calls.length, 'alerte Discord de sécurité attendue').toBeGreaterThan(0);
    const payload = JSON.parse(String((calls[0]![2] as { body: string }).body)) as {
      allowed_mentions: unknown;
      embeds: { title: string; description: string; fields: { name: string; value: string }[] }[];
    };
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    const rendered = [payload.embeds[0]!.title, payload.embeds[0]!.description, ...payload.embeds[0]!.fields.map((f) => f.value)].join('\n');
    // Le contenu fourni par l'anonyme figure bien dans l'alerte (contrôle du test lui-même).
    // (comparaison sans les antislashs et espaces de largeur nulle ajoutés par l'échappement)
    expect(rendered.replace(/[\\​]/g, '')).toContain('panel-securite.evil.example');
    // Sûr : ni lien masqué « [texte](url) » non échappé, ni URL cliquable, ni gras.
    expect(rendered).not.toMatch(/(^|[^\\])\[[^\]]*\]\(https?:\/\//);
    expect(rendered).not.toMatch(/https?:\/\/panel-securite/);
    expect(rendered).not.toMatch(/(^|[^\\])\*\*URGENT/);
  });
});

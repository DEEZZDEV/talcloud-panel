/**
 * AUDIT 3 (authentification) — mesure réelle des temps de réponse de POST /api/auth/login (oracle d'existence de
 * compte et de verrou). Vérifié : l'écart entre identifiant inconnu, compte connu (mauvais mot de passe) et compte
 * verrouillé « appareils inconnus » reste noyé dans la variance d'Argon2id.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetAlertThrottle } from '../src/core/alerts.js';
import { outbox } from '../src/core/mailer.js';
import { db } from '../src/db/index.js';
import { advance, Browser, buildTestApp, createTestAdmin, useFakeClock, type TestAdmin } from './helpers.js';

let app: FastifyInstance;
let alice: TestAdmin;
let n = 0;
const ip = () => {
  n += 1;
  return `203.0.${Math.floor(n / 250)}.${(n % 250) + 1}`;
};

beforeAll(async () => {
  useFakeClock();
  app = await buildTestApp();
  alice = await createTestAdmin('alice');
});

afterAll(async () => {
  await app.close();
});

async function once(identifier: string, password: string): Promise<number> {
  advance(61_000);
  const browser = new Browser(app, ip());
  const start = performance.now();
  const res = await browser.post('/api/auth/login', { identifier, password });
  const elapsed = performance.now() - start;
  expect(res.status).toBe(401);
  outbox.length = 0;
  resetAlertThrottle();
  return elapsed;
}

const setUnknownLock = (until: number | null) => db.prepare('UPDATE users SET unknown_locked_until = ? WHERE id = ?').run(until, alice.user.id);

/** Mesures entrelacées (une de chaque cas par tour) : une variation de charge de la machine touche les trois séries. */
async function sampleInterleaved(rounds: number) {
  const unknown: number[] = [];
  const known: number[] = [];
  const lockedRight: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    unknown.push(await once('identifiant-inexistant', 'Mauvais-Mot-De-Passe-1!'));
    db.exec('UPDATE users SET unknown_failed_attempts = 0, unknown_lock_count = 0, unknown_last_failure_at = NULL');
    known.push(await once(alice.username, 'Mauvais-Mot-De-Passe-1!'));
    setUnknownLock(Date.now() + 24 * 3600_000);
    lockedRight.push(await once(alice.username, alice.password));
    setUnknownLock(null);
  }
  return { unknown: unknown.sort((a, b) => a - b), known: known.sort((a, b) => a - b), lockedRight: lockedRight.sort((a, b) => a - b) };
}

const median = (values: number[]) => values[Math.floor(values.length / 2)]!;

describe('vérifié — pas d’oracle temporel exploitable sur la première étape de connexion', () => {
  it('identifiant inconnu / connu / verrouillé : écarts de médiane faibles devant la durée d’Argon2id', async () => {
    await once('inconnu-0', 'x'); // préchauffage
    const { unknown, known, lockedRight } = await sampleInterleaved(25);
    const m = { unknown: median(unknown), known: median(known), lockedRight: median(lockedRight) };
    console.log('médianes (ms)', JSON.stringify(m), 'p10-p90 inconnu', unknown[2]?.toFixed(1), unknown[22]?.toFixed(1));
    const base = m.unknown;
    expect(Math.abs(m.known - base) / base).toBeLessThan(0.25);
    expect(Math.abs(m.lockedRight - base) / base).toBeLessThan(0.25);
  });
});

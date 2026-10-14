import type { ApiErrorBody, LoginStepResponse, SessionState } from '@shared/api-types';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { generateSync } from 'otplib';
import { vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { flushAlerts } from '../src/core/alerts.js';
import { outbox } from '../src/core/mailer.js';
import { createAdmin } from '../src/modules/auth/admin.js';
import { newTotpSecret } from '../src/modules/auth/totp.js';
import type { UserRow } from '../src/modules/auth/users.js';

export const ORIGIN = 'https://panel.test';
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export interface TestAdmin {
  user: UserRow;
  username: string;
  email: string;
  password: string;
  totpSecret: string;
  backupCodes: string[];
}

/** Horloge simulée (Date uniquement) : permet d'avancer le temps pour le TOTP, les expirations et les limites de débit. */
export function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T10:00:00Z') });
}

export function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** Construit l'application avec des routes de test couvrant chaque option de sécurité par route. */
export async function buildTestApp(extra?: (app: FastifyInstance) => void): Promise<FastifyInstance> {
  const app = await buildApp();
  app.get('/api/test/protected', async (request) => ({ data: { user: request.auth?.user.username ?? null, client: request.client } }));
  app.get('/api/test/background', { config: { background: true } }, async () => ({ data: { ok: true } }));
  app.post('/api/test/mutate', async (request) => ({ data: { body: request.body ?? null } }));
  app.post('/api/test/critical', { config: { stepUp: true } }, async () => ({ data: { done: true } }));
  app.post('/api/test/webhook', { config: { public: true, skipCsrf: true, skipIpAllowlist: true } }, async () => ({ data: { received: true } }));
  app.get('/api/test/public', { config: { public: true } }, async (request) => ({ data: { authenticated: request.auth !== null } }));
  extra?.(app);
  await app.ready();
  return app;
}

let adminCounter = 0;

/** Crée un compte comme le fait la CLI (seul chemin de création existant). */
export async function createTestAdmin(username?: string): Promise<TestAdmin> {
  adminCounter += 1;
  const name = username ?? `admin${adminCounter}`;
  const email = `${name}@exemple.test`;
  const password = `Tr3s-Solide!Phrase-${adminCounter}-Zq`;
  const totpSecret = newTotpSecret();
  const { user, backupCodes } = await createAdmin({ username: name, email, password, totpSecret });
  return { user, username: name, email, password, totpSecret, backupCodes };
}

/** Code TOTP du pas courant (ou décalé de `offsetSteps` pas de 30 s). */
export function totpCode(secret: string, offsetSteps = 0): string {
  return generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSteps * 30 });
}

/** Avance l'horloge d'un pas TOTP puis retourne un code jamais utilisé. */
export function freshTotp(secret: string): string {
  advance(30_000);
  return totpCode(secret);
}

/** Dernier code (6 ou 8 chiffres) envoyé par mail à cette adresse, dont l'objet contient `subject`. */
export function mailedCode(email: string, subject: string): string {
  for (let i = outbox.length - 1; i >= 0; i -= 1) {
    const mail = outbox[i]!;
    const to = Array.isArray(mail.to) ? mail.to : [mail.to];
    if (to.length === 1 && to[0] === email && mail.subject.includes(subject)) {
      const match = /^ {4}(\d{6,8})$/m.exec(mail.text);
      if (match) return match[1]!;
    }
  }
  throw new Error(`Aucun mail « ${subject} » pour ${email}`);
}

export async function alertMails(titlePart: string) {
  await flushAlerts();
  return outbox.filter((mail) => mail.subject.includes(titlePart));
}

type Json = Record<string, unknown>;

export interface TestResponse<T = unknown> {
  status: number;
  body: { data: T; meta?: unknown } & Partial<ApiErrorBody>;
  errorCode: string | undefined;
  raw: LightMyRequestResponse;
}

/** Navigateur simulé : conserve les cookies, envoie Origin et le jeton CSRF comme le fait le frontend. */
export class Browser {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;
  country: string | null = null;

  constructor(
    private readonly app: FastifyInstance,
    public ip: string,
    public userAgent: string = CHROME_UA,
  ) {}

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
    url: string,
    options: { body?: Json; headers?: Record<string, string>; origin?: string | null; csrf?: string | null } = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { 'user-agent': this.userAgent };
    if (this.country) headers['cf-ipcountry'] = this.country;
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (mutating) {
      const origin = options.origin === undefined ? ORIGIN : options.origin;
      if (origin !== null) headers.origin = origin;
      const csrf = options.csrf === undefined ? this.csrfToken : options.csrf;
      if (csrf !== null) headers['x-csrf-token'] = csrf;
    }
    Object.assign(headers, options.headers);

    const inject: InjectOptions = { method, url, headers, remoteAddress: this.ip };
    if (options.body !== undefined) inject.payload = options.body;
    const raw = await this.app.inject(inject);

    for (const cookie of raw.cookies) {
      const expired = (cookie.expires && cookie.expires.getTime() <= Date.now()) || cookie.maxAge === 0 || cookie.value === '';
      if (expired) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }

    let body: TestResponse<T>['body'];
    try {
      body = raw.json();
    } catch {
      body = {} as TestResponse<T>['body'];
    }
    return { status: raw.statusCode, body, errorCode: body.error?.code, raw };
  }

  get = <T = unknown>(url: string, headers?: Record<string, string>) => this.request<T>('GET', url, { headers });
  post = <T = unknown>(url: string, body?: Json, options: { origin?: string | null; csrf?: string | null; headers?: Record<string, string> } = {}) =>
    this.request<T>('POST', url, { body: body ?? {}, ...options });
  put = <T = unknown>(url: string, body: Json) => this.request<T>('PUT', url, { body });
  delete = <T = unknown>(url: string) => this.request<T>('DELETE', url);

  /** Étape 1 puis étape 2 avec le code mail et un TOTP neuf. */
  async passwordAndSecondFactor(admin: TestAdmin): Promise<TestResponse<LoginStepResponse>> {
    const first = await this.post<LoginStepResponse>('/api/auth/login', { identifier: admin.username, password: admin.password });
    if (first.status !== 200) throw new Error(`étape 1 : ${first.status} ${first.errorCode}`);
    return this.post<LoginStepResponse>('/api/auth/login/verify', {
      emailCode: mailedCode(admin.email, 'Code de connexion'),
      totpCode: freshTotp(admin.totpSecret),
    });
  }

  /** Connexion complète, confirmation d'appareil comprise si elle est demandée. */
  async login(admin: TestAdmin): Promise<SessionState> {
    let step = await this.passwordAndSecondFactor(admin);
    if (step.status !== 200) throw new Error(`étape 2 : ${step.status} ${step.errorCode}`);
    if (step.body.data.step === 'device_confirmation') {
      step = await this.post<LoginStepResponse>('/api/auth/login/confirm-device', { code: mailedCode(admin.email, 'Confirmation de connexion') });
      if (step.status !== 200) throw new Error(`étape 3 : ${step.status} ${step.errorCode}`);
    }
    const session = step.body.data.session;
    if (step.body.data.step !== 'done' || !session?.csrfToken) throw new Error('connexion incomplète');
    this.csrfToken = session.csrfToken;
    return session;
  }

  async stepUp(admin: TestAdmin): Promise<TestResponse> {
    return this.post('/api/auth/step-up', { totpCode: freshTotp(admin.totpSecret) });
  }
}

let ipCounter = 0;
/** Adresse IP publique unique par appel (chaque scénario a ses propres compteurs de débit). */
export function uniqueIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyContextConfig, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../../config.js';
import { audit } from '../../core/audit.js';
import { safeEqual } from '../../core/crypto.js';
import { AppError, forbidden, rateLimited, stepUpRequired, unauthenticated } from '../../core/errors.js';
import { initGeo, lookupCountry } from '../../core/geo.js';
import { ipRateKey, isIpAllowed, normalizeIp } from './ip-allowlist.js';
import { ipBlockRemainingSeconds } from './lockout.js';
import { warmUpPasswordHasher } from './passwords.js';
import { bindRequestSession, clearSessionCookie, deviceIdFromRequest, purgeExpired, refreshRequestSession, resolveSession, SESSION_COOKIE, touchSession } from './sessions.js';
import { toAdminUser } from './users.js';

/** Limites de débit par appelant (IPv4, ou préfixe IPv6 /64). */
export const RATE_LIMITS = {
  /** Toutes requêtes confondues. */
  global: { max: 300, timeWindow: 60_000 },
  /** Requêtes modifiantes sous /api/auth/ (connexion, codes, step-up). */
  auth: { max: 10, timeWindow: 60_000 },
} as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_HOST = new URL(config.publicUrl).host.toLowerCase();

const PERMISSIONS_POLICY = [
  'accelerometer=()', 'autoplay=()', 'bluetooth=()', 'browsing-topics=()', 'camera=()', 'display-capture=()',
  'encrypted-media=()', 'fullscreen=(self)', 'geolocation=()', 'gyroscope=()', 'hid=()', 'idle-detection=()', 'magnetometer=()',
  'microphone=()', 'midi=()', 'payment=()', 'picture-in-picture=()', 'publickey-credentials-get=()', 'screen-wake-lock=()',
  'serial=()', 'usb=()', 'xr-spatial-tracking=()',
].join(', ');

// Journalisation modérée des rejets de liste blanche : une ligne par IP toutes les 10 minutes, et un plafond global.
const REJECT_LOG_INTERVAL_MS = 10 * 60_000;
const REJECT_LOG_GLOBAL_MAX = 30;
const rejectLog = new Map<string, { loggedAt: number; suppressed: number }>();
let rejectWindowStart = 0;
let rejectWindowCount = 0;

function auditAllowlistRejection(request: FastifyRequest): void {
  const now = Date.now();
  const key = ipRateKey(request.client.ip);
  const entry = rejectLog.get(key);
  if (entry && now - entry.loggedAt < REJECT_LOG_INTERVAL_MS && now >= entry.loggedAt) {
    entry.suppressed += 1;
    return;
  }
  if (now - rejectWindowStart >= REJECT_LOG_INTERVAL_MS || now < rejectWindowStart) {
    rejectWindowStart = now;
    rejectWindowCount = 0;
  }
  if (rejectWindowCount >= REJECT_LOG_GLOBAL_MAX) return;
  rejectWindowCount += 1;
  if (rejectLog.size > 2000) rejectLog.clear();
  rejectLog.set(key, { loggedAt: now, suppressed: 0 });
  audit(request, {
    action: 'security.ip_allowlist.rejected',
    target: request.client.ip,
    success: false,
    userId: null,
    details: { method: request.method, sinceLastEntry: entry?.suppressed ?? 0 },
  });
}

/**
 * Chemin d'une requête SANS route correspondante, normalisé pour le classer de façon prudente : sans chaîne de
 * requête, décodé (%xx) comme le fait le routeur, en minuscules, barres obliques regroupées. Un chemin
 * indécodable est rangé sous /api (traitement le plus strict).
 * Pour une route trouvée, ce chemin n'est JAMAIS utilisé : seul le motif déclaré de la route fait foi.
 */
function unmatchedPath(url: string): string {
  const q = url.indexOf('?');
  let path = q === -1 ? url : url.slice(0, q);
  try {
    for (let i = 0; i < 3 && path.includes('%'); i += 1) path = decodeURIComponent(path);
  } catch {
    return '/api/';
  }
  return path.toLowerCase().replace(/\/+/g, '/');
}

const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * Plugin de sécurité global (non encapsulé grâce à fastify-plugin) : il s'applique à TOUTES les routes,
 * y compris celles des autres modules et les routes inconnues. Sécurisé par défaut : une route ne déroge
 * que par sa configuration (`config.public`, `skipCsrf`, `skipIpAllowlist`, `stepUp`, `background`).
 *
 * Ordre des contrôles (tous dans `onRequest`, donc avant toute lecture du corps de la requête) :
 *   en-têtes → identification de l'appelant → Host / HTTPS (production) → liste blanche d'IP → limitation de débit
 *   → blocage d'IP sur l'authentification → session → CSRF → step-up.
 */
export default fp(
  async function securityPlugin(app: FastifyInstance): Promise<void> {
    app.decorateRequest('auth', null);
    app.decorateRequest('client', null as never);

    await initGeo((err) => app.log.warn({ err }, 'géolocalisation : base MaxMind illisible, pays inconnus'));
    warmUpPasswordHasher();

    await app.register(cookie);

    await app.register(helmet, {
      global: true,
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-src': ["'self'", 'blob:'],
          'worker-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      strictTransportSecurity: config.isProd ? { maxAge: 63_072_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      xFrameOptions: { action: 'deny' },
      xContentTypeOptions: true,
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      xDnsPrefetchControl: { allow: false },
      xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    });

    // Le greffon n'est pas global : les limites sont appliquées explicitement dans le hook ci-dessous, à la place
    // voulue dans l'ordre des contrôles, et couvrent aussi les routes inconnues.
    await app.register(rateLimit, { global: false });
    const globalLimiter = app.createRateLimit({ ...RATE_LIMITS.global });
    const authLimiter = app.createRateLimit({ ...RATE_LIMITS.auth });

    async function enforceRateLimit(limiter: typeof globalLimiter, request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const result = await limiter(request);
      if (!result.isAllowed && result.isExceeded) {
        reply.header('Retry-After', Math.max(1, result.ttlInSeconds));
        throw rateLimited();
      }
    }

    app.addHook('onRequest', async (request, reply) => {
      const method = request.method.toUpperCase();
      const mutating = !SAFE_METHODS.has(method);
      const matched = !request.is404;
      const routeConfig: FastifyContextConfig = (matched ? request.routeOptions.config : undefined) ?? {};
      const routeUrl = matched ? (request.routeOptions.url ?? '') : '';
      // Toute décision repose sur le MOTIF de la route trouvée (le routeur décode les %xx : l'URL brute est
      // manipulable — « /api/%61uth/login » atteint la route de connexion). L'URL n'est lue, normalisée, que
      // lorsqu'aucune route ne correspond.
      const path = matched ? routeUrl : unmatchedPath(request.url);
      const isApi = under(path, '/api');
      const isHealthProbe = matched && routeUrl === '/api/health' && (method === 'GET' || method === 'HEAD');

      // ── 0. En-têtes posés avant tout refus ──
      reply.header('Permissions-Policy', PERMISSIONS_POLICY);
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      if (isApi) reply.header('Cache-Control', 'no-store');

      // ── 1. Appelant ──
      const ip = normalizeIp(request.ip);
      request.client = {
        ip,
        // eslint-disable-next-line no-control-regex
        userAgent: (headerValue(request.headers['user-agent']) ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512),
        country: lookupCountry(ip, request.headers),
        deviceId: deviceIdFromRequest(request),
      };

      // ── 2. Production : hôte attendu et HTTPS obligatoires (sauf la sonde de santé locale de Docker) ──
      if (config.isProd && !isHealthProbe) {
        if ((request.host ?? '').toLowerCase() !== PUBLIC_HOST) throw forbidden('Hôte non autorisé');
        if (request.protocol !== 'https') {
          if (method === 'GET' || method === 'HEAD') {
            const target = request.url.startsWith('/') ? request.url : '/';
            return reply.redirect(`${config.publicUrl}${target}`, 308);
          }
          throw forbidden('HTTPS requis');
        }
      }

      // ── 3. Liste blanche d'IP ──
      if (routeConfig.skipIpAllowlist !== true && !isIpAllowed(ip)) {
        auditAllowlistRejection(request);
        throw new AppError(403, 'IP_NOT_ALLOWED', 'Adresse IP non autorisée');
      }

      // ── 4. Limitation de débit ──
      const isAuthMutation = mutating && under(path, '/api/auth');
      if (!isHealthProbe) await enforceRateLimit(globalLimiter, request, reply);
      if (isAuthMutation) await enforceRateLimit(authLimiter, request, reply);

      // ── 5. IP bloquée après trop d'échecs d'authentification (la déconnexion reste possible) ──
      if (isAuthMutation && routeUrl !== '/api/auth/logout') {
        const blocked = ipBlockRemainingSeconds(ip);
        if (blocked > 0) {
          reply.header('Retry-After', blocked);
          throw rateLimited("Trop d'échecs d'authentification depuis cette adresse, réessayez plus tard");
        }
      }

      // ── 6. Session ──
      const now = Date.now();
      const sessionToken = request.cookies?.[SESSION_COOKIE];
      const resolved = resolveSession(sessionToken, now);
      if (resolved) {
        // L'activité n'est PAS enregistrée ici : seule une requête qui a passé tous les contrôles prolonge la
        // session (voir le hook preHandler).
        bindRequestSession(request, resolved.row);
        request.auth = { user: toAdminUser(resolved.user), sessionId: resolved.row.id, stepUpUntil: resolved.row.step_up_until };
      } else {
        request.auth = null;
        if (sessionToken !== undefined && isApi) clearSessionCookie(reply);
      }

      // Par défaut, toute route /api (connue ou non) et toute route modifiante exigent une session.
      const isPublic = matched && routeConfig.public === true;
      const requiresSession = (isApi || (matched && mutating)) && !isPublic;
      if (requiresSession && !request.auth) throw unauthenticated();

      // ── 7. CSRF : Origin exacte pour toute requête modifiante, et jeton de session si authentifiée ──
      if (mutating && routeConfig.skipCsrf !== true) {
        const origin = headerValue(request.headers.origin);
        if (origin !== config.publicUrl) {
          if (request.auth) audit(request, { action: 'security.csrf.rejected', target: routeUrl || null, success: false, details: { reason: 'origin' } });
          throw new AppError(403, 'CSRF_INVALID', 'Origine de la requête refusée');
        }
        if (!isPublic) {
          const session = resolved?.row;
          const sent = headerValue(request.headers['x-csrf-token']);
          if (!session || typeof sent !== 'string' || sent.length === 0 || !safeEqual(sent, session.csrf_token)) {
            audit(request, { action: 'security.csrf.rejected', target: routeUrl || null, success: false, details: { reason: 'token' } });
            throw new AppError(403, 'CSRF_INVALID', 'Jeton CSRF manquant ou invalide');
          }
        }
      }

      // ── 8. Step-up ──
      if (routeConfig.stepUp === true) {
        if (!request.auth) throw unauthenticated();
        if (!request.auth.stepUpUntil || request.auth.stepUpUntil <= now) throw stepUpRequired();
      }
    });

    /**
     * Revalidation juste avant le gestionnaire : la lecture du corps de la requête est asynchrone, donc la session
     * a pu être révoquée (ou sa fenêtre de step-up fermée) depuis le contrôle fait dans onRequest — cas de
     * requêtes envoyées en rafale pendant qu'un verrouillage survient.
     */
    app.addHook('preHandler', async (request, reply) => {
      if (!request.auth) return;
      const session = refreshRequestSession(request);
      if (!session) {
        request.auth = null;
        clearSessionCookie(reply);
        throw unauthenticated();
      }
      request.auth.stepUpUntil = session.step_up_until;
      const routeConfig: FastifyContextConfig = (request.is404 ? undefined : request.routeOptions.config) ?? {};
      if (routeConfig.stepUp === true && (!session.step_up_until || session.step_up_until <= Date.now())) throw stepUpRequired();

      // Tous les contrôles sont passés : la requête prolonge la session, sauf
      //  - requête d'arrière-plan (route `background`, en-tête X-TC-Background: 1) : l'inactivité reste effective ;
      //  - requête que le navigateur déclare émise par un autre site ou sous-domaine (Sec-Fetch-Site ≠ same-origin /
      //    none) : SameSite=Strict laisse passer le cookie entre sous-domaines d'un même site, mais une page tierce
      //    ne doit pas pouvoir garder une session inactive en vie.
      const background = routeConfig.background === true || headerValue(request.headers['x-tc-background']) === '1';
      const fetchSite = headerValue(request.headers['sec-fetch-site']);
      const foreign = fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none';
      if (!background && !foreign) touchSession(session, Date.now());
    });

    // Ménage périodique (sessions et challenges expirés, anciens échecs).
    const safePurge = () => {
      try {
        purgeExpired();
      } catch (err) {
        app.log.error({ err }, 'auth: ménage impossible');
      }
    };
    safePurge();
    const timer = setInterval(safePurge, 10 * 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'talcloud-security', fastify: '5.x' },
);

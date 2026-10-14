import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OrderNotificationData, PanelNotification } from '@shared/api-types';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { securityAlert } from '../../core/alerts.js';
import { audit } from '../../core/audit.js';
import { AppError } from '../../core/errors.js';
import { db, transaction } from '../../db/index.js';
import { ipMatchesEntries, ipRateKey } from '../auth/ip-allowlist.js';
import { formatAmount, oneLine } from './format.js';
import { dispatchNotification } from './service.js';
import { getNotificationSettings, receivingAccountFor } from './settings.js';
import { insertNotification } from './store.js';

export const WEBHOOK_PATH = '/api/webhooks/whmcs';
/** Un évènement WHMCS tient en quelques centaines d'octets ; tout corps plus gros est refusé avant lecture complète. */
export const WEBHOOK_BODY_LIMIT = 16 * 1024;
/** Écart maximal accepté entre l'horodatage signé et l'horloge du serveur. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_RATE_LIMIT = { max: 60, timeWindow: 60_000 } as const;
/** Durée de conservation des identifiants d'évènements (idempotence). Bien au-delà de la tolérance d'horodatage. */
export const WEBHOOK_EVENT_RETENTION_MS = 90 * 24 * 3600_000;

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Charge utile du hook WHMCS. Validation stricte (aucun champ inconnu) et chaînes bornées.
 * Ces valeurs sont NON FIABLES (saisies par des clients) : elles sont stockées telles quelles et jamais interprétées.
 */
export const whmcsWebhookSchema = z.strictObject({
  eventId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  event: z.enum(['order_created', 'invoice_paid', 'order_paid']),
  orderId: positiveId.optional(),
  invoiceId: positiveId.optional(),
  clientId: positiveId.optional(),
  clientName: z.string().min(1).max(200),
  clientEmail: z.string().min(1).max(254).optional(),
  products: z.array(z.string().min(1).max(200)).max(50),
  amount: z.number().min(0).max(1_000_000_000),
  currency: z
    .string()
    .min(1)
    .max(8)
    .regex(/^[A-Za-z0-9]+$/),
  gateway: z.string().min(1).max(64).optional(),
  gatewayName: z.string().min(1).max(120).optional(),
  transactionId: z.string().min(1).max(128).optional(),
});

export type WhmcsWebhookInput = z.infer<typeof whmcsWebhookSchema>;

const TITLES: Record<WhmcsWebhookInput['event'], string> = {
  order_created: 'Nouvelle commande',
  invoice_paid: 'Paiement reçu',
  order_paid: 'Commande payée',
};

/** Construit la notification (titre, corps, données) d'un évènement WHMCS. */
export function buildOrderNotification(
  payload: WhmcsWebhookInput,
  gatewayAccounts: Record<string, string>,
): { type: 'order' | 'payment'; severity: 'info' | 'success'; title: string; body: string; data: OrderNotificationData } {
  const receivingAccount = receivingAccountFor(payload.gateway, gatewayAccounts);
  const data: OrderNotificationData = {
    event: payload.event,
    ...(payload.orderId !== undefined ? { orderId: payload.orderId } : {}),
    ...(payload.invoiceId !== undefined ? { invoiceId: payload.invoiceId } : {}),
    ...(payload.clientId !== undefined ? { clientId: payload.clientId } : {}),
    clientName: payload.clientName,
    ...(payload.clientEmail !== undefined ? { clientEmail: payload.clientEmail } : {}),
    products: payload.products,
    amount: payload.amount,
    currency: payload.currency,
    gateway: payload.gateway ?? null,
    gatewayName: payload.gatewayName ?? null,
    receivingAccount,
    ...(payload.transactionId !== undefined ? { transactionId: payload.transactionId } : {}),
  };

  const shown = payload.products.slice(0, 3).map((product) => oneLine(product, 80));
  if (payload.products.length > shown.length) shown.push(`+${payload.products.length - shown.length}`);
  const gatewayLabel = oneLine(payload.gatewayName ?? payload.gateway ?? '', 60);
  const payment = gatewayLabel && receivingAccount ? `${gatewayLabel} → ${oneLine(receivingAccount, 80)}` : gatewayLabel;

  return {
    type: payload.event === 'order_created' ? 'order' : 'payment',
    severity: payload.event === 'order_created' ? 'info' : 'success',
    title: `${TITLES[payload.event]} — ${oneLine(payload.clientName, 120)}`,
    body: [shown.join(', '), formatAmount(payload.amount, payload.currency), payment].filter(Boolean).join(' · '),
    data,
  };
}

export type SignatureFailure = 'malformed' | 'signature' | 'timestamp';

/**
 * Vérifie `X-TalCloud-Signature: sha256=<hex>` = HMAC-SHA256(secret, `${timestamp}.${corps brut}`) sur les octets
 * reçus, à temps constant, puis la fraîcheur de l'horodatage. Retourne null si tout est valide.
 */
export function verifyWebhookSignature(secret: string, timestampHeader: unknown, signatureHeader: unknown, rawBody: Buffer, nowMs = Date.now()): SignatureFailure | null {
  const timestamp = typeof timestampHeader === 'string' && /^\d{1,12}$/.test(timestampHeader) ? timestampHeader : null;
  const match = typeof signatureHeader === 'string' ? /^sha256=([0-9a-fA-F]{64})$/.exec(signatureHeader) : null;
  // Le HMAC est calculé dans tous les cas : la durée du traitement ne dépend pas de la forme des en-têtes.
  const expected = createHmac('sha256', secret)
    .update(`${timestamp ?? ''}.`, 'utf8')
    .update(rawBody)
    .digest();
  const provided = match ? Buffer.from(match[1]!, 'hex') : Buffer.alloc(expected.length);
  const equal = provided.length === expected.length && timingSafeEqual(expected, provided);
  if (timestamp === null || match === null) return 'malformed';
  if (!equal) return 'signature';
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return 'timestamp';
  return null;
}

// ── Journalisation modérée des refus : une entrée par appelant toutes les 10 minutes, plafond global ──
const REJECT_LOG_INTERVAL_MS = 10 * 60_000;
const REJECT_LOG_GLOBAL_MAX = 20;
const rejectLog = new Map<string, { loggedAt: number; suppressed: number }>();
let rejectWindowStart = 0;
let rejectWindowCount = 0;

function recordRejection(request: FastifyRequest, reason: 'ip' | SignatureFailure): void {
  const now = Date.now();
  const key = `${reason}:${ipRateKey(request.client.ip)}`;
  const entry = rejectLog.get(key);
  if (entry && now >= entry.loggedAt && now - entry.loggedAt < REJECT_LOG_INTERVAL_MS) {
    entry.suppressed += 1;
  } else {
    if (now - rejectWindowStart >= REJECT_LOG_INTERVAL_MS || now < rejectWindowStart) {
      rejectWindowStart = now;
      rejectWindowCount = 0;
    }
    if (rejectWindowCount < REJECT_LOG_GLOBAL_MAX) {
      rejectWindowCount += 1;
      if (rejectLog.size > 2000) rejectLog.clear();
      rejectLog.set(key, { loggedAt: now, suppressed: 0 });
      audit(request, {
        action: 'notifications.webhook.rejected',
        target: request.client.ip,
        success: false,
        userId: null,
        details: { reason, sinceLastEntry: entry?.suppressed ?? 0 },
      });
    }
  }

  // Alerte seulement pour ce qu'un simple balayage d'Internet ne produit pas : une signature bien formée mais
  // fausse (mauvais secret, corps altéré) ou une signature VALIDE avec un horodatage périmé (rejeu, horloge décalée).
  if (reason === 'signature' || reason === 'timestamp') {
    securityAlert({
      kind: 'suspicious_activity',
      severity: 'warning',
      title: 'Webhook WHMCS : requête refusée',
      summary:
        reason === 'timestamp'
          ? 'Une requête correctement signée mais périmée a été refusée par le webhook WHMCS (rejeu possible, ou horloge du serveur WHMCS décalée).'
          : 'Une requête dont la signature est incorrecte a été refusée par le webhook WHMCS (secret différent entre WHMCS et le panel, ou tentative de falsification).',
      facts: [
        ['Adresse IP', request.client.ip],
        ['Pays', request.client.country],
      ],
      throttleKey: `whmcs-webhook:${reason}`,
      throttleMs: 60 * 60_000,
    });
  }
}

/** Tests uniquement. */
export function resetWebhookRejectionLog(): void {
  rejectLog.clear();
  rejectWindowStart = 0;
  rejectWindowCount = 0;
}

/** Réponse d'échec unique : même statut et même corps quelle que soit la cause (IP, en-têtes, signature, horodatage). */
const rejected = () => new AppError(401, 'UNAUTHENTICATED', 'Requête refusée');

const sendError = (reply: FastifyReply, status: number, code: AppError['code'], message: string) => reply.status(status).send({ error: { code, message } });

export function purgeWebhookEvents(now = Date.now()): number {
  return db.prepare('DELETE FROM webhook_events WHERE received_at < ?').run(now - WEBHOOK_EVENT_RETENTION_MS).changes;
}

/**
 * Enregistre la route publique du webhook dans un contexte ENCAPSULÉ : son analyseur de corps (octets bruts,
 * taille limitée) et son gestionnaire d'erreurs ne s'appliquent à aucune autre route.
 */
export async function registerWhmcsWebhook(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    const limiter = scope.createRateLimit({ ...WEBHOOK_RATE_LIMIT, keyGenerator: (request) => ipRateKey(request.client?.ip ?? request.ip) });

    // Le corps est conservé tel que reçu : la signature porte sur ces octets, pas sur une réinterprétation du JSON.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => done(null, body));

    // Échecs uniformes : hors « désactivé » (404), « trop de requêtes » (429) et charge utile invalide d'un appelant
    // AUTHENTIFIÉ (400), tout refus — y compris corps trop gros ou type de contenu inattendu — répond le même 401.
    scope.setErrorHandler((err: FastifyError | AppError, request, reply) => {
      const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
      if (err instanceof AppError && (status === 404 || status === 429 || status === 400)) return sendError(reply, status, err.code, err.message);
      if (status === 429) return sendError(reply, 429, 'RATE_LIMITED', 'Trop de requêtes, réessayez plus tard');
      if (status >= 500) {
        request.log.error({ err }, 'webhook WHMCS : erreur non gérée');
        return sendError(reply, 500, 'INTERNAL', 'Erreur interne');
      }
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Requête refusée');
    });

    scope.post(
      WEBHOOK_PATH,
      {
        // Seule route publique hors connexion : authentifiée par signature HMAC, filtrée par sa propre liste d'IP.
        config: { public: true, skipCsrf: true, skipIpAllowlist: true },
        bodyLimit: WEBHOOK_BODY_LIMIT,
        // Contrôles faits AVANT la lecture du corps.
        onRequest: async (request, reply) => {
          // Fonction désactivée tant qu'aucun secret n'est configuré.
          if (!config.whmcsHookSecret) throw new AppError(404, 'NOT_FOUND', 'Ressource introuvable');
          const limit = await limiter(request);
          if (!limit.isAllowed && limit.isExceeded) {
            reply.header('Retry-After', Math.max(1, limit.ttlInSeconds));
            throw new AppError(429, 'RATE_LIMITED', 'Trop de requêtes, réessayez plus tard');
          }
          if (config.whmcsHookIps.length > 0 && !ipMatchesEntries(request.client.ip, config.whmcsHookIps)) {
            recordRejection(request, 'ip');
            throw rejected();
          }
        },
      },
      async (request) => {
        const secret = config.whmcsHookSecret;
        if (!secret) throw new AppError(404, 'NOT_FOUND', 'Ressource introuvable');

        // 1. Signature sur les octets bruts, AVANT toute analyse du contenu.
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const failure = verifyWebhookSignature(secret, request.headers['x-talcloud-timestamp'], request.headers['x-talcloud-signature'], raw);
        if (failure) {
          recordRejection(request, failure);
          throw rejected();
        }

        // 2. L'appelant est authentifié : analyse et validation stricte.
        let payload: WhmcsWebhookInput;
        try {
          const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
          payload = whmcsWebhookSchema.parse(json);
        } catch {
          audit(request, { action: 'notifications.webhook.invalid', success: false, userId: null });
          throw new AppError(400, 'VALIDATION_ERROR', 'Charge utile invalide');
        }

        // 3. Idempotence / anti-rejeu : l'évènement et sa notification sont enregistrés dans la même transaction.
        const settings = getNotificationSettings();
        const wanted = payload.event === 'order_created' ? settings.notifyOrders : settings.notifyPayments;
        const outcome = transaction((): { duplicate: boolean; notification: PanelNotification | null } => {
          const inserted = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, source, received_at) VALUES (?, ?, ?)').run(payload.eventId, 'whmcs', Date.now());
          if (inserted.changes === 0) return { duplicate: true, notification: null };
          if (!wanted) return { duplicate: false, notification: null };
          return { duplicate: false, notification: insertNotification(buildOrderNotification(payload, settings.gatewayAccounts)) };
        });

        if (!outcome.duplicate) {
          audit(request, { action: 'notifications.webhook.received', target: payload.eventId, userId: null, details: { event: payload.event, notified: outcome.notification !== null } });
        }
        // Discord et push partent en arrière-plan : WHMCS reçoit sa réponse sans attendre le réseau.
        if (outcome.notification) dispatchNotification(outcome.notification, { userId: null, channels: { discord: true, push: true } });

        return { data: { received: true } };
      },
    );
  });
}

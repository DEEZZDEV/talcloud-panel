import type { PanelNotification, PushPublicKey, PushSubscriptionInfo, SettingsTestResult, UnreadCount, UserPreferences } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { badRequest, notFound, unauthenticated } from '../../core/errors.js';
import { currentUser } from '../../core/request.js';
import { registerSettingsRoutes } from '../../core/settings-routes.js';
import { sendDiscordTest } from './discord.js';
import { deviceLabel } from '../auth/device.js';
import { requestSession } from '../auth/sessions.js';
import {
  getVapidPublicKey,
  listPushSubscriptions,
  pushSubscribeSchema,
  pushUnsubscribeSchema,
  removePushSubscriptionById,
  removeSubscription,
  saveSubscription,
  sendTestPush,
} from './push.js';
import { getPreferences, preferencesUpdateSchema, updatePreferences } from './preferences.js';
import { flushNotifications } from './service.js';
import { notificationSettingsSchema, SETTINGS_NAMESPACE, type NotificationSettings } from './settings.js';
import { closeAllStreams, EventStream } from './sse.js';
import { listNotifications, markAllRead, markRead, purgeNotifications, unreadCount } from './store.js';
import { purgeWebhookEvents, registerWhmcsWebhook } from './webhook.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(['order', 'payment', 'security', 'system']).optional(),
  unread: z.enum(['0', '1', 'true', 'false']).optional(),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

const PURGE_INTERVAL_MS = 6 * 3600_000;

/** Hôte du service push, seul élément d'un point de terminaison qui puisse figurer dans le journal. */
function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname.slice(0, 100);
  } catch {
    return null;
  }
}

export default async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  // ── Réglages (Discord, types d'évènements, comptes par passerelle) ──
  registerSettingsRoutes<NotificationSettings>(app, {
    namespace: SETTINGS_NAMESPACE,
    schema: notificationSettingsSchema,
    secretFields: ['discordWebhookUrl'],
    isConfigured: (settings) => typeof settings.discordWebhookUrl === 'string' && settings.discordWebhookUrl.length > 0,
    test: async (settings): Promise<SettingsTestResult> => {
      await sendDiscordTest(settings.discordWebhookUrl ?? '');
      return { ok: true, message: 'Message d’essai envoyé sur Discord' };
    },
  });

  // ── Webhook WHMCS (seule route publique hors connexion) ──
  await registerWhmcsWebhook(app);

  // ── Centre de notifications ──
  app.get('/api/notifications', async (request) => {
    const user = currentUser(request);
    const query = listQuerySchema.parse(request.query);
    const { items, total } = listNotifications({
      userId: user.id,
      type: query.type,
      unreadOnly: query.unread === '1' || query.unread === 'true',
      page: query.page,
      pageSize: query.pageSize,
    });
    return { data: items satisfies PanelNotification[], meta: { page: query.page, pageSize: query.pageSize, total } };
  });

  app.get('/api/notifications/unread-count', { config: { background: true } }, async (request): Promise<{ data: UnreadCount }> => {
    return { data: { count: unreadCount(currentUser(request).id) } };
  });

  app.post('/api/notifications/read-all', async (request) => {
    const marked = markAllRead(currentUser(request).id);
    audit(request, { action: 'notifications.read_all', details: { marked } });
    return { data: { marked } };
  });

  app.post('/api/notifications/:id/read', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const changed = markRead(currentUser(request).id, id);
    // Notification inexistante ou destinée à l'autre administrateur : même réponse.
    if (changed === null) throw notFound('Notification introuvable');
    if (changed) audit(request, { action: 'notifications.read', target: `notification #${id}` });
    return { data: { id, read: true } };
  });

  // ── Préférences du compte connecté (aucun identifiant en paramètre : impossible d'atteindre celles de l'autre) ──
  app.get('/api/me/preferences', async (request): Promise<{ data: UserPreferences }> => ({ data: getPreferences(currentUser(request).id) }));

  // Préférences de confort : session et CSRF comme toute route, sans step-up.
  app.put('/api/me/preferences', async (request): Promise<{ data: UserPreferences }> => {
    const user = currentUser(request);
    const parsed = preferencesUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      audit(request, { action: 'preferences.update', success: false });
      throw parsed.error;
    }
    const data = updatePreferences(user.id, parsed.data);
    // Seuls les noms des sections modifiées sont journalisés.
    audit(request, { action: 'preferences.update', details: { fields: Object.keys(parsed.data) } });
    return { data };
  });

  // ── Push navigateur ──
  app.get('/api/push/public-key', async (): Promise<{ data: PushPublicKey }> => ({ data: { publicKey: getVapidPublicKey() } }));

  // Abonner un navigateur ouvre un canal qui survit à la session : step-up exigé, et l'abonnement est lié à
  // l'appareil de la session (retiré à sa déconnexion, à l'oubli de l'appareil, aux changements de secrets…).
  app.post('/api/push/subscribe', { config: { stepUp: true } }, async (request) => {
    const user = currentUser(request);
    const subscription = pushSubscribeSchema.parse(request.body);
    const session = requestSession(request);
    const deviceId = session?.device_id ?? null;
    if (!session || !deviceId || request.client.deviceId !== deviceId) {
      audit(request, { action: 'notifications.push.subscribe', target: endpointHost(subscription.endpoint), success: false, details: { reason: 'no_device' } });
      throw badRequest('Appareil non identifié : reconnectez-vous depuis ce navigateur pour activer les notifications push');
    }
    saveSubscription({ userId: user.id, deviceId, sessionId: session.id }, subscription, request.client.userAgent || null);
    audit(request, { action: 'notifications.push.subscribe', target: endpointHost(subscription.endpoint) });
    return { data: { subscribed: true } };
  });

  app.get('/api/push/subscriptions', async (request): Promise<{ data: PushSubscriptionInfo[] }> => {
    const user = currentUser(request);
    const currentDevice = requestSession(request)?.device_id ?? null;
    return {
      data: listPushSubscriptions(user.id).map((row) => ({
        id: row.id,
        deviceLabel: deviceLabel(row.user_agent),
        createdAt: new Date(row.created_at).toISOString(),
        current: currentDevice !== null && row.device_id === currentDevice,
      })),
    };
  });

  app.delete('/api/push/subscriptions/:id', { config: { stepUp: true } }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    // Abonnement inexistant ou appartenant à l'autre administrateur : même réponse.
    if (!removePushSubscriptionById(user.id, id)) {
      audit(request, { action: 'notifications.push.remove', target: `abonnement push #${id}`, success: false });
      throw notFound('Abonnement introuvable');
    }
    audit(request, { action: 'notifications.push.remove', target: `abonnement push #${id}` });
    return { data: { ok: true } };
  });

  app.post('/api/push/unsubscribe', async (request) => {
    const user = currentUser(request);
    const { endpoint } = pushUnsubscribeSchema.parse(request.body);
    const removed = removeSubscription(user.id, endpoint);
    if (removed) audit(request, { action: 'notifications.push.unsubscribe', target: endpointHost(endpoint) });
    return { data: { subscribed: false, removed } };
  });

  app.post('/api/push/test', async (request): Promise<{ data: SettingsTestResult }> => {
    const result = await sendTestPush(currentUser(request).id);
    const total = result.sent + result.failed + result.removed;
    const data: SettingsTestResult =
      total === 0
        ? { ok: false, message: 'Aucun appareil abonné aux notifications push pour ce compte' }
        : result.sent > 0
          ? { ok: true, message: `Notification d’essai envoyée à ${result.sent} appareil(s)` }
          : { ok: false, message: 'Échec de l’envoi : abonnement expiré ou service push injoignable' };
    audit(request, { action: 'notifications.push.test', success: data.ok, details: { sent: result.sent, failed: result.failed, removed: result.removed } });
    return { data };
  });

  // ── Flux temps réel (Server-Sent Events) ──
  // La réponse passe par reply.send(flux) et non par reply.raw / reply.hijack() : les en-têtes de sécurité posés
  // par les hooks (CSP, HSTS, nosniff…) sont donc bien envoyés. `background` : le flux ne prolonge pas la session.
  app.get('/api/events', { config: { background: true } }, (request, reply) => {
    if (!request.auth) throw unauthenticated();
    const events = new EventStream({ userId: request.auth.user.id, sessionId: request.auth.sessionId });
    // Connexion fermée par le client ou le serveur : désabonnement immédiat.
    reply.raw.on('close', () => events.close());
    return reply
      .header('Content-Type', 'text/event-stream; charset=utf-8')
      .header('Cache-Control', 'no-store, no-transform')
      .header('X-Accel-Buffering', 'no')
      .send(events.stream);
  });

  // ── Ménage périodique et arrêt propre ──
  const purge = () => {
    try {
      purgeNotifications();
      purgeWebhookEvents();
    } catch (err) {
      app.log.error({ err }, 'notifications : ménage impossible');
    }
  };
  purge();
  const timer = setInterval(purge, PURGE_INTERVAL_MS);
  timer.unref();
  // Les flux ouverts sont fermés AVANT l'arrêt du serveur HTTP, qui attendrait sinon indéfiniment leur fin.
  app.addHook('preClose', async () => closeAllStreams());
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await flushNotifications();
  });
}

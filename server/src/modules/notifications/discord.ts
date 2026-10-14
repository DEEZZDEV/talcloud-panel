import type { NotificationSeverity, PanelNotification } from '@shared/api-types';
import { upstream } from '../../core/errors.js';
import { upstreamFetch } from '../../core/http.js';
import { formatAmount } from './format.js';
import { getNotificationSettings, parseDiscordWebhookUrl } from './settings.js';

const COLORS: Record<NotificationSeverity, number> = { info: 0x3b82f6, success: 0x22c55e, warning: 0xf59e0b, critical: 0xef4444 };

// Limites de l'API Discord : titre 256, description 4096, nom de champ 256, valeur de champ 1024.
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 2000;
const FIELD_VALUE_MAX = 1000;

export { discordText } from '../../core/discord-text.js';
import { discordText } from '../../core/discord-text.js';

interface Embed {
  title: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline: boolean }[];
  footer: { text: string };
  timestamp: string;
}

export interface DiscordMessage {
  username: string;
  allowed_mentions: { parse: [] };
  embeds: Embed[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Construit le message Discord d'une notification. Toute valeur affichée passe par `discordText`. */
export function buildDiscordMessage(notification: PanelNotification): DiscordMessage {
  const embed: Embed = {
    title: discordText(notification.title, TITLE_MAX) || 'Notification',
    color: COLORS[notification.severity] ?? COLORS.info,
    footer: { text: 'TalCloud Panel' },
    timestamp: notification.createdAt,
  };

  const data = notification.data;
  const isOrder = (notification.type === 'order' || notification.type === 'payment') && isRecord(data) && typeof data.clientName === 'string';
  if (isOrder && isRecord(data)) {
    const field = (name: string, value: unknown, inline = true) => ({ name, value: discordText(value, FIELD_VALUE_MAX) || '—', inline });
    const products = Array.isArray(data.products) ? data.products.filter((p): p is string => typeof p === 'string').slice(0, 10) : [];
    const amount = typeof data.amount === 'number' && typeof data.currency === 'string' ? formatAmount(data.amount, data.currency) : null;
    const references: string[] = [];
    if (typeof data.orderId === 'number') references.push(`Commande n° ${data.orderId}`);
    if (typeof data.invoiceId === 'number') references.push(`Facture n° ${data.invoiceId}`);
    if (typeof data.transactionId === 'string' && data.transactionId) references.push(`Transaction ${data.transactionId}`);

    embed.fields = [
      field('Client', data.clientName),
      field('Montant', amount ?? '—'),
      field(products.length > 1 ? 'Produits' : 'Produit', products.join(', ') || '—', false),
      field('Moyen de paiement', data.gatewayName || data.gateway || 'Non précisé'),
      field('Compte', data.receivingAccount || 'Non renseigné'),
    ];
    if (references.length) embed.fields.push(field('Références', references.join(' · '), false));
  } else {
    embed.description = discordText(notification.body, DESCRIPTION_MAX);
  }

  return {
    username: 'TalCloud Panel',
    // Aucune mention (@everyone, @here, rôle, utilisateur) ne peut être déclenchée par le contenu.
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };
}

/** Envoie un message sur un webhook Discord. L'URL est revalidée à chaque envoi ; elle n'apparaît dans aucune erreur. */
export async function postDiscord(webhookUrl: string, message: DiscordMessage): Promise<void> {
  const url = parseDiscordWebhookUrl(webhookUrl);
  if (url === null) throw upstream('notifications', 'URL de webhook Discord invalide');
  const res = await upstreamFetch('notifications', url, {
    method: 'POST',
    timeoutMs: 8000,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw upstream('notifications', `Discord a répondu avec le statut ${res.status}`, { status: res.status });
}

/** Envoi d'une notification sur Discord si le canal est activé et configuré. Retourne false s'il ne l'est pas. */
export async function sendDiscordNotification(notification: PanelNotification): Promise<boolean> {
  const settings = getNotificationSettings();
  if (!settings.discordEnabled || !settings.discordWebhookUrl) return false;
  await postDiscord(settings.discordWebhookUrl, buildDiscordMessage(notification));
  return true;
}

export async function sendDiscordTest(webhookUrl: string): Promise<void> {
  await postDiscord(webhookUrl, {
    username: 'TalCloud Panel',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: 'Message d’essai',
        description: 'Le webhook Discord du panel est correctement configuré.',
        color: COLORS.success,
        footer: { text: 'TalCloud Panel' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

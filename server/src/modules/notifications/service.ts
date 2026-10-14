import type { NotificationSeverity, NotificationType, PanelNotification } from '@shared/api-types';
import { config } from '../../config.js';
import { AppError } from '../../core/errors.js';
import { publish } from '../../core/events.js';
import { sendDiscordNotification } from './discord.js';
import { sendPushForNotification } from './push.js';
import { insertNotification } from './store.js';

/**
 * Interface publique du module notifications pour les autres modules.
 * La signature est figée : seul le corps est à implémenter.
 */
export interface NotifyInput {
  type: NotificationType;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  /** Données JSON affichables. JAMAIS de secret. */
  data?: Record<string, unknown> | null;
  /** Destinataire unique ; absent = les deux administrateurs. */
  userId?: number | null;
  /** Canaux externes en plus du centre de notifications et du flux temps réel (défaut : aucun). */
  channels?: { discord?: boolean; push?: boolean };
}

const pending = new Set<Promise<void>>();

// Seule la nature de l'échec est journalisée : jamais l'URL du webhook, un point de terminaison push ou un contenu.
function logFailure(what: string, err: unknown): void {
  if (config.isTest) return;
  // Message d'une AppError : rédigé par nous, sans donnée sensible. Toute autre erreur : son seul type.
  const reason = err instanceof AppError ? err.message : err instanceof Error ? err.name : 'erreur inconnue';
  console.error(`[notifications] ${what} : ${reason}`);
}

/**
 * Diffuse une notification déjà enregistrée : flux temps réel immédiatement, puis Discord / push en arrière-plan
 * (l'appelant n'attend jamais le réseau). Ne lève pas.
 */
export function dispatchNotification(notification: PanelNotification, target: { userId?: number | null; channels?: NotifyInput['channels'] }): void {
  const userId = target.userId ?? null;
  try {
    publish(userId === null ? { event: { type: 'notification', notification } } : { event: { type: 'notification', notification }, userId });
  } catch (err) {
    logFailure('diffusion temps réel impossible', err);
  }

  const tasks: Promise<unknown>[] = [];
  if (target.channels?.discord) {
    tasks.push(
      Promise.resolve()
        .then(() => sendDiscordNotification(notification))
        .catch((err: unknown) => logFailure('envoi Discord impossible', err)),
    );
  }
  if (target.channels?.push) {
    tasks.push(
      Promise.resolve()
        .then(() => sendPushForNotification(notification, userId))
        .catch((err: unknown) => logFailure('envoi push impossible', err)),
    );
  }
  if (tasks.length === 0) return;
  const task: Promise<void> = Promise.allSettled(tasks).then(() => {
    pending.delete(task);
  });
  pending.add(task);
}

/**
 * Crée une notification dans le panel, la diffuse en temps réel (SSE) et, selon `channels`, sur Discord / push.
 * Ne lève jamais d'exception.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    const notification = insertNotification(input);
    dispatchNotification(notification, input);
  } catch (err) {
    logFailure('enregistrement impossible', err);
  }
}

/** Attend la fin des envois Discord / push en cours (arrêt propre, tests). */
export async function flushNotifications(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

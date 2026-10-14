import type { NotificationSeverity } from '@shared/api-types';
import { discordText } from './discord-text.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { notify } from '../modules/notifications/service.js';
import { upstreamFetch } from './http.js';
import { renderMail, sendMail } from './mailer.js';

export type SecurityAlertKind =
  | 'login_success'
  | 'login_failed'
  | 'account_locked'
  | 'suspicious_activity'
  | 'password_changed'
  | 'totp_changed'
  | 'backup_codes_regenerated'
  | 'ip_allowlist_changed'
  | 'sessions_revoked'
  | 'settings_changed'
  | 'admin_cli';

export interface SecurityAlert {
  kind: SecurityAlertKind;
  severity?: NotificationSeverity;
  /** Objet du mail / titre de la notification. */
  title: string;
  /** Phrase d'explication. */
  summary: string;
  /** Détails affichés (IP, pays, navigateur…). JAMAIS de secret ni de code. Les valeurs sont échappées. */
  facts?: [label: string, value: string | null | undefined][];
  /** Compte concerné (information ; l'alerte est toujours adressée aux deux administrateurs). */
  userId?: number | null;
  /**
   * Regroupement : au plus une alerte par clé et par `throttleMs` (défaut 10 min). À utiliser pour tout
   * évènement qu'un tiers peut provoquer à volonté (échecs de connexion), afin de ne pas saturer les boîtes mail.
   */
  throttleKey?: string;
  throttleMs?: number;
}

const DEFAULT_THROTTLE_MS = 10 * 60_000;
const GLOBAL_WINDOW_MS = 10 * 60_000;
/**
 * Plafond, par type d'alerte et par fenêtre de 10 minutes, des alertes « provoquables » (toutes clés confondues) :
 * une attaque répartie sur de nombreuses IP ne peut pas saturer les boîtes mail. Chaque type a son propre compteur,
 * de sorte qu'une rafale d'échecs n'étouffe jamais une alerte de verrouillage ou d'activité suspecte.
 */
const GLOBAL_MAX: Partial<Record<SecurityAlertKind, number>> = { login_failed: 5 };
const GLOBAL_MAX_DEFAULT = 10;

const lastSent = new Map<string, number>();
const windows = new Map<SecurityAlertKind, { start: number; count: number; suppressed: number }>();

const pending = new Set<Promise<void>>();

/** Retourne le nombre d'alertes du même type regroupées depuis la dernière émise, ou null si celle-ci est retenue. */
function admit(alert: SecurityAlert, now: number): number | null {
  if (!alert.throttleKey) return 0;
  let window = windows.get(alert.kind);
  if (!window) {
    window = { start: now, count: 0, suppressed: 0 };
    windows.set(alert.kind, window);
  }
  const key = `${alert.kind}:${alert.throttleKey}`;
  const last = lastSent.get(key);
  if (last !== undefined && now >= last && now - last < (alert.throttleMs ?? DEFAULT_THROTTLE_MS)) {
    window.suppressed += 1;
    return null;
  }
  if (now - window.start >= GLOBAL_WINDOW_MS || now < window.start) {
    window.start = now;
    window.count = 0;
  }
  if (window.count >= (GLOBAL_MAX[alert.kind] ?? GLOBAL_MAX_DEFAULT)) {
    window.suppressed += 1;
    return null;
  }
  window.count += 1;

  if (lastSent.size > 5000) {
    for (const [k, at] of lastSent) if (now - at > 60 * 60_000) lastSent.delete(k);
    if (lastSent.size > 5000) lastSent.clear();
  }
  lastSent.set(key, now);
  const suppressed = window.suppressed;
  window.suppressed = 0;
  return suppressed;
}

function adminEmails(): string[] {
  return (db.prepare('SELECT email FROM users ORDER BY id').all() as { email: string }[]).map((row) => row.email);
}

const DISCORD_COLORS: Record<NotificationSeverity, number> = { info: 0x3b82f6, success: 0x22c55e, warning: 0xf59e0b, critical: 0xef4444 };

async function deliver(alert: SecurityAlert, suppressedBefore: number): Promise<void> {
  const severity = alert.severity ?? 'warning';
  const facts = [...(alert.facts ?? [])];
  if (suppressedBefore > 0) facts.push(['Alertes similaires regroupées', String(suppressedBefore)]);
  facts.push(['Date', new Date().toISOString()]);

  const tasks: Promise<unknown>[] = [];

  const recipients = adminEmails();
  if (recipients.length) {
    const { text, html } = renderMail({
      title: alert.title,
      paragraphs: [alert.summary, "Si cette action ne vient pas de vous ou de l'autre administrateur, changez immédiatement votre mot de passe et révoquez les sessions actives."],
      facts,
    });
    tasks.push(sendMail({ to: recipients, subject: `[TalCloud Panel] ${alert.title}`, text, html }));
  }

  if (config.securityDiscordWebhookUrl) {
    tasks.push(
      upstreamFetch('notifications', config.securityDiscordWebhookUrl, {
        method: 'POST',
        timeoutMs: 8000,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'TalCloud Panel — Sécurité',
          // Aucune mention ne peut être déclenchée par une valeur venant de la requête.
          allowed_mentions: { parse: [] },
          embeds: [
            {
              // Tout le texte est échappé : l'User-Agent ou un identifiant saisi par un anonyme ne peut pas y
              // glisser de lien masqué, de mise en forme ni d'URL cliquable (hameçonnage des administrateurs).
              title: discordText(alert.title, 250),
              description: discordText(alert.summary, 1000),
              color: DISCORD_COLORS[severity],
              fields: facts.slice(0, 20).map(([name, value]) => ({ name: discordText(name, 250), value: discordText(value || 'inconnu', 1000), inline: true })),
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      }).then((res) => res.body?.cancel()),
    );
  }

  tasks.push(
    notify({
      type: 'security',
      severity,
      title: alert.title,
      body: alert.summary,
      data: { kind: alert.kind, userId: alert.userId ?? null, facts: Object.fromEntries(facts.map(([k, v]) => [k, v ?? null])) },
      userId: null,
      channels: { push: true },
    }),
  );

  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'rejected' && !config.isTest) {
      const reason = result.reason instanceof Error ? result.reason.message : 'erreur inconnue';
      console.error(`[alerte sécurité] envoi impossible (${alert.kind}) : ${reason}`);
    }
  }
}

/**
 * Émet une alerte de sécurité : mail aux administrateurs + webhook Discord de sécurité + notification du panel.
 * Ne lève jamais d'exception et n'attend pas le réseau : l'envoi se fait en arrière-plan.
 */
export function securityAlert(alert: SecurityAlert): void {
  try {
    const suppressedBefore = admit(alert, Date.now());
    if (suppressedBefore === null) return;
    const task = deliver(alert, suppressedBefore)
      .catch(() => undefined)
      .finally(() => pending.delete(task));
    pending.add(task);
  } catch {
    // Une alerte ne doit jamais faire échouer la requête qui la déclenche.
  }
}

/** Attend la fin des envois en cours (arrêt propre, CLI, tests). */
export async function flushAlerts(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Tests uniquement : remet à zéro le regroupement des alertes. */
export function resetAlertThrottle(): void {
  lastSent.clear();
  windows.clear();
}

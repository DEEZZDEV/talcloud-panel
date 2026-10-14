import type { NotificationSeverity, NotificationType, PanelNotification } from '@shared/api-types';
import { db } from '../../db/index.js';

interface NotificationRow {
  id: number;
  type: NotificationType;
  severity: string;
  title: string;
  body: string;
  data: string | null;
  user_id: number | null;
  created_at: number;
  is_read?: number;
}

const SEVERITIES: readonly NotificationSeverity[] = ['info', 'success', 'warning', 'critical'];
export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 2000;
const MAX_DATA_BYTES = 16_384;

/** Conservation : 180 jours, et au plus 5000 notifications. */
export const NOTIFICATION_RETENTION_MS = 180 * 24 * 3600_000;
export const NOTIFICATION_MAX_ROWS = 5000;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function parseData(raw: string | null): PanelNotification['data'] {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toDto(row: NotificationRow, read: boolean): PanelNotification {
  return {
    id: row.id,
    type: row.type,
    severity: (SEVERITIES as readonly string[]).includes(row.severity) ? (row.severity as NotificationSeverity) : 'info',
    title: row.title,
    body: row.body,
    data: parseData(row.data),
    createdAt: new Date(row.created_at).toISOString(),
    read,
  };
}

export interface NewNotification {
  type: NotificationType;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  data?: object | null;
  userId?: number | null;
}

/** Insère une notification (lève une exception si la base la refuse). Les données sont stockées telles quelles en JSON. */
export function insertNotification(input: NewNotification): PanelNotification {
  const severity = input.severity && SEVERITIES.includes(input.severity) ? input.severity : 'info';
  let data: string | null = null;
  if (input.data !== undefined && input.data !== null) {
    const json = JSON.stringify(input.data);
    // Des données démesurées ne sont pas stockées (la notification reste lisible par son titre et son corps).
    if (typeof json === 'string' && Buffer.byteLength(json, 'utf8') <= MAX_DATA_BYTES) data = json;
  }
  const row: NotificationRow = {
    id: 0,
    type: input.type,
    severity,
    title: clip(String(input.title), MAX_TITLE_LENGTH),
    body: clip(String(input.body), MAX_BODY_LENGTH),
    data,
    user_id: input.userId ?? null,
    created_at: Date.now(),
  };
  const result = db
    .prepare('INSERT INTO notifications (type, severity, title, body, data, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.type, row.severity, row.title, row.body, row.data, row.user_id, row.created_at);
  row.id = Number(result.lastInsertRowid);
  return toDto(row, false);
}

export interface ListFilter {
  userId: number;
  type?: NotificationType;
  unreadOnly: boolean;
  page: number;
  pageSize: number;
}

// Un administrateur voit les notifications communes (user_id NULL) et les siennes ; l'état « lu » lui est propre.
const VISIBLE = `FROM notifications n
  LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = @userId
  WHERE (n.user_id IS NULL OR n.user_id = @userId)
    AND (@type IS NULL OR n.type = @type)
    AND (@unreadOnly = 0 OR r.read_at IS NULL)`;

export function listNotifications(filter: ListFilter): { items: PanelNotification[]; total: number } {
  const params = { userId: filter.userId, type: filter.type ?? null, unreadOnly: filter.unreadOnly ? 1 : 0 };
  const total = (db.prepare(`SELECT COUNT(*) AS c ${VISIBLE}`).get(params) as { c: number }).c;
  const rows = db
    .prepare(`SELECT n.*, (r.read_at IS NOT NULL) AS is_read ${VISIBLE} ORDER BY n.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize }) as NotificationRow[];
  return { items: rows.map((row) => toDto(row, row.is_read === 1)), total };
}

export function unreadCount(userId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS c ${VISIBLE}`).get({ userId, type: null, unreadOnly: 1 }) as { c: number }).c;
}

/** Retourne null si la notification n'existe pas ou n'est pas visible par cet utilisateur, sinon « nouvellement lue ». */
export function markRead(userId: number, notificationId: number): boolean | null {
  const visible = db.prepare('SELECT 1 FROM notifications WHERE id = ? AND (user_id IS NULL OR user_id = ?)').get(notificationId, userId);
  if (!visible) return null;
  return db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)').run(notificationId, userId, Date.now()).changes === 1;
}

export function markAllRead(userId: number): number {
  return db
    .prepare(
      `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
       SELECT n.id, ?, ? FROM notifications n WHERE n.user_id IS NULL OR n.user_id = ?`,
    )
    .run(userId, Date.now(), userId).changes;
}

/** Ménage : notifications trop anciennes, puis plafond du nombre de lignes (les états « lu » suivent en cascade). */
export function purgeNotifications(now = Date.now()): number {
  let removed = db.prepare('DELETE FROM notifications WHERE created_at < ?').run(now - NOTIFICATION_RETENTION_MS).changes;
  removed += db.prepare('DELETE FROM notifications WHERE id <= (SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET ?)').run(NOTIFICATION_MAX_ROWS).changes;
  return removed;
}

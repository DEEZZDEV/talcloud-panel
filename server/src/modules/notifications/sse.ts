import { PassThrough } from 'node:stream';
import type { ServerEvent } from '@shared/api-types';
import { rateLimited } from '../../core/errors.js';
import { subscribe, type BusMessage } from '../../core/events.js';
import { db } from '../../db/index.js';
import { isSessionActive, type SessionRow } from '../auth/sessions.js';

export const MAX_STREAMS_PER_USER = 6;
export const PING_INTERVAL_MS = 25_000;
/** Au-delà de ce volume en attente d'écriture, le client est jugé trop lent et la connexion est fermée. */
const MAX_BUFFERED_BYTES = 256 * 1024;

export interface StreamTarget {
  userId: number;
  sessionId: string;
}

/**
 * Filtrage du flux : un message sans `userId` est destiné aux deux administrateurs, avec `userId` à ce seul
 * compte, avec `sessionId` à cette seule session.
 */
export function shouldDeliver(message: BusMessage, target: StreamTarget): boolean {
  if (message.userId !== undefined && message.userId !== null && message.userId !== target.userId) return false;
  if (message.sessionId !== undefined && message.sessionId !== null && message.sessionId !== target.sessionId) return false;
  return true;
}

/** La session existe toujours, appartient au même compte, n'est ni révoquée ni expirée (inactivité ou durée absolue). */
export function isSessionStillValid(target: StreamTarget, now = Date.now()): boolean {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(target.sessionId) as SessionRow | undefined;
  return row !== undefined && row.user_id === target.userId && isSessionActive(row, now);
}

const streams = new Map<number, Set<EventStream>>();

export const openStreamCount = (userId: number): number => streams.get(userId)?.size ?? 0;

export interface EventStreamOptions {
  pingIntervalMs?: number;
  isSessionValid?: (target: StreamTarget) => boolean;
}

/** Une connexion SSE : abonnée au bus, filtrée pour sa session, fermée proprement (désabonnement, minuterie). */
export class EventStream {
  readonly stream = new PassThrough();
  private closed = false;
  private readonly unsubscribe: () => void;
  private readonly timer: NodeJS.Timeout;
  private readonly isSessionValid: (target: StreamTarget) => boolean;

  constructor(
    readonly target: StreamTarget,
    options: EventStreamOptions = {},
  ) {
    const mine = streams.get(target.userId) ?? new Set<EventStream>();
    if (mine.size >= MAX_STREAMS_PER_USER) throw rateLimited('Trop de connexions temps réel ouvertes pour ce compte');
    mine.add(this);
    streams.set(target.userId, mine);

    this.isSessionValid = options.isSessionValid ?? isSessionStillValid;
    // Une erreur d'écriture (client parti) ne doit jamais remonter en exception non gérée.
    this.stream.on('error', () => this.close());
    this.stream.on('close', () => this.close());

    // Délai de reconnexion conseillé au navigateur, puis un commentaire pour que les en-têtes partent aussitôt.
    this.stream.write('retry: 5000\n\n: connecté\n\n');
    this.unsubscribe = subscribe((message) => this.handle(message));
    this.timer = setInterval(() => this.tick(), options.pingIntervalMs ?? PING_INTERVAL_MS);
    this.timer.unref();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Message du bus : transmis seulement s'il est destiné à cette session. Une révocation ferme le flux. */
  handle(message: BusMessage): void {
    if (this.closed || !shouldDeliver(message, this.target)) return;
    this.send(message.event);
    if (message.event.type === 'session_revoked') this.close();
  }

  /** Battement périodique : revalide la session (révocation par la CLI, expiration), sinon envoie un ping. */
  tick(): void {
    if (this.closed) return;
    let valid = false;
    try {
      valid = this.isSessionValid(this.target);
    } catch {
      valid = false;
    }
    if (!valid) {
      this.send({ type: 'session_revoked' });
      this.close();
      return;
    }
    this.send({ type: 'ping' });
  }

  private send(event: ServerEvent): void {
    if (this.closed) return;
    // JSON.stringify échappe les sauts de ligne : un contenu non fiable ne peut pas forger un second message.
    this.stream.write(`data: ${JSON.stringify(event)}\n\n`);
    if (this.stream.writableLength > MAX_BUFFERED_BYTES) {
      this.close();
      this.stream.destroy();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    const mine = streams.get(this.target.userId);
    if (mine) {
      mine.delete(this);
      if (mine.size === 0) streams.delete(this.target.userId);
    }
    if (!this.stream.destroyed && !this.stream.writableEnded) this.stream.end();
  }
}

/** Ferme tous les flux ouverts (arrêt du serveur). */
export function closeAllStreams(): void {
  for (const set of [...streams.values()]) for (const stream of [...set]) stream.close();
}

import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@shared/api-types';

/** Évènement temps réel destiné au flux SSE. `userId` absent = diffusé aux deux administrateurs. */
export interface BusMessage {
  event: ServerEvent;
  userId?: number;
  /** Cible une session précise (ex. session révoquée). */
  sessionId?: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(message: BusMessage): void {
  bus.emit('message', message);
}

/** Retourne la fonction de désabonnement. */
export function subscribe(listener: (message: BusMessage) => void): () => void {
  bus.on('message', listener);
  return () => bus.off('message', listener);
}

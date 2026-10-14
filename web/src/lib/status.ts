import type { GameServerState, GuestStatus, NotificationSeverity, NotificationType } from '@shared/api-types';

/** Ton visuel d'un statut : couleur du point et du badge, identique partout dans le panel. */
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface StatusDescriptor {
  label: string;
  tone: Tone;
  /** Point animé pour les états transitoires (démarrage, arrêt en cours…). */
  pulse?: boolean;
}

const normalize = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const unknown = (raw: string | null | undefined): StatusDescriptor => ({ label: raw?.trim() || 'Inconnu', tone: 'neutral' });

const CLIENT: Record<string, StatusDescriptor> = {
  active: { label: 'Actif', tone: 'success' },
  inactive: { label: 'Inactif', tone: 'neutral' },
  closed: { label: 'Fermé', tone: 'danger' },
};

const SERVICE: Record<string, StatusDescriptor> = {
  active: { label: 'Actif', tone: 'success' },
  pending: { label: 'En attente', tone: 'warning' },
  suspended: { label: 'Suspendu', tone: 'warning' },
  terminated: { label: 'Résilié', tone: 'danger' },
  cancelled: { label: 'Annulé', tone: 'neutral' },
  completed: { label: 'Terminé', tone: 'neutral' },
  fraud: { label: 'Fraude', tone: 'danger' },
};

const ORDER: Record<string, StatusDescriptor> = {
  pending: { label: 'En attente', tone: 'warning' },
  active: { label: 'Active', tone: 'success' },
  fraud: { label: 'Fraude', tone: 'danger' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
  refunded: { label: 'Remboursée', tone: 'info' },
};

const INVOICE: Record<string, StatusDescriptor> = {
  paid: { label: 'Payée', tone: 'success' },
  unpaid: { label: 'Impayée', tone: 'warning' },
  overdue: { label: 'En retard', tone: 'danger' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
  refunded: { label: 'Remboursée', tone: 'info' },
  draft: { label: 'Brouillon', tone: 'neutral' },
  collections: { label: 'Recouvrement', tone: 'danger' },
  paymentpending: { label: 'Paiement en cours', tone: 'info', pulse: true },
};

const PAYMENT: Record<string, StatusDescriptor> = {
  paid: { label: 'Payé', tone: 'success' },
  unpaid: { label: 'Impayé', tone: 'warning' },
  overdue: { label: 'En retard', tone: 'danger' },
  cancelled: { label: 'Annulé', tone: 'neutral' },
  refunded: { label: 'Remboursé', tone: 'info' },
  paymentpending: { label: 'En cours', tone: 'info', pulse: true },
};

const lookup = (table: Record<string, StatusDescriptor>, raw: string | null | undefined): StatusDescriptor => table[normalize(raw)] ?? unknown(raw);

export const clientStatus = (raw: string | null | undefined) => lookup(CLIENT, raw);
export const serviceStatus = (raw: string | null | undefined) => lookup(SERVICE, raw);
export const orderStatus = (raw: string | null | undefined) => lookup(ORDER, raw);
export const invoiceStatus = (raw: string | null | undefined) => lookup(INVOICE, raw);
export const paymentStatus = (raw: string | null | undefined) => lookup(PAYMENT, raw);

export const isUnpaidInvoice = (status: string): boolean => ['unpaid', 'overdue', 'collections'].includes(normalize(status));

const GAME_SERVER: Record<GameServerState, StatusDescriptor> = {
  running: { label: 'En ligne', tone: 'success' },
  starting: { label: 'Démarrage', tone: 'info', pulse: true },
  stopping: { label: 'Arrêt en cours', tone: 'warning', pulse: true },
  offline: { label: 'Hors ligne', tone: 'danger' },
  suspended: { label: 'Suspendu', tone: 'warning' },
  installing: { label: 'Installation', tone: 'info', pulse: true },
  unknown: { label: 'Inconnu', tone: 'neutral' },
};
export const gameServerStatus = (state: GameServerState): StatusDescriptor => GAME_SERVER[state] ?? GAME_SERVER.unknown;

const GUEST: Record<GuestStatus, StatusDescriptor> = {
  running: { label: 'En marche', tone: 'success' },
  stopped: { label: 'Arrêté', tone: 'danger' },
  paused: { label: 'En pause', tone: 'warning' },
  unknown: { label: 'Inconnu', tone: 'neutral' },
};
export const guestStatus = (status: GuestStatus): StatusDescriptor => GUEST[status] ?? GUEST.unknown;

export const nodeStatus = (online: boolean): StatusDescriptor => (online ? { label: 'En ligne', tone: 'success' } : { label: 'Hors ligne', tone: 'danger' });

export const severityTone: Record<NotificationSeverity, Tone> = { info: 'info', success: 'success', warning: 'warning', critical: 'danger' };

export const notificationTypeLabel: Record<NotificationType, string> = {
  order: 'Commande',
  payment: 'Paiement',
  security: 'Sécurité',
  system: 'Système',
};

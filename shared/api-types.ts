/**
 * Contrat d'API partagé entre le backend (server/) et le frontend (web/).
 * Ce fichier ne contient QUE des types : il doit toujours être importé avec `import type`.
 *
 * Conventions :
 *  - Toutes les routes sont sous /api et renvoient du JSON.
 *  - Succès : { data: T, meta?: PageMeta }      Erreur : { error: { code, message, details? } }
 *  - Dates : chaînes ISO 8601 (UTC). Montants : nombres en unité majeure (ex. 12.5) + code devise.
 *  - Pagination : ?page=1&pageSize=25 (page commence à 1).
 */

// ───────────────────────────── Enveloppes ─────────────────────────────

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  /** Présent quand une recherche n'a pas pu couvrir toutes les données. */
  truncated?: boolean;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR' // 400
  | 'UNAUTHENTICATED' // 401 — pas de session valide
  | 'INVALID_CREDENTIALS' // 401 — identifiants ou codes incorrects (message volontairement générique)
  | 'FORBIDDEN' // 403
  | 'CSRF_INVALID' // 403
  | 'STEP_UP_REQUIRED' // 403 — l'action exige une re-confirmation TOTP (POST /api/auth/step-up puis rejouer)
  | 'IP_NOT_ALLOWED' // 403
  | 'NOT_FOUND' // 404
  | 'INTEGRATION_NOT_CONFIGURED' // 409 — details: { integration }
  | 'ACCOUNT_LOCKED' // 423 — details: { retryAfterSeconds }
  | 'RATE_LIMITED' // 429
  | 'UPSTREAM_ERROR' // 502 — l'API distante (WHMCS, Pterodactyl, Proxmox, IMAP…) a échoué
  | 'INTERNAL'; // 500

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

export type IntegrationName = 'whmcs' | 'pterodactyl' | 'proxmox' | 'mail' | 'notifications';

// ───────────────────────────── Auth & sécurité ─────────────────────────────

export interface AdminUser {
  id: number;
  username: string;
  email: string;
}

/** GET /api/auth/session — toujours 200. */
export interface SessionState {
  authenticated: boolean;
  user?: AdminUser;
  /** À renvoyer dans l'en-tête X-CSRF-Token de toute requête non-GET. */
  csrfToken?: string;
  /** Fin de la fenêtre de re-confirmation TOTP, ou null. */
  stepUpUntil?: string | null;
  idleTimeoutSeconds?: number;
  /** Expiration absolue de la session. */
  expiresAt?: string;
  /** Une connexion est en cours (étape 2 ou 3) : permet au frontend de reprendre après un rechargement. */
  pendingLogin?: { step: Exclude<LoginStepName, 'done'>; emailHint: string; reasons?: NewContextReason[] } | null;
}

export type LoginStepName = 'second_factor' | 'device_confirmation' | 'done';
export type NewContextReason = 'new_device' | 'new_ip' | 'new_country';

/** POST /api/auth/login */
export interface LoginRequest {
  identifier: string; // nom d'utilisateur ou e-mail
  password: string;
}

/** POST /api/auth/login/verify — code mail ET (TOTP ou code de secours), les deux requis. */
export interface LoginVerifyRequest {
  emailCode: string;
  totpCode?: string;
  backupCode?: string;
}

/** POST /api/auth/login/confirm-device — code du mail « nouvel appareil / nouvelle IP / nouveau pays ». */
export interface LoginConfirmDeviceRequest {
  code: string;
}

/** Réponse des trois étapes de connexion. */
export interface LoginStepResponse {
  step: LoginStepName;
  emailHint?: string; // ex. « a•••@gmail.com »
  reasons?: NewContextReason[];
  /** Présent uniquement quand step === 'done'. */
  session?: SessionState;
}

/** POST /api/auth/step-up */
export interface StepUpRequest {
  totpCode: string;
}
export interface StepUpResponse {
  stepUpUntil: string;
}

/** GET /api/security/sessions */
export interface SessionInfo {
  id: string;
  current: boolean;
  ip: string;
  country: string | null;
  userAgent: string;
  deviceLabel: string; // ex. « Chrome 129 · Windows »
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** GET /api/security/audit?page&pageSize&action&success */
export interface AuditEntry {
  id: number;
  at: string;
  action: string; // ex. « auth.login.success », « pterodactyl.server.stop »
  target: string | null;
  success: boolean;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  deviceLabel: string | null;
  details: Record<string, unknown> | null;
}

/** GET /api/security/devices */
export interface KnownDevice {
  id: number;
  label: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIp: string | null;
  current: boolean;
}

/** GET|PUT /api/security/ip-allowlist */
export interface IpAllowlist {
  /** Entrées gérées depuis le panel (IP ou CIDR). Liste vide + envEntries vide = filtrage désactivé. */
  entries: string[];
  /** Entrées imposées par la variable IP_ALLOWLIST (lecture seule). */
  envEntries: string[];
  currentIp: string;
}
export interface IpAllowlistUpdate {
  entries: string[];
}

/** POST /api/security/password */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** POST /api/security/totp/regenerate → TotpSetup, puis POST /api/security/totp/confirm { code } */
export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/** GET /api/security/backup-codes */
export interface BackupCodesStatus {
  remaining: number;
  total: number;
}
/** POST /api/security/backup-codes/regenerate */
export interface BackupCodes {
  codes: string[];
}

// ───────────────────────────── Réglages des intégrations ─────────────────────────────

/**
 * GET /api/settings/:namespace — les secrets ne sont JAMAIS renvoyés, seulement « défini ou non ».
 * PUT /api/settings/:namespace — corps partiel ; un secret absent ou vide reste inchangé. Exige un step-up.
 *   Si la destination change (URL, TLS) alors que des secrets sont enregistrés, ils doivent être ressaisis :
 *   sinon 400 avec details.secretsRequired: string[].
 * POST /api/settings/:namespace/test → SettingsTestResult (step-up)
 */
export interface SettingsView<TValues> {
  configured: boolean;
  values: Partial<TValues>;
  secrets: Record<string, boolean>;
  updatedAt: string | null;
}
export interface SettingsTestResult {
  ok: boolean;
  message: string;
}

export interface WhmcsSettingsValues {
  url: string; // ex. https://client.exemple.com (sans /includes/api.php)
}
/** Secrets : identifier, secret, accessKey (optionnel). */
export interface WhmcsSettingsInput extends WhmcsSettingsValues {
  identifier?: string;
  secret?: string;
  accessKey?: string;
}

export interface PterodactylSettingsValues {
  url: string;
}
/** Secrets : applicationKey (ptla_…), clientKey (ptlc_… d'un compte administrateur). */
export interface PterodactylSettingsInput extends PterodactylSettingsValues {
  applicationKey?: string;
  clientKey?: string;
}

export interface ProxmoxSettingsValues {
  url: string; // ex. https://pve.exemple.com:8006
  tokenId: string; // ex. panel@pve!talcloud
  verifyTls: boolean;
  /** Certificat CA au format PEM (optionnel) pour les certificats auto-signés. */
  caCert?: string;
}
/** Secret : tokenSecret. */
export interface ProxmoxSettingsInput extends ProxmoxSettingsValues {
  tokenSecret?: string;
}

export interface NotificationSettingsValues {
  discordEnabled: boolean;
  notifyOrders: boolean;
  notifyPayments: boolean;
  /** Libellé du compte qui encaisse, par passerelle WHMCS. Ex. { stripe: 'Stripe — TalCloud SAS' }. */
  gatewayAccounts: Record<string, string>;
}
/** Secret : discordWebhookUrl. */
export interface NotificationSettingsInput extends NotificationSettingsValues {
  discordWebhookUrl?: string;
}

// ───────────────────────────── WHMCS ─────────────────────────────

export interface WhmcsClientRef {
  id: number;
  name: string;
  email: string;
  companyName: string | null;
  status: string; // Active | Inactive | Closed
}

/** GET /api/whmcs/stats/overview */
export interface WhmcsOverview {
  currency: string;
  month: string; // YYYY-MM
  revenue: number;
  costs: number;
  netProfit: number;
  newClients: number;
  orders: number;
  unpaidInvoices: { count: number; total: number };
  activeClients: number;
  /** Variation en % par rapport au mois précédent (null si non calculable). */
  /** true si le volume de données a dépassé le plafond de lecture : chiffres partiels. */
  truncated?: boolean;
  deltas: {
    revenue: number | null;
    netProfit: number | null;
    newClients: number | null;
    orders: number | null;
  };
}

/** GET /api/whmcs/stats/monthly?months=12 — du plus ancien au plus récent. */
export interface WhmcsMonthlyPoint {
  month: string; // YYYY-MM
  revenue: number;
  costs: number;
  profit: number;
  newClients: number;
  orders: number;
}
export interface WhmcsMonthlyStats {
  currency: string;
  points: WhmcsMonthlyPoint[];
  truncated?: boolean;
}

/** GET /api/whmcs/clients?search&status&page&pageSize */
export interface WhmcsClient extends WhmcsClientRef {
  createdAt: string | null;
  country: string | null;
  phone: string | null;
}

/** GET /api/whmcs/clients/:id */
export interface WhmcsClientDetail extends WhmcsClient {
  address: string | null;
  credit: number;
  currency: string;
  services: WhmcsService[];
  recentInvoices: WhmcsInvoice[];
  stats: { totalPaid: number; unpaidTotal: number; activeServices: number };
  /** URL de la fiche dans l'admin WHMCS (null si non déterminable). */
  adminUrl: string | null;
}

export interface WhmcsService {
  id: number;
  name: string;
  domain: string | null;
  status: string; // Active | Pending | Suspended | Terminated | Cancelled
  amount: number;
  billingCycle: string;
  nextDueDate: string | null;
}

/** GET /api/whmcs/orders?search&status&page&pageSize */
export interface WhmcsOrder {
  id: number;
  orderNumber: string;
  clientId: number;
  clientName: string;
  date: string;
  amount: number;
  currency: string;
  status: string; // Pending | Active | Fraud | Cancelled
  paymentStatus: string | null; // Paid | Unpaid…
  paymentMethod: string | null;
  products: string[];
  invoiceId: number | null;
}

/** GET /api/whmcs/invoices?search&status&page&pageSize */
export interface WhmcsInvoice {
  id: number;
  clientId: number;
  clientName: string;
  date: string;
  dueDate: string | null;
  datePaid: string | null;
  total: number;
  currency: string;
  status: string; // Paid | Unpaid | Overdue | Cancelled | Refunded | Draft
  paymentMethod: string | null;
}

/** /api/whmcs/costs — coûts saisis manuellement pour le calcul du bénéfice. */
export type CostRecurrence = 'monthly' | 'yearly' | 'one_time';
export type CostCategory = 'servers' | 'licenses' | 'network' | 'software' | 'staff' | 'fees' | 'other';
export interface Cost {
  id: number;
  label: string;
  category: CostCategory;
  amount: number;
  recurrence: CostRecurrence;
  /** Premier mois d'application (YYYY-MM). Pour one_time : le mois de la dépense. */
  startMonth: string;
  /** Dernier mois d'application inclus (YYYY-MM), null = sans fin. */
  endMonth: string | null;
  notes: string | null;
  createdAt: string;
}
export type CostInput = Omit<Cost, 'id' | 'createdAt'>;

// ───────────────────────────── Notifications ─────────────────────────────

export type NotificationType = 'order' | 'payment' | 'security' | 'system';
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

/** Données d'une notification de type order / payment. */
export interface OrderNotificationData {
  event: 'order_created' | 'invoice_paid' | 'order_paid';
  orderId?: number;
  invoiceId?: number;
  clientId?: number;
  clientName: string;
  clientEmail?: string;
  products: string[];
  amount: number;
  currency: string;
  /** Identifiant de passerelle WHMCS (stripe, paypal, banktransfer…). */
  gateway: string | null;
  /** Nom lisible de la passerelle. */
  gatewayName: string | null;
  /** Compte qui encaisse (d'après NotificationSettingsValues.gatewayAccounts). */
  receivingAccount: string | null;
  transactionId?: string;
}

/** GET /api/notifications?page&pageSize&type&unread=1 */
export interface PanelNotification {
  id: number;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  data: OrderNotificationData | Record<string, unknown> | null;
  createdAt: string;
  read: boolean;
}

/** GET /api/notifications/unread-count */
export interface UnreadCount {
  count: number;
}

/** GET /api/push/public-key */
export interface PushPublicKey {
  publicKey: string; // clé VAPID (base64url)
}
/** POST /api/push/subscribe — le PushSubscription.toJSON() du navigateur. */
export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
/** POST /api/push/unsubscribe */
export interface PushUnsubscribeRequest {
  endpoint: string;
}
/** Charge utile JSON reçue par le service worker (web/public/sw.js) dans l'évènement « push ». */
export interface PushPayload {
  title: string;
  body: string;
  /** Chemin à ouvrir au clic, ex. « /notifications ». */
  url: string;
  tag?: string;
}

/**
 * GET /api/events — flux Server-Sent Events (authentifié). Chaque message : `data: <ServerEvent JSON>`.
 */
export type ServerEvent =
  | { type: 'notification'; notification: PanelNotification }
  | { type: 'session_revoked' }
  | { type: 'ping' };

/**
 * POST /api/webhooks/whmcs — appelé par le hook PHP (whmcs-hook/talcloud_notify.php).
 * En-têtes : X-TalCloud-Timestamp (secondes Unix), X-TalCloud-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${corps brut}`)>
 */
export interface WhmcsWebhookPayload {
  /** Identifiant unique de l'évènement (idempotence). */
  eventId: string;
  event: OrderNotificationData['event'];
  orderId?: number;
  invoiceId?: number;
  clientId?: number;
  clientName: string;
  clientEmail?: string;
  products: string[];
  amount: number;
  currency: string;
  gateway?: string;
  gatewayName?: string;
  transactionId?: string;
}

// ───────────────────────────── Mails ─────────────────────────────

/** GET /api/mail/accounts */
export interface MailAccount {
  id: number;
  label: string; // Support, Contact, Facturation…
  address: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  /** Le mot de passe n'est jamais renvoyé. */
  hasPassword: boolean;
  createdAt: string;
}
/** POST /api/mail/accounts, PUT /api/mail/accounts/:id (step-up). Mot de passe vide en PUT = inchangé. */
export interface MailAccountInput {
  label: string;
  address: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password?: string;
}

/** GET /api/mail/accounts/:id/folders */
export interface MailFolder {
  path: string;
  name: string;
  specialUse: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | null;
  unread: number;
  total: number;
}

export interface MailAddress {
  name: string | null;
  address: string;
}

/** GET /api/mail/accounts/:id/messages?folder=INBOX&page&pageSize&search */
export interface MailMessageSummary {
  uid: number;
  folder: string;
  from: MailAddress | null;
  to: MailAddress[];
  subject: string;
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  preview: string;
}

export interface MailAttachment {
  /** Identifiant de partie à passer à la route de téléchargement. */
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/** GET /api/mail/accounts/:id/messages/:uid?folder=INBOX */
export interface MailMessageDetail extends MailMessageSummary {
  cc: MailAddress[];
  replyTo: MailAddress[];
  messageId: string | null;
  /** HTML assaini côté serveur (scripts, handlers et contenus distants retirés). À afficher dans une iframe sandbox. */
  html: string | null;
  text: string | null;
  /** true si des images distantes ont été bloquées. */
  remoteContentBlocked: boolean;
  attachments: MailAttachment[];
  /** Fiche client WHMCS dont l'e-mail correspond à l'expéditeur (null si aucune ou WHMCS non configuré). */
  whmcsClient: WhmcsClientRef | null;
}

/** POST /api/mail/accounts/:id/messages/:uid/flags?folder= */
export interface MailFlagsRequest {
  seen?: boolean;
  flagged?: boolean;
}
/** POST /api/mail/accounts/:id/messages/:uid/move?folder= */
export interface MailMoveRequest {
  destination: string;
}

/** POST /api/mail/accounts/:id/send */
export interface MailSendRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** Pour une réponse : message d'origine (définit In-Reply-To / References et le marque « répondu »). */
  inReplyTo?: { folder: string; uid: number };
  attachments?: { filename: string; contentType: string; contentBase64: string }[];
}
export interface MailSendResult {
  messageId: string;
}

/** GET /api/mail/unread-summary */
export interface MailUnreadSummary {
  total: number;
  accounts: { accountId: number; label: string; address: string; unread: number; error: string | null }[];
}

// ───────────────────────────── Pterodactyl ─────────────────────────────

export type GameServerState = 'running' | 'starting' | 'stopping' | 'offline' | 'suspended' | 'installing' | 'unknown';

/** GET /api/pterodactyl/servers */
export interface GameServer {
  id: number; // id interne (API Application)
  identifier: string; // identifiant court (API Client)
  uuid: string;
  name: string;
  description: string | null;
  node: string | null;
  state: GameServerState;
  suspended: boolean;
  /** null si les ressources n'ont pas pu être lues (serveur suspendu, node injoignable…). */
  resources: {
    cpuPercent: number;
    memoryBytes: number;
    diskBytes: number;
    uptimeMs: number;
  } | null;
  limits: {
    cpuPercent: number; // 0 = illimité
    memoryBytes: number; // 0 = illimité
    diskBytes: number; // 0 = illimité
  };
  owner: { id: number; username: string; email: string } | null;
  whmcsClient: WhmcsClientRef | null;
  /** URL du serveur dans le panel Pterodactyl. */
  panelUrl: string;
}

export type PowerSignal = 'start' | 'stop' | 'restart' | 'kill';
/** POST /api/pterodactyl/servers/:id/power — stop, restart et kill exigent un step-up. */
export interface PowerRequest {
  signal: PowerSignal;
}

/** GET /api/pterodactyl/summary */
export interface PterodactylSummary {
  total: number;
  running: number;
  offline: number;
  suspended: number;
  /** Serveurs non suspendus et hors ligne. */
  offlineServers: { id: number; name: string; node: string | null }[];
}

// ───────────────────────────── Proxmox ─────────────────────────────

/** GET /api/proxmox/nodes */
export interface ProxmoxNode {
  node: string;
  online: boolean;
  cpuPercent: number; // 0–100
  cpuCores: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  uptimeSeconds: number;
  loadAverage: [number, number, number] | null;
  pveVersion: string | null;
  guests: { running: number; total: number };
}

export type GuestType = 'qemu' | 'lxc';
export type GuestStatus = 'running' | 'stopped' | 'paused' | 'unknown';

/** GET /api/proxmox/guests */
export interface ProxmoxGuest {
  vmid: number;
  name: string;
  node: string;
  type: GuestType;
  status: GuestStatus;
  template: boolean;
  cpuPercent: number; // 0–100 (rapporté aux cœurs alloués)
  cpuCores: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  uptimeSeconds: number;
  tags: string[];
}

export type GuestAction = 'start' | 'shutdown' | 'stop' | 'reboot';
/** POST /api/proxmox/guests/:node/:type/:vmid/action — shutdown, stop et reboot exigent un step-up. */
export interface GuestActionRequest {
  action: GuestAction;
}
export interface GuestActionResult {
  /** UPID de la tâche Proxmox. */
  taskId: string;
}

/** GET /api/proxmox/nodes/:node/history?timeframe=hour|day|week */
export interface ProxmoxNodeHistoryPoint {
  time: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  loadAverage: number | null;
}

/** GET /api/proxmox/summary */
export interface ProxmoxSummary {
  nodes: { total: number; online: number };
  guests: { total: number; running: number; stopped: number };
  offlineNodes: string[];
}

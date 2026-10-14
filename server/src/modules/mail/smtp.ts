import { randomUUID } from 'node:crypto';
import { createTransport, type SMTPTransportOptions } from 'nodemailer';
import MailComposer, { type MailComposerOptions } from 'nodemailer/lib/mail-composer';
import { accountPassword, type MailAccountRow } from './accounts.js';
import { toMailError, type ReplyContext } from './imap.js';
import { cleanContentType, sanitizeFilename } from './sanitize.js';
import { hasControlChars, isValidEmailAddress, tlsPolicy, type SendInput } from './validation.js';

/** Envoi SMTP : TLS implicite ou STARTTLS exigé, certificat vérifié, expéditeur forcé à l'adresse du compte. */

const SEND_TIMEOUT_MS = 90_000;
const VERIFY_TIMEOUT_MS = 20_000;

export function smtpOptions(account: MailAccountRow, password: string): SMTPTransportOptions {
  const policy = tlsPolicy(account.smtp_host, account.smtp_secure === 1);
  return {
    host: account.smtp_host,
    port: account.smtp_port,
    secure: policy.implicitTls,
    // Sans TLS implicite, STARTTLS est exigé : ni le mot de passe ni les messages ne partent en clair.
    requireTLS: policy.requireStartTls,
    ignoreTLS: policy.cleartextAllowed,
    auth: { user: account.username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    dnsTimeout: 10_000,
    logger: false,
    // Jamais de lecture de fichier local ni d'URL pour composer un message.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTransport<T>(account: MailAccountRow, ms: number, fn: (transport: ReturnType<typeof createTransport>) => Promise<T>): Promise<T> {
  let transport: ReturnType<typeof createTransport> | null = null;
  try {
    transport = createTransport(smtpOptions(account, accountPassword(account)));
    return await withDeadline(fn(transport), ms);
  } catch (err) {
    throw toMailError(err);
  } finally {
    try {
      transport?.close();
    } catch {
      // Déjà fermé.
    }
  }
}

/** Vérifie la connexion et l'authentification SMTP. */
export async function testSmtp(account: MailAccountRow): Promise<void> {
  await withTransport(account, VERIFY_TIMEOUT_MS, async (transport) => {
    await transport.verify();
  });
}

export interface OutgoingMessage {
  messageId: string;
  options: MailComposerOptions;
  /** Tous les destinataires de l'enveloppe SMTP (to + cc + bcc). */
  recipients: string[];
}

/**
 * Compose le message à partir d'une entrée DÉJÀ validée par `sendBody`. Les contrôles critiques sont refaits ici
 * (défense en profondeur) : aucune valeur d'en-tête ne peut contenir de retour à la ligne, et l'expéditeur —
 * en-tête From comme enveloppe SMTP — est toujours l'adresse du compte.
 */
export function buildOutgoingMessage(account: MailAccountRow, input: SendInput, reply: ReplyContext | null, now = new Date()): OutgoingMessage {
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
  if (input.to.length === 0 || !recipients.every(isValidEmailAddress)) throw new Error('destinataire invalide');
  if (hasControlChars(input.subject)) throw new Error('objet invalide');
  if (!isValidEmailAddress(account.address)) throw new Error('adresse du compte invalide');

  const domain = account.address.slice(account.address.lastIndexOf('@') + 1).toLowerCase();
  const messageId = `<${randomUUID()}@${domain}>`;
  const references = reply?.messageId ? [...reply.references.filter((id) => id !== reply.messageId), reply.messageId] : [];

  const options: MailComposerOptions = {
    from: { name: account.label.replace(/[\r\n\0]/g, ' '), address: account.address },
    to: input.to,
    ...(input.cc?.length ? { cc: input.cc } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    subject: input.subject,
    text: input.text,
    messageId,
    date: now,
    ...(reply?.messageId ? { inReplyTo: reply.messageId, references } : {}),
    attachments: (input.attachments ?? []).map((attachment, index) => ({
      filename: sanitizeFilename(attachment.filename, `piece-jointe-${index + 1}`),
      content: Buffer.from(attachment.contentBase64, 'base64'),
      contentType: cleanContentType(attachment.contentType),
      contentDisposition: 'attachment',
    })),
    // L'enveloppe est fixée explicitement : elle ne dépend d'aucune analyse d'en-tête.
    envelope: { from: account.address, to: recipients },
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  return { messageId, options, recipients };
}

/** Message brut (RFC 5322) pour la copie « Envoyés » : identique à l'envoi, en-tête Bcc conservé. */
export async function buildRawCopy(message: OutgoingMessage): Promise<Buffer> {
  const node = new MailComposer(message.options).compile();
  node.keepBcc = true;
  return node.build();
}

export interface SmtpSendResult {
  messageId: string;
  rejected: number;
}

export async function sendMessage(account: MailAccountRow, message: OutgoingMessage): Promise<SmtpSendResult> {
  return withTransport(account, SEND_TIMEOUT_MS, async (transport) => {
    const info = (await transport.sendMail(message.options)) as { rejected?: unknown[] };
    return { messageId: message.messageId, rejected: Array.isArray(info.rejected) ? info.rejected.length : 0 };
  });
}

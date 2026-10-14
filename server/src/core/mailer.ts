import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

export interface MailInput {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

export interface SentMail extends MailInput {
  sentAt: number;
}

/** En NODE_ENV=test, les messages sont empilés ici au lieu d'être envoyés. */
export const outbox: SentMail[] = [];

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  const smtp = config.smtp;
  if (!smtp) throw new Error('SMTP non configuré');
  const local = ['localhost', '127.0.0.1', '::1'].includes(smtp.host.toLowerCase());
  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // Sans TLS implicite, STARTTLS est exigé : les codes de connexion ne partent jamais en clair
    // (seule exception : un relais sur la boucle locale).
    requireTLS: !smtp.secure && !local,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

/** Empêche toute injection d'en-tête via l'objet. */
const cleanHeader = (value: string): string => value.replace(/[\r\n\0]+/g, ' ').slice(0, 200);

/**
 * Envoie un mail système (codes de connexion, alertes) via le SMTP du .env.
 * Lève une exception en cas d'échec : l'appelant décide s'il l'ignore (alerte) ou la remonte (code de connexion).
 */
export async function sendMail(input: MailInput): Promise<void> {
  const message: MailInput = { ...input, subject: cleanHeader(input.subject) };

  if (config.isTest) {
    outbox.push({ ...message, sentAt: Date.now() });
    return;
  }

  if (!config.smtp) {
    if (config.isProd) throw new Error('SMTP non configuré');
    // Développement sans SMTP : le contenu (y compris les codes) est affiché dans la console.
    const to = Array.isArray(message.to) ? message.to.join(', ') : message.to;
    console.log(`\n──────── MAIL (SMTP non configuré, affichage console) ────────\nÀ : ${to}\nObjet : ${message.subject}\n\n${message.text}\n──────────────────────────────────────────────────────────────\n`);
    return;
  }

  await getTransporter().sendMail({
    from: config.smtp.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

/** Échappement HTML de toute valeur insérée dans un mail. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export interface MailLayout {
  title: string;
  /** Paragraphes de texte brut (échappés automatiquement dans la version HTML). */
  paragraphs: string[];
  /** Code à usage unique mis en évidence. */
  code?: string;
  /** Tableau « libellé : valeur » ; les valeurs viennent souvent de la requête et sont toujours échappées. */
  facts?: [label: string, value: string | null | undefined][];
  footer?: string;
}

/** Produit les versions texte et HTML (simple, sans ressource distante) d'un mail système. */
export function renderMail(layout: MailLayout): { text: string; html: string } {
  const facts = (layout.facts ?? []).map(([label, value]) => [label, value === null || value === undefined || value === '' ? 'inconnu' : value] as const);
  const footer = layout.footer ?? `Message automatique de TalCloud Panel (${config.publicUrl}). Ne répondez pas à ce mail.`;

  const text = [
    layout.title,
    '',
    ...layout.paragraphs.flatMap((p) => [p, '']),
    ...(layout.code ? [`    ${layout.code}`, ''] : []),
    ...(facts.length ? [...facts.map(([label, value]) => `- ${label} : ${value}`), ''] : []),
    '--',
    footer,
  ].join('\n');

  const html = [
    '<!doctype html><html lang="fr"><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;padding:24px">',
    `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(layout.title)}</h1>`,
    ...layout.paragraphs.map((p) => `<p style="font-size:14px;line-height:1.5;margin:0 0 12px">${escapeHtml(p)}</p>`),
    ...(layout.code
      ? [`<p style="font-size:28px;letter-spacing:4px;font-weight:bold;font-family:Consolas,Menlo,monospace;margin:16px 0;padding:12px;background:#f4f4f5;border-radius:6px;text-align:center">${escapeHtml(layout.code)}</p>`]
      : []),
    ...(facts.length
      ? [
          '<table style="font-size:13px;border-collapse:collapse;margin:12px 0">',
          ...facts.map(
            ([label, value]) =>
              `<tr><td style="padding:4px 12px 4px 0;color:#71717a;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:4px 0;word-break:break-word">${escapeHtml(value)}</td></tr>`,
          ),
          '</table>',
        ]
      : []),
    `<p style="font-size:12px;color:#71717a;margin:16px 0 0">${escapeHtml(footer)}</p>`,
    '</div></body></html>',
  ].join('');

  return { text, html };
}

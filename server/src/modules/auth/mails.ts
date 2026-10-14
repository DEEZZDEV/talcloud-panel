import type { NewContextReason } from '@shared/api-types';
import { renderMail, sendMail } from '../../core/mailer.js';
import type { ClientInfo } from '../../types/fastify.js';
import { clientFacts } from './lockout.js';
import type { UserRow } from './users.js';

export const REASON_LABELS: Record<NewContextReason, string> = {
  new_device: 'nouvel appareil',
  new_ip: 'nouvelle adresse IP',
  new_country: 'nouveau pays',
};

/** Étape 2 : code à 6 chiffres envoyé après un mot de passe correct. Le code ne figure jamais dans l'objet. */
export async function sendLoginCodeMail(user: UserRow, code: string, client: ClientInfo): Promise<void> {
  const { text, html } = renderMail({
    title: 'Code de connexion',
    paragraphs: [
      `Bonjour ${user.username}, voici votre code de connexion à TalCloud Panel. Il est valable 10 minutes et doit être saisi avec votre code 2FA.`,
      "Si vous n'êtes pas à l'origine de cette connexion, votre mot de passe est compromis : changez-le sans attendre. Ne communiquez jamais ce code.",
    ],
    code,
    facts: clientFacts(client),
  });
  await sendMail({ to: user.email, subject: '[TalCloud Panel] Code de connexion', text, html });
}

/** Étape 3 : code à 8 chiffres quand l'appareil, l'IP ou le pays est nouveau pour ce compte. */
export async function sendDeviceCodeMail(user: UserRow, code: string, reasons: NewContextReason[], client: ClientInfo): Promise<void> {
  const what = reasons.map((reason) => REASON_LABELS[reason]).join(', ');
  const { text, html } = renderMail({
    title: `Confirmation de connexion : ${what}`,
    paragraphs: [
      `Bonjour ${user.username}, une connexion à TalCloud Panel est en cours depuis un contexte inhabituel (${what}). Pour la confirmer, saisissez le code ci-dessous, valable 10 minutes.`,
      "Si vous n'êtes pas à l'origine de cette connexion, ne saisissez pas ce code : votre mot de passe et votre 2FA sont compromis, changez-les immédiatement.",
    ],
    code,
    facts: [['Motif', what], ...clientFacts(client)],
  });
  await sendMail({ to: user.email, subject: `[TalCloud Panel] Confirmation de connexion (${what})`, text, html });
}

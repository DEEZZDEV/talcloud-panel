import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import type { MailAccountRow } from '../src/modules/mail/accounts.js';
import { classifyMailError, imapOptions, toMailError } from '../src/modules/mail/imap.js';
import { buildOutgoingMessage, buildRawCopy, smtpOptions } from '../src/modules/mail/smtp.js';
import {
  accountCreateBody,
  accountUpdateBody,
  attachmentParams,
  checkMailHost,
  flagsBody,
  folderQuery,
  isAllowedPort,
  isLoopbackHost,
  isValidEmailAddress,
  listQuery,
  messageParams,
  moveBody,
  sendBody,
  tlsPolicy,
} from '../src/modules/mail/validation.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

const account = (overrides: Partial<MailAccountRow> = {}): MailAccountRow => ({
  id: 7,
  label: 'Support',
  address: 'support@exemple.test',
  imap_host: 'imap.exemple.test',
  imap_port: 993,
  imap_secure: 1,
  smtp_host: 'smtp.exemple.test',
  smtp_port: 465,
  smtp_secure: 1,
  username: 'support@exemple.test',
  password_enc: '',
  created_at: 0,
  ...overrides,
});

const validAccount = {
  label: 'Support',
  address: 'support@exemple.test',
  imapHost: 'imap.exemple.test',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.exemple.test',
  smtpPort: 587,
  smtpSecure: false,
  username: 'support@exemple.test',
  password: 'un-mot-de-passe',
};

describe('validation des hôtes IMAP/SMTP (anti-SSRF)', () => {
  it.each(['imap.exemple.test', 'IMAP.Exemple.TEST', 'mail', 'mailserver', 'xn--bcher-kva.example', 'a-b.c-d.example', '192.0.2.10', '10.0.0.5', '127.0.0.1', '::1', '2001:db8::25', 'imap.exemple.test.'])(
    'accepte %j',
    (host) => {
      expect(checkMailHost(host).ok).toBe(true);
    },
  );

  it('normalise en minuscules, sans point final', () => {
    expect(checkMailHost(' IMAP.Exemple.TEST. ')).toEqual({ ok: true, host: 'imap.exemple.test', kind: 'name' });
    expect(checkMailHost('::ffff:192.0.2.1')).toEqual({ ok: true, host: '192.0.2.1', kind: 'ipv4' });
  });

  it.each([
    ['URL', 'https://imap.exemple.test'],
    ['schéma imap', 'imaps://imap.exemple.test'],
    ['chemin', 'imap.exemple.test/boite'],
    ['port', 'imap.exemple.test:993'],
    ['identifiants', 'user:pass@imap.exemple.test'],
    ['arobase', 'evil.test@imap.exemple.test'],
    ['requête', 'imap.exemple.test?x=1'],
    ['fragment', 'imap.exemple.test#x'],
    ['espace', 'imap exemple.test'],
    ['retour à la ligne', `imap.exemple.test${CRLF}RCPT TO:<x@y>`],
    ['octet nul', `imap.exemple.test${String.fromCharCode(0)}.evil.test`],
    ['antislash', 'imap.exemple.test\\evil'],
    ['crochets IPv6', '[::1]'],
    ['IPv6 avec zone', 'fe80::1%eth0'],
    ['vide', ''],
    ['trop long', `${'a'.repeat(250)}.test`],
    ['libellé vide', 'imap..exemple.test'],
    ['tiret initial', '-imap.exemple.test'],
    ['souligné', 'imap_serveur.exemple.test'],
    ['caractère non ASCII', 'imäp.exemple.test'],
    ['métadonnées cloud (IPv4)', '169.254.169.254'],
    ['métadonnées cloud (IPv4 mappée)', '::ffff:169.254.169.254'],
    ['lien local IPv6', 'fe80::1'],
    ['adresse non spécifiée', '0.0.0.0'],
    ['adresse non spécifiée IPv6', '::'],
    ['diffusion', '255.255.255.255'],
    ['multidiffusion', '224.0.0.1'],
    ['IPv4 entière décimale (169.254.169.254)', '2852039166'],
    ['IPv4 hexadécimale', '0xa9fea9fe'],
    ['IPv4 octale', '0251.0376.0251.0376'],
    ['IPv4 hexadécimale en deux parties', '1.0x7f'],
    ['IPv4 abrégée', '127.1'],
    ['IPv4 à dernier libellé numérique', 'exemple.123'],
    ['nom de métadonnées', 'metadata.google.internal'],
  ])('refuse : %s', (_name, host) => {
    expect(checkMailHost(host).ok).toBe(false);
  });

  it('reconnaît la boucle locale', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['localhost.evil.test', '128.0.0.1', '10.0.0.1', 'imap.exemple.test', '2130706433', '127.1']) expect(isLoopbackHost(host)).toBe(false);
  });

  it('limite les ports : standards de messagerie ou ≥ 1024', () => {
    for (const port of [143, 993, 1143, 10993, 65535]) expect(isAllowedPort('imap', port)).toBe(true);
    for (const port of [25, 465, 587, 2525, 1025]) expect(isAllowedPort('smtp', port)).toBe(true);
    for (const port of [0, -1, 22, 80, 443, 25, 465, 65536, 1.5, Number.NaN]) expect(isAllowedPort('imap', port)).toBe(false);
    for (const port of [22, 80, 110, 143, 443, 993, 70000]) expect(isAllowedPort('smtp', port)).toBe(false);
  });
});

describe('politique TLS', () => {
  it('TLS implicite si « secure », sinon STARTTLS exigé ; le clair uniquement vers la boucle locale', () => {
    expect(tlsPolicy('imap.exemple.test', true)).toEqual({ implicitTls: true, requireStartTls: false, cleartextAllowed: false });
    expect(tlsPolicy('imap.exemple.test', false)).toEqual({ implicitTls: false, requireStartTls: true, cleartextAllowed: false });
    expect(tlsPolicy('10.0.0.5', false)).toEqual({ implicitTls: false, requireStartTls: true, cleartextAllowed: false });
    expect(tlsPolicy('localhost', false)).toEqual({ implicitTls: false, requireStartTls: false, cleartextAllowed: true });
    expect(tlsPolicy('127.0.0.1', true)).toEqual({ implicitTls: true, requireStartTls: false, cleartextAllowed: false });
  });

  it('options IMAP : TLS implicite, certificat vérifié, journal coupé, délais bornés', () => {
    const options = imapOptions(account(), 'secret');
    expect(options).toMatchObject({ host: 'imap.exemple.test', port: 993, secure: true, logger: false, emitLogs: false, auth: { user: 'support@exemple.test', pass: 'secret' } });
    expect(options.tls).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(options.doSTARTTLS).toBeUndefined();
    expect(options.connectionTimeout).toBeLessThanOrEqual(15_000);
    expect(options.socketTimeout).toBeLessThanOrEqual(60_000);
    expect(options.maxLiteralSize).toBeLessThan(100 * 1024 * 1024);
  });

  it('options IMAP sans TLS implicite : STARTTLS obligatoire (jamais opportuniste)', () => {
    const options = imapOptions(account({ imap_secure: 0, imap_port: 143 }), 'secret');
    expect(options.secure).toBe(false);
    expect(options.doSTARTTLS).toBe(true);
    expect(options.tls?.rejectUnauthorized).toBe(true);
    expect(imapOptions(account({ imap_secure: 0, imap_host: 'localhost' }), 'secret').doSTARTTLS).toBe(false);
  });

  it('options SMTP : secure ou requireTLS, certificat vérifié, aucun accès fichier/URL', () => {
    const implicit = smtpOptions(account(), 'secret');
    expect(implicit).toMatchObject({ host: 'smtp.exemple.test', port: 465, secure: true, disableFileAccess: true, disableUrlAccess: true, logger: false });
    expect(implicit.tls).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });

    const starttls = smtpOptions(account({ smtp_secure: 0, smtp_port: 587 }), 'secret');
    expect(starttls).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });

    const loopback = smtpOptions(account({ smtp_secure: 0, smtp_host: '127.0.0.1', smtp_port: 1025 }), 'secret');
    expect(loopback).toMatchObject({ secure: false, requireTLS: false });
  });
});

describe('schéma des comptes', () => {
  it('accepte un compte valide et normalise l’hôte', () => {
    const parsed = accountCreateBody.parse({ ...validAccount, imapHost: 'IMAP.Exemple.TEST' });
    expect(parsed.imapHost).toBe('imap.exemple.test');
  });

  it.each([
    ['hôte IMAP en URL', { imapHost: 'https://imap.exemple.test' }],
    ['hôte SMTP de métadonnées', { smtpHost: '169.254.169.254' }],
    ['port IMAP non mail', { imapPort: 22 }],
    ['port SMTP non mail', { smtpPort: 80 }],
    ['port en chaîne', { imapPort: '993' }],
    ['port hors limites', { smtpPort: 70000 }],
    ['adresse invalide', { address: 'pas-une-adresse' }],
    ['adresse avec nom affiché', { address: 'Support <support@exemple.test>' }],
    ['libellé avec retour à la ligne', { label: `Support${CRLF}Bcc: x@y.test` }],
    ['identifiant avec retour à la ligne', { username: `user${LF}x` }],
    ['booléen en chaîne', { imapSecure: 'true' }],
    ['mot de passe vide à la création', { password: '' }],
    ['mot de passe avec retour à la ligne', { password: `abc${CRLF}A1 LOGOUT` }],
    ['champ inconnu', { passwordEnc: 'v1:x:y:z' }],
    ['identifiant imposé', { id: 1 }],
  ])('refuse : %s', (_name, patch) => {
    expect(accountCreateBody.safeParse({ ...validAccount, ...patch }).success).toBe(false);
  });

  it('en modification, le mot de passe peut être absent ou vide', () => {
    const { password: _password, ...withoutPassword } = validAccount;
    expect(accountUpdateBody.safeParse(withoutPassword).success).toBe(true);
    expect(accountUpdateBody.safeParse({ ...withoutPassword, password: '' }).success).toBe(true);
    expect(accountCreateBody.safeParse(withoutPassword).success).toBe(false);
  });
});

describe('adresses e-mail', () => {
  it.each(['a@b.co', 'prenom.nom+tag@sous.exemple.test', "o'brien@exemple.test", 'UPPER@EXEMPLE.TEST'])('accepte %j', (address) => {
    expect(isValidEmailAddress(address)).toBe(true);
  });

  it.each([
    'sans-arobase',
    'a@b',
    'a@@b.test',
    'a b@exemple.test',
    'Nom <a@exemple.test>',
    '"a b"@exemple.test',
    'a@exemple.test, b@exemple.test',
    'a@exemple.test;b@exemple.test',
    `a@exemple.test${CRLF}Bcc: victime@exemple.test`,
    `a@exemple.test${LF}`,
    `a${CR}@exemple.test`,
    `a@exemple.test${String.fromCharCode(0)}`,
    '.a@exemple.test',
    'a.@exemple.test',
    'a..b@exemple.test',
    'a@-exemple.test',
    'a@exemple..test',
    `${'a'.repeat(65)}@exemple.test`,
    `a@${'b'.repeat(250)}.test`,
    'a@[127.0.0.1]',
    'é@exemple.test',
    '',
  ])('refuse %j', (address) => {
    expect(isValidEmailAddress(address)).toBe(false);
  });
});

describe('schéma d’envoi : injection d’en-têtes et bornes', () => {
  const valid = { to: ['client@exemple.test'], subject: 'Bonjour', text: `Ligne 1${LF}Ligne 2` };

  it('accepte un envoi valide (les retours à la ligne sont permis dans le texte uniquement)', () => {
    expect(sendBody.safeParse(valid).success).toBe(true);
    expect(sendBody.safeParse({ ...valid, subject: '' }).success).toBe(true);
  });

  it.each([
    ['CRLF dans l’objet', { subject: `Bonjour${CRLF}Bcc: victime@exemple.test` }],
    ['LF dans l’objet', { subject: `Bonjour${LF}Bcc: victime@exemple.test` }],
    ['CR dans l’objet', { subject: `Bonjour${CR}X-Injecte: 1` }],
    ['octet nul dans l’objet', { subject: `Bonjour${String.fromCharCode(0)}` }],
    ['séparateur de ligne Unicode dans l’objet', { subject: `Bonjour${String.fromCharCode(0x2028)}Bcc: x@y.test` }],
    ['NEL dans l’objet', { subject: `Bonjour${String.fromCharCode(0x85)}Bcc: x@y.test` }],
    ['objet trop long', { subject: 'a'.repeat(501) }],
    ['CRLF dans un destinataire', { to: [`client@exemple.test${CRLF}Bcc: victime@exemple.test`] }],
    ['destinataire avec nom affiché', { to: ['Client <client@exemple.test>'] }],
    ['deux adresses dans une entrée', { to: ['a@exemple.test,b@exemple.test'] }],
    ['CRLF en copie', { cc: [`a@exemple.test${LF}Subject: x`] }],
    ['CRLF en copie cachée', { bcc: [`a@exemple.test${CRLF}`] }],
    ['aucun destinataire', { to: [] }],
    ['destinataires non tableau', { to: 'client@exemple.test' }],
    ['expéditeur fourni par le client', { from: 'pdg@exemple.test' }],
    ['expéditeur d’enveloppe fourni', { envelope: { from: 'pdg@exemple.test' } }],
    ['en-têtes fournis', { headers: { Bcc: 'victime@exemple.test' } }],
    ['HTML fourni', { html: '<script>alert(1)</script>' }],
    ['replyTo fourni', { replyTo: 'autre@exemple.test' }],
    ['texte sous forme d’objet (lecture de fichier nodemailer)', { text: { path: '/etc/passwd' } }],
    ['caractère de contrôle dans le texte', { text: `a${String.fromCharCode(0)}b` }],
    ['texte trop long', { text: 'a'.repeat(200_001) }],
    ['inReplyTo avec dossier piégé', { inReplyTo: { folder: `INBOX${CRLF}A1 DELETE x`, uid: 1 } }],
    ['inReplyTo avec uid invalide', { inReplyTo: { folder: 'INBOX', uid: 0 } }],
    ['inReplyTo avec champ en trop', { inReplyTo: { folder: 'INBOX', uid: 1, messageId: '<x@y>' } }],
    ['pièce jointe par chemin', { attachments: [{ filename: 'a.txt', contentType: 'text/plain', path: '/etc/passwd' }] }],
    ['pièce jointe par URL', { attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'YQ==', href: 'http://169.254.169.254/' }] }],
    ['base64 invalide', { attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'pas du base64 !' }] }],
    ['base64 mal complété', { attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'YQ=' }] }],
    ['trop de pièces jointes', { attachments: Array.from({ length: 11 }, () => ({ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'YQ==' })) }],
  ])('refuse : %s', (_name, patch) => {
    expect(sendBody.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('borne le nombre total de destinataires (to + cc + bcc)', () => {
    const list = (n: number, prefix: string) => Array.from({ length: n }, (_v, i) => `${prefix}${i}@exemple.test`);
    expect(sendBody.safeParse({ ...valid, to: list(20, 'a'), cc: list(20, 'b'), bcc: list(10, 'c') }).success).toBe(true);
    expect(sendBody.safeParse({ ...valid, to: list(20, 'a'), cc: list(20, 'b'), bcc: list(11, 'c') }).success).toBe(false);
    expect(sendBody.safeParse({ ...valid, to: list(51, 'a') }).success).toBe(false);
  });

  it('plafonne la taille totale des pièces jointes à 10 Mo', () => {
    const fiveMb = Buffer.alloc(5 * 1024 * 1024).toString('base64');
    const attachment = (contentBase64: string) => ({ filename: 'a.bin', contentType: 'application/octet-stream', contentBase64 });
    expect(sendBody.safeParse({ ...valid, attachments: [attachment(fiveMb), attachment(fiveMb)] }).success).toBe(true);
    expect(sendBody.safeParse({ ...valid, attachments: [attachment(fiveMb), attachment(fiveMb), attachment('YQ==')] }).success).toBe(false);
  });
});

describe('paramètres et dossiers', () => {
  it('valide les identifiants d’URL', () => {
    expect(messageParams.parse({ id: '3', uid: '4294967295' })).toEqual({ id: 3, uid: 4294967295 });
    for (const bad of [{ id: '0', uid: '1' }, { id: '1', uid: '0' }, { id: '-1', uid: '1' }, { id: '1e3', uid: '1' }, { id: '1', uid: '4294967296' }, { id: '1 OR 1=1', uid: '1' }, { id: '1', uid: '1:*' }, { id: '01', uid: '1' }]) {
      expect(messageParams.safeParse(bad).success).toBe(false);
    }
  });

  it('n’accepte que des numéros de partie MIME comme identifiant de pièce jointe', () => {
    for (const ok of ['1', '2', '1.2', '10.3.1']) expect(attachmentParams.safeParse({ id: '1', uid: '1', attachmentId: ok }).success).toBe(true);
    for (const bad of ['', '0', '1.', '.1', '1..2', 'TEXT', '1.MIME', 'HEADER', '1]<0>', '1 2', '../1', '1.2.3.4.5.6.7.8.9.10.11', '1234']) {
      expect(attachmentParams.safeParse({ id: '1', uid: '1', attachmentId: bad }).success).toBe(false);
    }
  });

  it('valide les dossiers : longueur bornée, aucun caractère de contrôle', () => {
    expect(folderQuery.parse({})).toEqual({ folder: 'INBOX' });
    expect(folderQuery.parse({ folder: 'INBOX/Clients & Cie/Été' })).toEqual({ folder: 'INBOX/Clients & Cie/Été' });
    for (const bad of ['', `INBOX${CRLF}A1 LOGOUT`, `INBOX${LF}`, `a${String.fromCharCode(0)}b`, `a${String.fromCharCode(0x7f)}`, 'x'.repeat(256)]) {
      expect(folderQuery.safeParse({ folder: bad }).success).toBe(false);
      expect(moveBody.safeParse({ destination: bad }).success).toBe(false);
    }
    expect(moveBody.safeParse({ destination: 'Archive', extra: 1 }).success).toBe(false);
  });

  it('borne la pagination et la recherche', () => {
    expect(listQuery.parse({})).toEqual({ folder: 'INBOX', page: 1, pageSize: 25, search: undefined });
    expect(listQuery.parse({ page: '3', pageSize: '100', search: '  facture  ' })).toMatchObject({ page: 3, pageSize: 100, search: 'facture' });
    expect(listQuery.parse({ search: '   ' }).search).toBeUndefined();
    for (const bad of [{ pageSize: '101' }, { pageSize: '0' }, { page: '0' }, { page: 'abc' }, { search: 'a'.repeat(101) }, { search: `a${CRLF}A1 LOGOUT` }]) {
      expect(listQuery.safeParse(bad).success).toBe(false);
    }
  });

  it('exige au moins un indicateur, et rien d’autre', () => {
    expect(flagsBody.safeParse({ seen: true }).success).toBe(true);
    expect(flagsBody.safeParse({ flagged: false }).success).toBe(true);
    expect(flagsBody.safeParse({}).success).toBe(false);
    expect(flagsBody.safeParse({ seen: 'true' }).success).toBe(false);
    expect(flagsBody.safeParse({ seen: true, deleted: true }).success).toBe(false);
  });
});

describe('composition du message sortant', () => {
  const input = sendBody.parse({
    to: ['client@exemple.test'],
    cc: ['copie@exemple.test'],
    bcc: ['cachee@exemple.test'],
    subject: 'Réponse à votre demande',
    text: `Bonjour,${LF}${LF}Voici la réponse.`,
    attachments: [{ filename: '../../etc/Reçu "final".pdf', contentType: `text/html${CRLF}X-Injecte: 1`, contentBase64: Buffer.from('contenu').toString('base64') }],
  });

  it('force l’expéditeur (en-tête et enveloppe) à l’adresse du compte', () => {
    const message = buildOutgoingMessage(account(), input, null);
    expect(message.options.from).toEqual({ name: 'Support', address: 'support@exemple.test' });
    expect(message.options.envelope).toEqual({ from: 'support@exemple.test', to: ['client@exemple.test', 'copie@exemple.test', 'cachee@exemple.test'] });
    expect(message.options).toMatchObject({ disableFileAccess: true, disableUrlAccess: true });
    expect(message.options.html).toBeUndefined();
    expect(message.messageId).toMatch(/^<[0-9a-f-]{36}@exemple\.test>$/);
  });

  it('assainit le nom et le type des pièces jointes', () => {
    const message = buildOutgoingMessage(account(), input, null);
    expect(message.options.attachments).toEqual([{ filename: 'Reçu _final_.pdf', content: Buffer.from('contenu'), contentType: 'application/octet-stream', contentDisposition: 'attachment' }]);
  });

  it('produit un message brut sans en-tête injecté, Bcc conservé pour la copie « Envoyés »', async () => {
    const message = buildOutgoingMessage(account({ label: `Support${CRLF}Bcc: intrus@evil.test` }), input, { messageId: '<orig@client.test>', references: ['<a@x>', '<orig@client.test>', '<b@x>'] });
    const raw = (await buildRawCopy(message)).toString('utf8');
    const head = raw.slice(0, raw.indexOf(`${CRLF}${CRLF}`));
    const headerNames = head
      .split(CRLF)
      .filter((line) => /^\S/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')).toLowerCase());
    expect(headerNames.sort()).toEqual(['bcc', 'cc', 'content-type', 'date', 'from', 'in-reply-to', 'message-id', 'mime-version', 'references', 'subject', 'to'].sort());
    expect(raw).not.toContain('intrus@evil.test>\r\n');
    expect(head).not.toMatch(/^X-Injecte/im);

    const parsed = await simpleParser(raw);
    expect(parsed.from?.value.map((a) => a.address)).toEqual(['support@exemple.test']);
    expect(parsed.headers.has('x-injecte')).toBe(false);
    expect(parsed.bcc && !Array.isArray(parsed.bcc) ? parsed.bcc.value.map((a) => a.address) : null).toEqual(['cachee@exemple.test']);
    expect(parsed.inReplyTo).toBe('<orig@client.test>');
    expect(parsed.references).toEqual(['<a@x>', '<b@x>', '<orig@client.test>']);
    expect(parsed.subject).toBe('Réponse à votre demande');
    expect(parsed.html).toBe(false);
    expect(parsed.attachments.map((a) => [a.filename, a.contentDisposition])).toEqual([['Reçu _final_.pdf', 'attachment']]);
    // Le type piégé (« text/html » + en-tête injecté) n'est pas repris : nodemailer le déduit de l'extension.
    expect(parsed.attachments[0]!.contentType).toBe('application/pdf');
  });

  it('refuse de composer si une valeur d’en-tête piégée a contourné le schéma (défense en profondeur)', () => {
    expect(() => buildOutgoingMessage(account(), { ...input, subject: `x${CRLF}Bcc: y@z.test` }, null)).toThrow();
    expect(() => buildOutgoingMessage(account(), { ...input, to: [`a@exemple.test${LF}Bcc: y@z.test`] }, null)).toThrow();
    expect(() => buildOutgoingMessage(account(), { ...input, to: [] }, null)).toThrow();
    expect(() => buildOutgoingMessage(account({ address: `support@exemple.test${CRLF}` }), input, null)).toThrow();
  });

  it('n’ajoute ni In-Reply-To ni References sans Message-ID d’origine exploitable', () => {
    const message = buildOutgoingMessage(account(), input, { messageId: null, references: ['<a@x>'] });
    expect(message.options.inReplyTo).toBeUndefined();
    expect(message.options.references).toBeUndefined();
  });
});

describe('erreurs IMAP/SMTP', () => {
  it('classe les erreurs par catégorie', () => {
    expect(classifyMailError({ authenticationFailed: true })).toBe('auth');
    expect(classifyMailError({ code: 'EAUTH' })).toBe('auth');
    expect(classifyMailError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).toBe('tls');
    expect(classifyMailError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe('tls');
    expect(classifyMailError({ tlsFailed: true })).toBe('tls');
    expect(classifyMailError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyMailError({ code: 'CONNECT_TIMEOUT' })).toBe('timeout');
    expect(classifyMailError({ code: 'ECONNREFUSED' })).toBe('network');
    expect(classifyMailError({ code: 'ENOTFOUND' })).toBe('network');
    expect(classifyMailError({ code: 'EENVELOPE' })).toBe('rejected');
    expect(classifyMailError(new Error('x'))).toBe('unknown');
    expect(classifyMailError(null)).toBe('unknown');
    expect(classifyMailError('chaîne')).toBe('unknown');
  });

  it('ne reprend jamais le texte de l’erreur d’origine', () => {
    const secret = 'p4ssw0rd-TRES-secret';
    const raw = Object.assign(new Error(`A1 NO [AUTHENTICATIONFAILED] LOGIN support@exemple.test ${secret} failed at imap.exemple.test:993`), {
      authenticationFailed: true,
      response: `A1 NO LOGIN ${secret}`,
      responseText: `Invalid credentials for ${secret}`,
      serverResponseCode: 'AUTHENTICATIONFAILED',
    });
    for (const err of [raw, Object.assign(new Error(`535 5.7.8 ${secret}`), { code: 'EAUTH', response: `535 ${secret}` }), new Error(secret), secret]) {
      const converted = toMailError(err);
      const serialized = JSON.stringify({ message: converted.message, details: converted.details, code: converted.code });
      expect(converted.statusCode).toBe(502);
      expect(converted.code).toBe('UPSTREAM_ERROR');
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('exemple.test');
      expect(serialized).not.toMatch(/LOGIN|NO \[|535/);
    }
    expect(toMailError(raw).details).toEqual({ integration: 'mail', reason: 'auth' });
  });

  it('un dossier inexistant devient un 404', () => {
    const converted = toMailError(Object.assign(new Error('Mailbox does not exist'), { mailboxMissing: true }));
    expect(converted.statusCode).toBe(404);
    expect(converted.message).toBe('Dossier introuvable');
  });
});

# Architecture — TalCloud Panel

Panel d'administration auto-hébergé pour une activité d'hébergeur : WHMCS, notifications de commandes, mails,
Pterodactyl, Proxmox. Deux comptes administrateurs au maximum, aucun accès public.

Ce document est le **contrat commun** : toute contribution (humaine ou agent) s'y conforme.

## 1. Structure des dossiers

```
├── shared/api-types.ts        Contrat d'API typé (DTO) — importé en `import type` par server/ et web/
├── server/                    Backend Node.js 22 + Fastify 5 + SQLite (better-sqlite3), TypeScript ESM
│   ├── src/
│   │   ├── index.ts           Démarrage HTTP
│   │   ├── app.ts             Construction de l'app : gestion d'erreurs, plugin de sécurité, modules, fichiers statiques
│   │   ├── config.ts          Lecture et validation du .env (zod) → objet `config`
│   │   ├── db/
│   │   │   ├── index.ts       Connexion SQLite `db`, exécution des migrations, `transaction()`
│   │   │   └── migrations.ts  Schéma commun (toutes les tables) + agrégation des migrations de modules
│   │   ├── core/              Briques transverses (voir §4)
│   │   ├── types/fastify.d.ts `request.auth`, `request.client`, options de sécurité par route
│   │   ├── modules/
│   │   │   ├── auth/          plugin.ts (sécurité globale) · index.ts (routes /api/auth, /api/security) · schema.ts
│   │   │   ├── whmcs/         index.ts (routes) · service.ts (interface pour les autres modules) · schema.ts
│   │   │   ├── notifications/ index.ts · service.ts (`notify()`) · schema.ts
│   │   │   ├── mail/          index.ts · schema.ts
│   │   │   ├── pterodactyl/   index.ts · schema.ts
│   │   │   └── proxmox/       index.ts · schema.ts
│   │   └── cli/index.ts       CLI d'installation et de secours (création des comptes, déverrouillage…)
│   └── test/                  Tests vitest
├── web/                       Frontend React 18 + Vite + Tailwind 3 + composants shadcn/ui
├── whmcs-hook/                Hook PHP à déposer dans WHMCS (notifications de commandes / paiements)
├── Dockerfile · docker-compose.yml · Caddyfile · .env.example · README.md
```

Chaque module backend est **propriétaire de son dossier** `server/src/modules/<nom>/` et n'écrit pas ailleurs.
Un module peut ajouter autant de fichiers internes qu'il veut (client.ts, cache.ts…).

## 2. Stack et conventions de code

- TypeScript strict, ESM, imports relatifs avec extension `.js` (`import { db } from '../../db/index.js'`),
  types partagés via `import type { … } from '@shared/api-types'`.
- Validation de **toutes** les entrées (body, query, params) avec **zod v4** : `schema.parse(request.body)`.
  Une `ZodError` non rattrapée devient automatiquement un 400 `VALIDATION_ERROR`.
- SQL : uniquement des requêtes préparées à paramètres liés (`db.prepare('… WHERE id = ?').get(id)`).
  Jamais de concaténation d'une valeur externe. Dates stockées en entiers (ms Unix UTC).
- HTTP sortant : `upstreamFetch` / `upstreamJson` de `core/http.ts` (délai maximal, erreurs normalisées).
- Erreurs : lever un `AppError` via les fabriques de `core/errors.ts` (`badRequest`, `notFound`, `notConfigured`,
  `upstream`…). Ne jamais renvoyer au client un message d'erreur brut d'une API distante ni une trace.
- Dépendances : toutes déjà installées (voir package.json). Ne pas lancer `npm install` sans nécessité absolue.
- Commentaires et messages destinés à l'utilisateur en **français**.

## 3. Format des routes API

- Préfixe `/api`, JSON uniquement.
- Succès : `{ "data": T, "meta"?: { page, pageSize, total } }` — Erreur : `{ "error": { code, message, details? } }`.
- Codes d'erreur : voir `ApiErrorCode` dans `shared/api-types.ts`.
- Pagination : `?page=1&pageSize=25` (page ≥ 1, pageSize ≤ 100). Dates en ISO 8601 dans les réponses.
- Les formes exactes des requêtes et réponses sont dans `shared/api-types.ts` : **c'est la référence**, le backend
  les produit et le frontend les consomme telles quelles.

### Table des routes

| Module | Route | Notes |
|---|---|---|
| auth | `GET /api/auth/session` | publique, toujours 200 → `SessionState` |
| auth | `POST /api/auth/login` · `/login/verify` · `/login/confirm-device` · `/login/resend-email` | publiques → `LoginStepResponse` |
| auth | `POST /api/auth/logout` · `POST /api/auth/step-up` | |
| auth | `GET /api/security/sessions` · `DELETE /api/security/sessions/:id` · `POST /api/security/sessions/revoke-others` | |
| auth | `GET /api/security/audit` | journal du compte connecté (+ évènements non attribués) |
| auth | `GET /api/security/devices` · `DELETE /api/security/devices/:id` | |
| auth | `GET /api/security/ip-allowlist` · `PUT` (step-up) | |
| auth | `POST /api/security/password` (step-up) | |
| auth | `POST /api/security/totp/regenerate` (step-up) · `POST /api/security/totp/confirm` | |
| auth | `GET /api/security/backup-codes` · `POST /api/security/backup-codes/regenerate` (step-up) | |
| * | `GET /api/settings/:ns` · `PUT` (step-up) · `POST /api/settings/:ns/test` (step-up) | ns ∈ whmcs, pterodactyl, proxmox, notifications — via `registerSettingsRoutes` |
| whmcs | `GET /api/whmcs/stats/overview` · `GET /api/whmcs/stats/monthly?months=12` | |
| whmcs | `GET /api/whmcs/clients` · `GET /api/whmcs/clients/:id` · `GET /api/whmcs/orders` · `GET /api/whmcs/invoices` | `?search&status&page&pageSize` |
| whmcs | `GET/POST /api/whmcs/costs` · `PUT/DELETE /api/whmcs/costs/:id` | |
| notifications | `POST /api/webhooks/whmcs` | publique, signée HMAC, sans CSRF |
| notifications | `GET /api/notifications` · `GET /api/notifications/unread-count` · `POST /api/notifications/:id/read` · `POST /api/notifications/read-all` | |
| notifications | `GET /api/events` | flux SSE (`ServerEvent`) |
| notifications | `GET /api/push/public-key` · `POST /api/push/subscribe` · `POST /api/push/unsubscribe` · `POST /api/push/test` | |
| mail | `GET/POST /api/mail/accounts` · `PUT/DELETE /api/mail/accounts/:id` · `POST /api/mail/accounts/:id/test` | écritures en step-up |
| mail | `GET /api/mail/accounts/:id/folders` · `GET …/messages` · `GET …/messages/:uid` | `?folder=INBOX` |
| mail | `GET …/messages/:uid/attachments/:attachmentId` · `POST …/messages/:uid/flags` · `POST …/messages/:uid/move` · `DELETE …/messages/:uid` | |
| mail | `POST /api/mail/accounts/:id/send` · `GET /api/mail/unread-summary` | |
| pterodactyl | `GET /api/pterodactyl/servers` · `GET /api/pterodactyl/servers/:id` · `GET /api/pterodactyl/summary` | |
| pterodactyl | `POST /api/pterodactyl/servers/:id/power` · `/suspend` · `/unsuspend` | stop, restart, kill, suspend en step-up |
| proxmox | `GET /api/proxmox/nodes` · `GET /api/proxmox/guests` · `GET /api/proxmox/summary` · `GET /api/proxmox/nodes/:node/history` | |
| proxmox | `POST /api/proxmox/guests/:node/:type/:vmid/action` | shutdown, stop, reboot en step-up |

La page d'accueil n'a pas de route dédiée : le frontend compose `stats/overview`, `orders`, `unread-summary`,
`pterodactyl/summary` et `proxmox/summary`, de sorte qu'une intégration en panne n'empêche pas d'afficher les autres.

## 4. Briques transverses (`server/src/core/`)

| Fichier | Rôle |
|---|---|
| `crypto.ts` | `encrypt/decrypt` (AES-256-GCM, AAD de contexte), `encryptJson/decryptJson`, `hmac`, `sha256`, `randomToken`, `randomDigits`, `safeEqual` |
| `settings.ts` | `getSettings<T>(ns)` / `setSettings(ns, value, userId)` — réglages d'intégration chiffrés en base |
| `settings-routes.ts` | `registerSettingsRoutes(app, { namespace, schema, secretFields, isConfigured, test, onChange })` |
| `errors.ts` | `AppError` et fabriques |
| `http.ts` | `upstreamFetch`, `upstreamJson`, `normalizeBaseUrl` |
| `events.ts` | bus temps réel `publish({ event, userId?, sessionId? })` / `subscribe(listener)` (alimentant le flux SSE) |
| `audit.ts` | `audit(request, { action, target, success, details })` — journal en ajout seul |
| `request.ts` | `currentUser(request)`, `assertStepUp(request)` |

Interfaces entre modules (signatures figées) :
- `modules/whmcs/service.ts` : `isWhmcsConfigured()`, `findClientByEmail(email)`, `findClientsByEmails(emails)`.
- `modules/notifications/service.ts` : `notify({ type, severity, title, body, data, userId, channels })`.

## 5. Modèle de sécurité

**Sécurisé par défaut** : le plugin `modules/auth/plugin.ts` applique à *toute* route `/api` — sans action du module :

1. en-têtes de sécurité (Helmet, CSP stricte, HSTS) et refus du HTTP en clair en production ;
2. liste blanche d'IP (variable `IP_ALLOWLIST` + liste gérée dans le panel) ;
3. limitation de débit globale, renforcée sur l'authentification ;
4. session obligatoire (cookie opaque `HttpOnly; Secure; SameSite=Strict`, expiration d'inactivité et absolue) ;
5. contrôle CSRF sur toute méthode autre que GET/HEAD/OPTIONS : en-tête `Origin` égal à `PUBLIC_URL` **et**
   en-tête `X-CSRF-Token` égal au jeton de la session.

Une route déroge uniquement via sa configuration (`server/src/types/fastify.d.ts`) :

```ts
app.post('/api/x', { config: { stepUp: true } }, handler);     // exige un TOTP récent → sinon 403 STEP_UP_REQUIRED
app.get('/api/y', { config: { background: true } }, handler);  // ne prolonge pas la session (interrogation périodique)
app.post('/api/webhooks/z', { config: { public: true, skipCsrf: true, skipIpAllowlist: true } }, handler);
```

- `request.auth` (`{ user, sessionId, stepUpUntil }`) est non nul dans toute route non publique ; `request.client`
  (`{ ip, userAgent, country, deviceId }`) est toujours présent.
- Une requête portant l'en-tête `X-TC-Background: 1` (rafraîchissements automatiques du frontend) ne prolonge pas
  la session, afin que l'expiration d'inactivité reste effective.
- **Step-up** : les actions critiques (arrêt / redémarrage / kill / suspension d'un serveur, réglages, clés API, comptes mail,
  mot de passe, 2FA, liste blanche) exigent `config.stepUp` ou `assertStepUp(request)`. Le frontend répond à
  `STEP_UP_REQUIRED` en demandant le code TOTP, appelle `POST /api/auth/step-up`, puis rejoue la requête.
- **Journal** : toute action modifiant un état appelle `audit()` (succès et échecs), sans jamais y mettre de secret.
- **Secrets** : clés API, mots de passe IMAP/SMTP, secrets TOTP sont chiffrés en base (AES-256-GCM, clé `MASTER_KEY`)
  et ne sortent jamais du serveur : les routes de réglages renvoient seulement « défini / non défini ». Changer la
  destination d'une intégration (URL, TLS) exige de ressaisir ses clés (`destinationFields`), pour qu'une session
  détournée ne puisse pas se les faire envoyer ; toute modification de réglages alerte les deux administrateurs.
- **Comptes** : créés uniquement par la CLI à l'installation ; un déclencheur SQL interdit un troisième compte ;
  aucune route HTTP ne crée, supprime ou liste des comptes.
- **Connexion** : mot de passe (Argon2id) → code mail **et** TOTP (ou code de secours) → si appareil, IP ou pays
  inconnu, second code mail de confirmation → session. Verrouillage temporaire croissant après échecs répétés.
- **Alertes** : connexion réussie, échec, verrouillage, contexte inhabituel → mail aux deux administrateurs +
  webhook Discord de sécurité + notification dans le panel.
- **Contenu non fiable** (mails, noms venant de WHMCS/Pterodactyl/Proxmox) : jamais injecté en HTML ; le HTML des
  mails est assaini côté serveur et affiché dans une iframe `sandbox`.
- **Requêtes sortantes** : les URL d'intégration sont saisies par un administrateur (step-up) ; les identifiants
  insérés dans un chemin d'URL distante sont validés (zod) et encodés (`encodeURIComponent`).

## 6. Base de données

SQLite (fichier `DATA_DIR/talcloud.db`, mode WAL). Schéma complet commenté dans `server/src/db/migrations.ts` :
`users`, `backup_codes`, `login_challenges`, `sessions`, `known_devices`, `known_ips`, `auth_failures`, `audit_log`,
`integration_settings`, `costs`, `notifications`, `notification_reads`, `push_subscriptions`, `webhook_events`,
`mail_accounts`.

Une migration appliquée n'est jamais modifiée. Un module qui a besoin d'une table supplémentaire l'ajoute dans son
`schema.ts` (identifiant préfixé par le nom du module ; ce fichier n'importe pas `db/index.ts`).

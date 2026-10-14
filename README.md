# TalCloud Panel

Panel d'administration auto-hébergé qui centralise la gestion d'une activité d'hébergeur : statistiques et
facturation **WHMCS**, **notifications de commandes**, **boîtes mail**, serveurs de jeu **Pterodactyl** et
virtualisation **Proxmox VE**, derrière une authentification renforcée réservée à deux administrateurs.

- Backend : Node.js 22, Fastify 5, SQLite — `server/`
- Frontend : React 18, Vite, Tailwind, composants shadcn/ui — `web/`
- Déploiement : Docker + docker-compose, HTTPS automatique par Caddy
- Architecture détaillée et contrat d'API : [ARCHITECTURE.md](ARCHITECTURE.md)

## Sommaire

1. [Installation](#1-installation)
2. [Création des comptes administrateurs](#2-création-des-comptes-administrateurs)
3. [Configuration des intégrations](#3-configuration-des-intégrations)
4. [Hook WHMCS (notifications de commandes)](#4-hook-whmcs-notifications-de-commandes)
5. [Sécurité](#5-sécurité)
6. [Exploitation : sauvegarde, mise à jour, secours](#6-exploitation)
7. [Développement local](#7-développement-local)
8. [Limites connues](#8-limites-connues)

---

## 1. Installation

### Prérequis

- Un serveur Linux avec Docker et le plugin `docker compose`.
- Un nom de domaine (ex. `panel.exemple.com`) pointant vers ce serveur, ports **80** et **443** ouverts
  (Caddy obtient le certificat Let's Encrypt tout seul).
- Un compte SMTP pour l'envoi des codes de connexion et des alertes (**obligatoire** : sans lui, personne ne peut
  se connecter, puisque chaque connexion exige un code reçu par mail).

### Étapes

```bash
git clone <ce dépôt> talcloud-panel && cd talcloud-panel
cp .env.example .env
```

Renseignez `.env` :

| Variable | Rôle |
|---|---|
| `DOMAIN` | Nom de domaine du panel (pour Caddy). |
| `PUBLIC_URL` | URL publique exacte, `https://` + le domaine, sans slash final. Toute requête arrivant par une autre origine est refusée. |
| `MASTER_KEY` | Clé de chiffrement AES-256 des secrets en base. `openssl rand -hex 32` |
| `SESSION_SECRET` | Secret des jetons de session et des codes. `openssl rand -base64 48` |
| `TRUST_PROXY` | `172.30.0.2` avec le docker-compose fourni : l'IP fixe de Caddy, seul pair dont l'IP client annoncée est crue. Jamais `true` ni une large plage (refusé en production). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | SMTP du panel. `SMTP_SECURE=true` pour le port 465, `false` pour 587 (STARTTLS alors exigé). |
| `SECURITY_DISCORD_WEBHOOK_URL` | (optionnel) Webhook Discord recevant les alertes de sécurité. |
| `IP_ALLOWLIST` | (optionnel) IP ou CIDR autorisés, séparés par des virgules. Vide = pas de filtrage. |
| `WHMCS_HOOK_SECRET`, `WHMCS_HOOK_IPS` | Secret et IP du hook WHMCS, voir [§4](#4-hook-whmcs-notifications-de-commandes). |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`, `STEP_UP_MINUTES` | Durées de session (défaut 15 min d'inactivité, 8 h au total, 5 min de re-confirmation). |
| `GEOIP_DB_PATH`, `TRUST_CF_COUNTRY_HEADER` | (optionnel) Pays des connexions, voir [§5](#5-sécurité). |
| `TZ` | Fuseau horaire, à aligner sur celui de WHMCS. |

> **Conservez `MASTER_KEY` en lieu sûr, hors du serveur.** Sans elle, les clés API, mots de passe de messagerie et
> secrets 2FA enregistrés en base sont irrécupérables.

Construisez et démarrez :

```bash
docker compose up -d --build
docker compose logs -f panel     # le panel refuse de démarrer si la configuration est invalide, et dit pourquoi
```

Créez ensuite les comptes ([§2](#2-création-des-comptes-administrateurs)) puis ouvrez `https://panel.exemple.com`.

---

## 2. Création des comptes administrateurs

Il n'existe **aucune inscription** : les comptes se créent uniquement en ligne de commande, sur le serveur.
Le panel accepte **deux comptes au maximum** ; un déclencheur en base interdit le troisième, et aucune page ni
route du panel ne permet d'en créer.

```bash
docker compose run --rm panel node dist/cli.js create-admin
```

La commande demande un nom d'utilisateur, une adresse e-mail et un mot de passe (≥ 14 caractères, avec minuscule,
majuscule, chiffre et symbole), puis :

1. affiche un **QR code** à scanner avec Google Authenticator, Authy, 1Password… ;
2. exige un code à 6 chiffres de l'application pour confirmer, **avant** d'enregistrer le compte ;
3. affiche **10 codes de secours** à usage unique — notez-les, ils ne seront plus jamais affichés.

Répétez la commande pour le second administrateur. Chaque compte a son mot de passe, sa 2FA, ses codes de secours
et son journal d'activité ; chaque connexion de l'un est signalée à l'autre.

### Se connecter

1. Identifiant + mot de passe.
2. Code reçu **par mail** *et* code de l'application **TOTP** (ou un code de secours à la place du TOTP) — les deux
   sont exigés à chaque connexion.
3. Depuis un appareil, une IP ou un pays inconnu : un second code, envoyé dans un mail qui détaille l'origine de
   la tentative.

---

## 3. Configuration des intégrations

Les clés API se saisissent dans le panel, page **Réglages**. Elles sont chiffrées en base (AES-256-GCM) et ne sont
**jamais renvoyées au navigateur** : l'interface indique seulement « défini / non défini ». Modifier un réglage
demande une re-confirmation par code 2FA. Chaque section a un bouton **Tester la connexion**.

### WHMCS

1. Dans WHMCS : *Configuration → System Settings → Manage Admins → API Credentials* (ou *Setup → Staff Management →
   Manage API Credentials*). Créez un **rôle API** limité aux actions de lecture suivantes :
   `GetClients`, `GetClientsDetails`, `GetClientsProducts`, `GetOrders`, `GetInvoices`, `GetTransactions`,
   `GetCurrencies`. Le panel n'écrit jamais dans WHMCS.
2. Générez un **identifiant** et un **secret** pour ce rôle.
3. Dans *General Settings → Security → API IP Access Restriction*, ajoutez l'IP du serveur du panel
   (ou définissez une *API Access Key* dans `configuration.php` et saisissez-la dans le panel).
4. Dans le panel : URL de WHMCS (ex. `https://client.exemple.com`, sans `/includes/api.php`), identifiant, secret.

**Comment les chiffres sont calculés**

- **Chiffre d'affaires** : encaissements réels — somme des transactions du mois (entrées − sorties), donc
  remboursements déduits le mois où ils ont lieu. C'est de l'encaissé, pas du facturé.
- **Coûts** : ceux que vous saisissez dans *WHMCS → Coûts* (mensuel, annuel réparti en 1/12 par mois, ou ponctuel)
  **plus** les frais de passerelle relevés sur les transactions. Ne ressaisissez donc pas ces frais à la main.
- **Bénéfice net** : chiffre d'affaires − coûts. Ni TVA ni impôts ne sont pris en compte.
- **Devises** : tout est ramené à la devise par défaut de WHMCS ; les coûts saisis sont supposés dans cette devise.
- **Impayés** : factures au statut *Unpaid*, échues ou non.

### Pterodactyl

Deux clés sont nécessaires :

- **Clé Application** (`ptla_…`) — *Admin → Application API*. Permissions : **Servers : Read & Write**,
  **Users : Read**, **Nodes : Read**, tout le reste à *None*.
- **Clé Client** (`ptlc_…`) — *Account → API Credentials*, depuis un compte **administrateur** (root admin) :
  elle donne l'état, les ressources et les commandes d'alimentation de tous les serveurs.

Restreignez les deux clés à l'IP du serveur du panel (« Allowed IPs »). Le lien entre un serveur et son client
WHMCS se fait par l'adresse e-mail du propriétaire du serveur.

### Proxmox VE

1. *Datacenter → Permissions → Roles* : créez un rôle `TalCloudPanel` avec `VM.Audit`, `VM.PowerMgmt`, `Sys.Audit`.
2. *Datacenter → Permissions → Users* : créez un utilisateur dédié (ex. `panel@pve`).
3. *Datacenter → Permissions → API Tokens* : créez un jeton (ex. `panel@pve!talcloud`) et copiez son secret.
4. *Datacenter → Permissions → Add → API Token Permission* : chemin `/`, le jeton, le rôle `TalCloudPanel`,
   *Propagate* coché. Avec la séparation des privilèges (défaut), la permission doit être posée **sur le jeton** :
   sinon le test réussit mais les listes reviennent vides.
5. Dans le panel : URL (ex. `https://pve.exemple.com:8006`), identifiant du jeton, secret.

**Certificat auto-signé** : collez le certificat de la CA de Proxmox (`/etc/pve/pve-root-ca.pem`) dans le champ
*Certificat CA* plutôt que de désactiver la vérification TLS — la désactiver expose le jeton à une interception.

### Boîtes mail (IMAP / SMTP)

Page *Réglages → Comptes mail* : ajoutez autant d'adresses que nécessaire (support, contact, facturation…) avec
hôte et port IMAP, hôte et port SMTP, identifiant et mot de passe. Une connexion chiffrée est exigée (TLS implicite
ou STARTTLS). Pour Gmail, Outlook ou tout fournisseur avec 2FA, utilisez un **mot de passe d'application**.

Quand l'expéditeur d'un mail correspond à l'adresse d'un client WHMCS, sa fiche est proposée à côté du message.
Les images distantes des mails sont bloquées (anti-pistage) et le HTML est assaini avant affichage.

### Notifications

Page *Réglages → Notifications* : webhook Discord (URL `https://discord.com/api/webhooks/…`), types d'évènements,
**correspondance passerelle → compte qui encaisse** (ex. `stripe` → « Stripe — TalCloud SAS », `paypal` →
« PayPal contact@… ») et activation des notifications push du navigateur.

---

## 4. Hook WHMCS (notifications de commandes)

Le hook prévient le panel à chaque **nouvelle commande** et à chaque **facture payée** ; le panel affiche alors une
notification (client, produits, montant, moyen de paiement, compte qui encaisse), et la relaie sur Discord et en
push selon vos réglages.

1. Dans `.env` du panel :
   ```
   WHMCS_HOOK_SECRET=<openssl rand -hex 32>
   WHMCS_HOOK_IPS=<IP du serveur WHMCS>     # recommandé
   ```
   puis `docker compose up -d`. Sans secret, la route du webhook est désactivée (404).
2. Copiez [whmcs-hook/talcloud_notify.php](whmcs-hook/talcloud_notify.php) dans `<WHMCS>/includes/hooks/`.
3. Indiquez l'URL du panel et le secret, de préférence dans un fichier **hors de la racine web** :
   ```php
   <?php
   return array(
       'url'    => 'https://panel.exemple.com',
       'secret' => 'la-même-valeur-que-WHMCS_HOOK_SECRET',
   );
   ```
   et donnez son chemin dans `'config_file'` en tête du hook.
4. Dans le panel, associez chaque passerelle au compte qui encaisse (*Réglages → Notifications*).
5. Passez une commande de test.

Chaque appel est signé (HMAC-SHA256 du corps horodaté), refusé s'il a plus de 5 minutes d'écart ou s'il a déjà été
reçu. Le hook ne ralentit ni ne fait échouer une commande : en cas d'erreur, il écrit une ligne « TalCloud Panel
(hook) » dans le journal d'activité de WHMCS. Diagnostic détaillé : [whmcs-hook/README.md](whmcs-hook/README.md).

---

## 5. Sécurité

| Mesure | Détail |
|---|---|
| Mots de passe | Argon2id ; politique forte imposée. |
| Double authentification | Code mail **et** TOTP à chaque connexion ; codes TOTP non rejouables ; 10 codes de secours à usage unique. |
| Nouveau contexte | Second code mail depuis un appareil, une IP ou un pays inconnu. |
| Anti-intrusion | 5 mauvais mots de passe depuis des appareils inconnus → connexions depuis tout appareil inconnu bloquées 15 min (durée doublée à chaque récidive, plafond 24 h) ; vos appareils déjà confirmés et vos sessions ouvertes ne sont pas touchés. 5 échecs après le mot de passe (codes, re-confirmation) ou depuis un appareil connu → compte entièrement verrouillé, même barème. IP bloquée après 10 échecs en 15 min ; limitation de débit. |
| Liste blanche d'IP | `IP_ALLOWLIST` et/ou page *Sécurité*. Le panel refuse une liste qui exclurait votre IP du moment. |
| Sessions | Cookie `HttpOnly; Secure; SameSite=Strict`, jeton haché en base, expiration d'inactivité et absolue, révocation à distance. |
| Web | Jeton CSRF + contrôle d'origine sur toute écriture, CSP stricte, HSTS, Helmet, HTTPS obligatoire, requêtes SQL préparées. |
| Actions critiques | Re-confirmation TOTP pour : arrêt / redémarrage / kill / suspension d'un serveur, réglages et clés API, comptes mail, mot de passe, 2FA, liste blanche. |
| Clés API | Changer l'URL d'une intégration oblige à ressaisir ses clés : une session détournée ne peut pas se les faire envoyer ailleurs. Toute modification de réglages alerte les deux administrateurs. |
| Journal | Toutes les connexions et actions (date, IP, pays, appareil), en ajout seul, propre à chaque compte. |
| Alertes | Mail + Discord + notification à chaque connexion réussie, échec, verrouillage ou changement de sécurité. |
| Secrets | Chiffrés AES-256-GCM en base, jamais envoyés au navigateur. |
| Conteneur | Utilisateur non-root, système de fichiers en lecture seule, aucune capacité Linux, port non publié. |

**Pays des connexions** (optionnel) : montez une base MaxMind *GeoLite2-Country* dans le conteneur et indiquez son
chemin dans `GEOIP_DB_PATH`, ou, derrière Cloudflare uniquement, `TRUST_CF_COUNTRY_HEADER=true`. Sans cela, le pays
reste inconnu ; la vérification « nouvelle IP » couvre de toute façon ce cas.

**Recommandations** : activez la liste blanche d'IP ou placez le panel derrière un VPN ; utilisez des adresses
e-mail d'administration protégées elles-mêmes par 2FA ; restreignez par IP toutes les clés API côté WHMCS,
Pterodactyl et Proxmox.

---

## 6. Exploitation

### Commandes de secours

À lancer sur le serveur — elles supposent un accès shell et sont inscrites au journal :

```bash
docker compose run --rm panel node dist/cli.js <commande>
```

| Commande | Effet |
|---|---|
| `list-admins` | Liste les comptes et leur état. |
| `unlock <utilisateur>` | Lève un verrouillage. |
| `reset-password <utilisateur>` | Nouveau mot de passe. |
| `reset-2fa <utilisateur>` | Nouveau secret TOTP et nouveaux codes de secours (téléphone perdu). |
| `revoke-sessions <utilisateur>` | Ferme toutes ses sessions. |
| `clear-ip-allowlist` | Vide la liste blanche gérée dans le panel (en cas d'enfermement). |

### Sauvegarde

Toutes les données sont dans le volume `panel_data` (base SQLite). Sauvegardez-le **avec** votre `MASTER_KEY` :

```bash
docker compose stop panel
docker run --rm -v talcloud-panel_panel_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/panel-$(date +%F).tar.gz -C /data .
docker compose start panel
```

(le préfixe du volume est le nom du dossier du projet ; vérifiez-le avec `docker volume ls`).

### Mise à jour

```bash
git pull && docker compose up -d --build
```

Les migrations de base s'appliquent automatiquement au démarrage.

> Depuis la version qui lie les notifications push à l'appareil, les abonnements push existants sont effacés à la
> mise à jour : réactivez le push dans *Réglages → Notifications* sur chaque navigateur concerné.

---

## 7. Développement local

Prérequis : Node.js 22.

```bash
cp .env.example .env
```

Dans `.env` : `PUBLIC_URL=http://localhost:5173`, `TRUST_PROXY=false`, une `MASTER_KEY` et un `SESSION_SECRET`,
et laissez `SMTP_HOST` vide — hors production, les mails (codes compris) s'affichent dans la console du serveur.

```bash
cd server && npm install
npm run cli -- create-admin      # dans un vrai terminal
npm run dev                      # API sur http://localhost:8080

cd ../web && npm install
npm run dev                      # interface sur http://localhost:5173 (relaie /api vers le backend)
```

Vérifications : `npm run typecheck` et `npm test` dans `server/`, `npm run build` dans `web/`.

---

## 8. Limites connues

- **Intégrations non testées sur des instances réelles.** Les clients WHMCS, Pterodactyl, Proxmox, IMAP/SMTP,
  Discord et push sont couverts par des tests contre des API simulées. Un écart de format avec votre version reste
  possible : utilisez « Tester la connexion » et signalez toute anomalie.
- **WHMCS** : la recherche dans les commandes et factures porte sur les 1000 plus récentes ; au-delà de 50 000
  lignes par source, les statistiques sont marquées « tronquées ». Le lien vers l'admin WHMCS suppose le dossier
  `/admin` par défaut.
- **Hook** : pas de nouvelle tentative si le panel est injoignable au moment d'une commande (elle reste visible
  dans la page Commandes).
- **Verrouillage** : pendant une attaque par mots de passe faux, la connexion depuis un appareil jamais confirmé
  (nouveau navigateur, cookies effacés) est bloquée et répond « identifiants incorrects » même avec le bon mot de
  passe ; un mail d'alerte vous en informe. Vos appareils connus continuent de fonctionner. Parades : commande
  `unlock`, liste blanche d'IP.
- **Instance unique** : limitation de débit et regroupement des alertes sont en mémoire ; le panel n'est pas prévu
  pour tourner en plusieurs réplicas.

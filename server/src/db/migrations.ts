import { migrations as authMigrations } from '../modules/auth/schema.js';
import { migrations as mailMigrations } from '../modules/mail/schema.js';
import { migrations as notificationsMigrations } from '../modules/notifications/schema.js';
import { migrations as proxmoxMigrations } from '../modules/proxmox/schema.js';
import { migrations as pterodactylMigrations } from '../modules/pterodactyl/schema.js';
import { migrations as whmcsMigrations } from '../modules/whmcs/schema.js';

export interface Migration {
  /** Identifiant unique et immuable. Une migration appliquée n'est jamais modifiée : on en ajoute une nouvelle. */
  id: string;
  sql: string;
}

/**
 * Schéma commun. Toutes les dates sont des entiers (millisecondes Unix, UTC).
 * Les colonnes suffixées _enc contiennent du AES-256-GCM (core/crypto.ts), _hash un HMAC-SHA256 ou Argon2id.
 */
const core: Migration[] = [
  {
    id: '001_core',
    sql: `
      -- ── Comptes administrateurs : 2 au maximum, créés uniquement par la CLI d'installation ──
      CREATE TABLE users (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash       TEXT NOT NULL,              -- Argon2id
        totp_secret_enc     TEXT NOT NULL,
        totp_pending_enc    TEXT,                       -- nouveau secret en attente de confirmation
        totp_last_step      INTEGER NOT NULL DEFAULT 0, -- dernier pas TOTP accepté (anti-rejeu)
        failed_attempts     INTEGER NOT NULL DEFAULT 0,
        lock_count          INTEGER NOT NULL DEFAULT 0, -- nombre de verrouillages consécutifs (durée croissante)
        locked_until        INTEGER,
        password_changed_at INTEGER NOT NULL,
        created_at          INTEGER NOT NULL
      );

      -- Défense en profondeur : même un bug applicatif ne peut pas créer un troisième compte.
      CREATE TRIGGER users_max_two BEFORE INSERT ON users
      WHEN (SELECT COUNT(*) FROM users) >= 2
      BEGIN
        SELECT RAISE(ABORT, 'Limite de 2 comptes administrateurs atteinte');
      END;

      CREATE TABLE backup_codes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at   INTEGER
      );
      CREATE INDEX backup_codes_user ON backup_codes(user_id);

      -- Connexion en cours (après mot de passe valide, avant ouverture de session).
      CREATE TABLE login_challenges (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash             TEXT NOT NULL UNIQUE,
        user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stage                  TEXT NOT NULL CHECK (stage IN ('second_factor', 'device_confirmation')),
        email_code_hash        TEXT,
        email_code_expires_at  INTEGER,
        device_code_hash       TEXT,
        device_code_expires_at INTEGER,
        attempts               INTEGER NOT NULL DEFAULT 0,
        emails_sent            INTEGER NOT NULL DEFAULT 0,
        reasons                TEXT,                    -- JSON : NewContextReason[]
        ip                     TEXT NOT NULL,
        country                TEXT,
        user_agent             TEXT NOT NULL,
        device_id              TEXT,
        created_at             INTEGER NOT NULL,
        expires_at             INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,                 -- identifiant public (UUID), jamais le jeton
        token_hash    TEXT NOT NULL UNIQUE,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token    TEXT NOT NULL,
        ip            TEXT NOT NULL,
        country       TEXT,
        user_agent    TEXT NOT NULL,
        device_id     TEXT,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,                 -- expiration absolue
        step_up_until INTEGER,
        revoked_at    INTEGER
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      CREATE TABLE known_devices (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_hash  TEXT NOT NULL,
        label        TEXT NOT NULL,
        last_ip      TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        UNIQUE (user_id, device_hash)
      );

      CREATE TABLE known_ips (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip            TEXT NOT NULL,
        country       TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        UNIQUE (user_id, ip)
      );

      -- Échecs d'authentification par IP / identifiant (limitation et détection d'activité suspecte).
      CREATE TABLE auth_failures (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ip         TEXT NOT NULL,
        identifier TEXT,
        kind       TEXT NOT NULL,
        at         INTEGER NOT NULL
      );
      CREATE INDEX auth_failures_ip_at ON auth_failures(ip, at);

      -- Journal d'audit : en ajout seul.
      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL = évènement non attribué
        action     TEXT NOT NULL,
        target     TEXT,
        success    INTEGER NOT NULL DEFAULT 1,
        ip         TEXT,
        country    TEXT,
        user_agent TEXT,
        device_id  TEXT,
        session_id TEXT,
        details    TEXT                                 -- JSON, sans secret
      );
      CREATE INDEX audit_log_user_at ON audit_log(user_id, at DESC);
      CREATE INDEX audit_log_at ON audit_log(at DESC);

      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'Le journal d''audit est en ajout seul');
      END;

      -- Réglages chiffrés par espace de noms (whmcs, pterodactyl, proxmox, notifications, security…).
      CREATE TABLE integration_settings (
        namespace  TEXT PRIMARY KEY,
        data_enc   TEXT NOT NULL,                       -- JSON chiffré
        updated_at INTEGER NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );

      -- ── WHMCS : coûts saisis manuellement ──
      CREATE TABLE costs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        label       TEXT NOT NULL,
        category    TEXT NOT NULL DEFAULT 'other',
        amount      REAL NOT NULL CHECK (amount >= 0),
        recurrence  TEXT NOT NULL CHECK (recurrence IN ('monthly', 'yearly', 'one_time')),
        start_month TEXT NOT NULL,                      -- YYYY-MM
        end_month   TEXT,                               -- YYYY-MM inclus, NULL = sans fin
        notes       TEXT,
        created_at  INTEGER NOT NULL
      );

      -- ── Notifications ──
      CREATE TABLE notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        type       TEXT NOT NULL CHECK (type IN ('order', 'payment', 'security', 'system')),
        severity   TEXT NOT NULL DEFAULT 'info',
        title      TEXT NOT NULL,
        body       TEXT NOT NULL,
        data       TEXT,                                -- JSON
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = pour les deux administrateurs
        created_at INTEGER NOT NULL
      );
      CREATE INDEX notifications_created ON notifications(created_at DESC);

      CREATE TABLE notification_reads (
        notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at         INTEGER NOT NULL,
        PRIMARY KEY (notification_id, user_id)
      );

      CREATE TABLE push_subscriptions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL UNIQUE,
        keys_enc   TEXT NOT NULL,                       -- JSON chiffré { p256dh, auth }
        user_agent TEXT,
        created_at INTEGER NOT NULL
      );

      -- Idempotence et anti-rejeu des webhooks.
      CREATE TABLE webhook_events (
        event_id    TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );

      -- ── Mails ──
      CREATE TABLE mail_accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        label        TEXT NOT NULL,
        address      TEXT NOT NULL,
        imap_host    TEXT NOT NULL,
        imap_port    INTEGER NOT NULL,
        imap_secure  INTEGER NOT NULL DEFAULT 1,
        smtp_host    TEXT NOT NULL,
        smtp_port    INTEGER NOT NULL,
        smtp_secure  INTEGER NOT NULL DEFAULT 1,
        username     TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
    `,
  },
];

export const migrations: Migration[] = [
  ...core,
  ...authMigrations,
  ...whmcsMigrations,
  ...notificationsMigrations,
  ...mailMigrations,
  ...pterodactylMigrations,
  ...proxmoxMigrations,
];

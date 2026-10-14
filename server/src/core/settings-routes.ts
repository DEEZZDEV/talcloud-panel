import type { SettingsTestResult, SettingsView } from '@shared/api-types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { securityAlert } from './alerts.js';
import { audit } from './audit.js';
import { AppError, badRequest } from './errors.js';
import { currentUser } from './request.js';
import { getSettings, getSettingsUpdatedAt, setSettings } from './settings.js';

export interface SettingsRoutesOptions<T extends Record<string, unknown>> {
  /** Espace de noms : routes /api/settings/<namespace>. */
  namespace: string;
  /** Schéma complet des réglages stockés (secrets inclus). */
  schema: z.ZodType<T>;
  /** Champs qui ne sont jamais renvoyés au client. */
  secretFields: readonly (keyof T & string)[];
  /**
   * Champs qui déterminent OÙ les secrets sont envoyés (URL, vérification TLS, CA…). Si l'un d'eux change, tous les
   * secrets conservés doivent être ressaisis dans la même requête : sinon une session détournée pourrait se faire
   * envoyer les clés enregistrées en redirigeant simplement l'intégration vers un hôte qu'elle contrôle.
   */
  destinationFields?: readonly (keyof T & string)[];
  /** Indique si l'intégration est utilisable avec ces réglages. */
  isConfigured: (settings: T) => boolean;
  /** Teste la connexion avec les réglages enregistrés. Ne doit pas divulguer de secret dans le message. */
  test?: (settings: T) => Promise<SettingsTestResult>;
  /** Appelé après enregistrement (invalidation de cache, reconnexion…). */
  onChange?: () => void;
}

/**
 * Enregistre GET / PUT / POST test pour un espace de réglages chiffrés.
 *  - GET  : valeurs non secrètes + pour chaque secret « défini ou non ».
 *  - PUT  : corps partiel, step-up obligatoire. Secret absent ou '' = inchangé, null = effacé.
 *  - POST /test : teste les réglages enregistrés.
 */
export function registerSettingsRoutes<T extends Record<string, unknown>>(app: FastifyInstance, options: SettingsRoutesOptions<T>): void {
  const { namespace, schema, secretFields, destinationFields = [], isConfigured, test, onChange } = options;
  const secrets = new Set<string>(secretFields);
  const base = `/api/settings/${namespace}`;

  const view = (): SettingsView<T> => {
    const stored = getSettings<T>(namespace);
    const values: Record<string, unknown> = {};
    const secretState: Record<string, boolean> = {};
    for (const field of secrets) secretState[field] = false;
    for (const [key, value] of Object.entries(stored ?? {})) {
      if (secrets.has(key)) secretState[key] = value !== undefined && value !== null && value !== '';
      else values[key] = value;
    }
    const updatedAt = getSettingsUpdatedAt(namespace);
    return {
      configured: stored ? isConfigured(stored) : false,
      values: values as Partial<T>,
      secrets: secretState,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    };
  };

  app.get(base, async () => ({ data: view() }));

  app.put(base, { config: { stepUp: true } }, async (request) => {
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    const previous: Record<string, unknown> = getSettings<T>(namespace) ?? {};
    const merged: Record<string, unknown> = { ...previous };
    const changed: string[] = [];
    const resupplied = new Set<string>();

    for (const [key, value] of Object.entries(body)) {
      if (secrets.has(key)) {
        if (value === undefined || value === '') continue; // secret non resaisi : inchangé
        if (value === null) delete merged[key];
        else {
          merged[key] = value;
          resupplied.add(key);
        }
      } else if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
      changed.push(key);
    }

    const parsed = schema.safeParse(merged);
    if (!parsed.success) {
      audit(request, { action: `settings.${namespace}.update`, success: false, details: { fields: changed } });
      throw badRequest('Réglages invalides', z.flattenError(parsed.error).fieldErrors);
    }

    // Seuls les champs du schéma sont acceptés : une clé inconnue ne doit ni être stockée, ni se retrouver
    // recopiée dans le journal et dans l'alerte envoyée aux administrateurs.
    const known = new Set<string>([...secrets, ...Object.keys(previous), ...Object.keys(parsed.data)]);
    const unknown = changed.filter((key) => !known.has(key));
    if (unknown.length > 0) {
      audit(request, { action: `settings.${namespace}.update`, success: false, details: { reason: 'unknown_fields', count: unknown.length } });
      throw badRequest('Champ de réglage inconnu');
    }

    // Comparaison après normalisation par le schéma : renvoyer la même URL ne compte pas comme un changement.
    const next = parsed.data as Record<string, unknown>;
    const isSet = (value: unknown) => value !== undefined && value !== null && value !== '';
    const moved = destinationFields.filter((field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(next[field] ?? null));
    if (moved.length > 0) {
      const kept = [...secrets].filter((field) => isSet(previous[field]) && isSet(next[field]) && !resupplied.has(field));
      if (kept.length > 0) {
        audit(request, { action: `settings.${namespace}.update`, success: false, details: { fields: changed, reason: 'secrets_required' } });
        throw badRequest('La destination de cette intégration change : ressaisissez ses clés pour confirmer', {
          secretsRequired: kept,
        });
      }
    }

    setSettings(namespace, parsed.data, currentUser(request).id);
    onChange?.();
    // Seuls les noms des champs modifiés sont journalisés, jamais leurs valeurs.
    audit(request, { action: `settings.${namespace}.update`, details: { fields: changed } });
    // Les deux administrateurs sont prévenus : une modification de clé ou d'URL ne doit jamais passer inaperçue.
    securityAlert({
      kind: 'settings_changed',
      severity: 'warning',
      title: `Réglages « ${namespace} » modifiés`,
      summary: `Les réglages de l'intégration « ${namespace} » ont été modifiés par ${currentUser(request).username}.`,
      facts: [
        ['Champs modifiés', changed.join(', ')],
        ['Adresse IP', request.client.ip],
        ['Navigateur', request.client.userAgent],
      ],
      userId: currentUser(request).id,
    });
    return { data: view() };
  });

  if (test) {
    // Sous step-up : le test envoie les secrets enregistrés vers l'hôte configuré.
    app.post(`${base}/test`, { config: { stepUp: true } }, async (request): Promise<{ data: SettingsTestResult }> => {
      const stored = getSettings<T>(namespace);
      if (!stored || !isConfigured(stored)) return { data: { ok: false, message: 'Intégration non configurée' } };
      let result: SettingsTestResult;
      try {
        result = await test(stored);
      } catch (err) {
        result = { ok: false, message: err instanceof AppError ? err.message : 'Échec du test de connexion' };
      }
      audit(request, { action: `settings.${namespace}.test`, success: result.ok });
      return { data: result };
    });
  }
}

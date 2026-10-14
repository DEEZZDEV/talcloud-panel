import type { IncomingHttpHeaders } from 'node:http';
import maxmind, { type CountryResponse, type Reader } from 'maxmind';
import { config } from '../config.js';

let reader: Reader<CountryResponse> | null = null;
let loading: Promise<void> | null = null;

/**
 * Charge la base MaxMind (GeoLite2-Country) si GEOIP_DB_PATH est défini. À appeler une fois au démarrage.
 * Une base absente ou illisible n'empêche pas le démarrage : la géolocalisation est simplement désactivée.
 */
export function initGeo(onError?: (err: unknown) => void): Promise<void> {
  if (!config.geoipDbPath) return Promise.resolve();
  loading ??= maxmind
    .open<CountryResponse>(config.geoipDbPath)
    .then((r) => {
      reader = r;
    })
    .catch((err: unknown) => {
      reader = null;
      onError?.(err);
    });
  return loading;
}

const validCode = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  // XX = inconnu, T1 = Tor (Cloudflare) : pas des pays.
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
};

/**
 * Code pays ISO 3166-1 alpha-2 de l'IP, ou null si inconnu.
 * Source : base MaxMind locale si configurée ; sinon l'en-tête CF-IPCountry, uniquement si
 * TRUST_CF_COUNTRY_HEADER est activé (le panel doit alors n'être joignable que via Cloudflare).
 */
export function lookupCountry(ip: string, headers: IncomingHttpHeaders = {}): string | null {
  if (reader) {
    try {
      const found = reader.get(ip);
      const code = validCode(found?.country?.iso_code ?? found?.registered_country?.iso_code);
      if (code) return code;
    } catch {
      // IP invalide pour la base : on retombe sur la suite.
    }
  }
  if (config.trustCfCountryHeader) {
    const header = headers['cf-ipcountry'];
    return validCode(Array.isArray(header) ? header[0] : header);
  }
  return null;
}

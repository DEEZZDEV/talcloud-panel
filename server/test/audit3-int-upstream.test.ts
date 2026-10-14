/**
 * AUDIT 3 (intégrations) — D-04 : réponses des API distantes lues en mémoire sans limite de taille.
 *
 * WHMCS (res.text()), Pterodactyl et Proxmox (res.json()) chargent tout le corps de la réponse en mémoire, sans
 * plafond (seul le délai borne la lecture : 15 à 60 s, soit des Go sur un lien rapide). Un WHMCS, un Pterodactyl
 * ou un Proxmox compromis (ou un intermédiaire, avec verifyTls=false) fait épuiser la mémoire du processus
 * Node et coupe le panel pour les deux administrateurs ; un simple rafraîchissement du tableau de bord suffit
 * à déclencher l'appel.
 *
 * Comportement sûr attendu : une réponse démesurée (ici 64 Mo, contre quelques centaines de Ko au plus pour une
 * page légitime) est abandonnée en cours de lecture et convertie en UPSTREAM_ERROR.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pveRequest } from '../src/modules/proxmox/client.js';
import { probeApplication } from '../src/modules/pterodactyl/client.js';
import { whmcsCall } from '../src/modules/whmcs/client.js';

const HUGE = 64 * 1024 * 1024;
let server: Server;
let base = '';
let bytesServed = 0;

/** JSON valide de HUGE octets, émis par blocs. */
function streamHugeJson(res: import('node:http').ServerResponse, prefix: string, suffix: string): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(prefix);
  const chunk = Buffer.alloc(1024 * 1024, 'a');
  let sent = 0;
  const pump = (): void => {
    while (sent < HUGE) {
      sent += chunk.length;
      bytesServed += chunk.length;
      if (!res.write(chunk)) {
        res.once('drain', pump);
        return;
      }
    }
    res.end(suffix);
  };
  res.on('close', () => undefined);
  pump();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    if (req.url?.startsWith('/includes/api.php')) return streamHugeJson(res, '{"result":"success","totalresults":"1","pad":"', '"}');
    if (req.url?.startsWith('/api/application/')) return streamHugeJson(res, '{"data":[],"meta":{"pagination":{"current_page":1,"total_pages":1,"total":1}},"pad":"', '"}');
    return streamHugeJson(res, '{"data":{"version":"8.2.4","pad":"', '"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('D-04 — taille des réponses distantes non bornée', () => {
  it('WHMCS : une réponse de 64 Mo est refusée (UPSTREAM_ERROR) au lieu d’être entièrement chargée', async () => {
    const outcome = await whmcsCall('GetClients', {}, { settings: { url: base, identifier: 'id', secret: 'sec' }, timeoutMs: 60_000 }).then(
      () => 'acceptée',
      (err: { code?: string }) => err.code ?? 'erreur',
    );
    expect(outcome).toBe('UPSTREAM_ERROR');
  });

  it('Pterodactyl : une réponse de 64 Mo est refusée', async () => {
    const outcome = await probeApplication({ url: base, applicationKey: 'ptla_x', clientKey: 'ptlc_x' }).then(
      () => 'acceptée',
      (err: { code?: string }) => err.code ?? 'erreur',
    );
    expect(outcome).toBe('UPSTREAM_ERROR');
  });

  it('Proxmox : une réponse de 64 Mo est refusée', async () => {
    const settings = { url: base, tokenId: 'root@pam!panel', tokenSecret: 'secret-secret', verifyTls: true } as Parameters<typeof pveRequest>[0];
    const outcome = await pveRequest(settings, { path: '/version', timeoutMs: 60_000 }).then(
      () => 'acceptée',
      (err: { code?: string }) => err.code ?? 'erreur',
    );
    expect(outcome).toBe('UPSTREAM_ERROR');
  });
});

import type { GuestStatus, GuestType, ProxmoxGuest, ProxmoxNode, ProxmoxNodeHistoryPoint, ProxmoxSummary } from '@shared/api-types';

/**
 * Conversion des réponses brutes de Proxmox vers les DTO du contrat. Fonctions pures.
 * Tout ce qui vient de Proxmox est traité comme non fiable : types vérifiés, valeurs bornées.
 */

/** Nom d'hôte Proxmox (label DNS) : sert aussi à valider le paramètre de chemin `:node`. */
export const NODE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
export const NODE_NAME_MAX = 63;
export const VMID_MIN = 100;
export const VMID_MAX = 999_999_999;

export const isNodeName = (value: unknown): value is string => typeof value === 'string' && value.length <= NODE_NAME_MAX && NODE_NAME.test(value);
export const isVmid = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= VMID_MIN && value <= VMID_MAX;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** Nombre fini, sinon null (Proxmox renvoie parfois des nombres sous forme de chaînes). */
function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const amount = (value: unknown): number => Math.max(0, numberOrNull(value) ?? 0);
const count = (value: unknown): number => Math.floor(amount(value));
const round2 = (value: number): number => Math.round(value * 100) / 100;
/** Fraction 0–1 → pourcentage 0–100. */
const percent = (fraction: number): number => round2(Math.min(100, Math.max(0, fraction * 100)));
const fractionToPercent = (value: unknown): number => percent(numberOrNull(value) ?? 0);

export interface RawNode {
  node: string;
  online: boolean;
  cpuPercent: number;
  cpuCores: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  uptimeSeconds: number;
}

/** Entrées `type: node` de /cluster/resources. Un node hors ligne n'a ni charge ni mémoire : tout vaut 0. */
export function parseNodes(data: unknown): RawNode[] {
  const nodes: RawNode[] = [];
  const seen = new Set<string>();
  for (const item of records(data)) {
    if (item.type !== 'node' || !isNodeName(item.node) || seen.has(item.node)) continue;
    seen.add(item.node);
    const online = item.status === 'online';
    nodes.push({
      node: item.node,
      online,
      cpuPercent: online ? fractionToPercent(item.cpu) : 0,
      cpuCores: count(item.maxcpu),
      memoryUsedBytes: online ? amount(item.mem) : 0,
      memoryTotalBytes: amount(item.maxmem),
      diskUsedBytes: online ? amount(item.disk) : 0,
      diskTotalBytes: amount(item.maxdisk),
      uptimeSeconds: online ? count(item.uptime) : 0,
    });
  }
  return nodes.sort((a, b) => a.node.localeCompare(b.node));
}

function guestStatus(value: unknown): GuestStatus {
  switch (value) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'paused':
    case 'suspended':
    case 'prelaunch':
      return 'paused';
    default:
      return 'unknown';
  }
}

const isTemplate = (value: unknown): boolean => value === 1 || value === true || value === '1';

/** Les tags Proxmox sont séparés par « ; » (anciennement « , » ou espace). */
function splitTags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(/[;,\s]+/).filter(Boolean))];
}

/** Entrées qemu / lxc de /cluster/resources?type=vm. Une entrée au vmid, type ou node invalide est ignorée. */
export function parseGuests(data: unknown): ProxmoxGuest[] {
  const guests: ProxmoxGuest[] = [];
  const seen = new Set<number>();
  for (const item of records(data)) {
    if (item.type !== 'qemu' && item.type !== 'lxc') continue;
    const vmid = numberOrNull(item.vmid);
    if (!isVmid(vmid) || !isNodeName(item.node) || seen.has(vmid)) continue;
    seen.add(vmid);
    const type: GuestType = item.type;
    const status = guestStatus(item.status);
    const running = status === 'running' || status === 'paused';
    guests.push({
      vmid,
      name: typeof item.name === 'string' && item.name !== '' ? item.name : `${type === 'qemu' ? 'VM' : 'CT'} ${vmid}`,
      node: item.node,
      type,
      status,
      template: isTemplate(item.template),
      // `cpu` est déjà une fraction des cœurs alloués (1 = tous les cœurs de l'invité à 100 %).
      cpuPercent: running ? fractionToPercent(item.cpu) : 0,
      cpuCores: count(item.maxcpu),
      memoryUsedBytes: running ? amount(item.mem) : 0,
      memoryTotalBytes: amount(item.maxmem),
      diskUsedBytes: amount(item.disk),
      diskTotalBytes: amount(item.maxdisk),
      uptimeSeconds: running ? count(item.uptime) : 0,
      tags: splitTags(item.tags),
    });
  }
  return guests.sort((a, b) => a.vmid - b.vmid);
}

export interface NodeStatusExtra {
  loadAverage: [number, number, number] | null;
  pveVersion: string | null;
}

/** /nodes/:node/status → charge et version (« pve-manager/8.2.4/faa83925 » → « 8.2.4 »). */
export function parseNodeStatus(data: unknown): NodeStatusExtra {
  const raw = isRecord(data) ? data : {};
  let loadAverage: NodeStatusExtra['loadAverage'] = null;
  if (Array.isArray(raw.loadavg) && raw.loadavg.length >= 3) {
    const [a, b, c] = raw.loadavg.slice(0, 3).map(numberOrNull);
    if (a != null && b != null && c != null) loadAverage = [Math.max(0, a), Math.max(0, b), Math.max(0, c)];
  }
  let pveVersion: string | null = null;
  if (typeof raw.pveversion === 'string') {
    const match = /^(?:pve-manager\/)?([0-9A-Za-z.~+-]{1,32})(?:\/|$)/.exec(raw.pveversion);
    pveVersion = match?.[1] ?? null;
  }
  return { loadAverage, pveVersion };
}

/** Compteurs d'invités par node. Les modèles (templates) ne sont pas comptés : ils ne peuvent pas tourner. */
export function buildNodes(nodes: RawNode[], guests: ProxmoxGuest[], extras: Map<string, NodeStatusExtra | null>): ProxmoxNode[] {
  const counters = new Map<string, { running: number; total: number }>();
  for (const guest of guests) {
    if (guest.template) continue;
    const counter = counters.get(guest.node) ?? { running: 0, total: 0 };
    counter.total += 1;
    if (guest.status === 'running') counter.running += 1;
    counters.set(guest.node, counter);
  }
  return nodes.map((node) => {
    // null = /status illisible alors que le cluster annonce le node en ligne : il est présenté hors ligne.
    const extra = node.online ? extras.get(node.node) ?? null : null;
    return {
      ...node,
      online: node.online && extra !== null,
      loadAverage: extra?.loadAverage ?? null,
      pveVersion: extra?.pveVersion ?? null,
      guests: counters.get(node.node) ?? { running: 0, total: 0 },
    };
  });
}

export function buildSummary(nodes: RawNode[], guests: ProxmoxGuest[]): ProxmoxSummary {
  const real = guests.filter((g) => !g.template);
  return {
    nodes: { total: nodes.length, online: nodes.filter((n) => n.online).length },
    guests: {
      total: real.length,
      running: real.filter((g) => g.status === 'running').length,
      stopped: real.filter((g) => g.status === 'stopped').length,
    },
    offlineNodes: nodes.filter((n) => !n.online).map((n) => n.node),
  };
}

/** /nodes/:node/rrddata : une valeur absente (pas de mesure sur l'intervalle) devient null. */
export function parseHistory(data: unknown): ProxmoxNodeHistoryPoint[] {
  const points: { at: number; point: ProxmoxNodeHistoryPoint }[] = [];
  for (const item of records(data)) {
    const time = numberOrNull(item.time);
    if (time === null || time <= 0 || time > 32_503_680_000) continue;
    const cpu = numberOrNull(item.cpu);
    const used = numberOrNull(item.memused);
    const total = numberOrNull(item.memtotal);
    const load = numberOrNull(item.loadavg);
    points.push({
      at: time,
      point: {
        time: new Date(time * 1000).toISOString(),
        cpuPercent: cpu === null ? null : percent(cpu),
        memoryPercent: used === null || total === null || total <= 0 ? null : percent(used / total),
        loadAverage: load === null ? null : round2(Math.max(0, load)),
      },
    });
  }
  return points.sort((a, b) => a.at - b.at).map((p) => p.point);
}

/** Version renvoyée par /version, réduite à un jeu de caractères sûr. */
export function parseVersion(data: unknown): string | null {
  const version = isRecord(data) ? data.version : null;
  return typeof version === 'string' && /^[0-9A-Za-z.~+-]{1,32}$/.test(version) ? version : null;
}

/** /access/permissions → ensemble des privilèges accordés au jeton, tous chemins confondus. */
export function parsePrivileges(data: unknown): Set<string> | null {
  if (!isRecord(data)) return null;
  const granted = new Set<string>();
  for (const privileges of Object.values(data)) {
    if (!isRecord(privileges)) continue;
    for (const [name, value] of Object.entries(privileges)) if (value === 1 || value === true) granted.add(name);
  }
  return granted;
}

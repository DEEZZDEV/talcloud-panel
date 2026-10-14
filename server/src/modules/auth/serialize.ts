/**
 * Exécution en file, par clé, des vérifications de secret coûteuses et asynchrones (Argon2id).
 *
 * Sans cela, N requêtes parallèles franchissent toutes le contrôle de verrouillage avant que le premier échec
 * ne soit compté : la limite de 5 essais serait dépassée, et une bonne réponse « en vol » pourrait être acceptée
 * après le verrouillage. En file, chaque tentative voit l'état laissé par la précédente. (Les appelants relisent
 * en plus le compte et la session après chaque attente : la file n'est pas la seule protection.)
 * La file borne aussi le nombre de calculs Argon2id simultanés (64 Mio chacun) pour un même compte.
 *
 * La file elle-même est plafonnée : au-delà de MAX_PENDING tâches en attente sur une clé, la tentative est refusée
 * tout de suite (429). Sinon un flot de connexions anonymes sur un identifiant ferait attendre indéfiniment son
 * titulaire et grossir la mémoire.
 */
import { rateLimited } from '../../core/errors.js';

const MAX_PENDING = 8;
const chains = new Map<string, Promise<unknown>>();
const pending = new Map<string, number>();

export function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const waiting = pending.get(key) ?? 0;
  if (waiting >= MAX_PENDING) return Promise.reject(rateLimited('Trop de tentatives simultanées, réessayez dans un instant'));
  pending.set(key, waiting + 1);
  const release = () => {
    const left = (pending.get(key) ?? 1) - 1;
    if (left <= 0) pending.delete(key);
    else pending.set(key, left);
  };

  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(release, release);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

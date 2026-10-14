import type { GameServer, GameServerState, PowerRequest, PowerSignal, PterodactylSummary } from '@shared/api-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fetcher, qk } from '@/lib/query';

/** Rafraîchissement périodique en arrière-plan (ne prolonge pas la session). */
export const SERVERS_REFRESH_MS = 20_000;

export const useGameServers = () =>
  useQuery({ queryKey: qk.pterodactyl.servers, queryFn: fetcher<GameServer[]>('/api/pterodactyl/servers'), staleTime: 10_000, refetchInterval: SERVERS_REFRESH_MS });

export const usePterodactylSummary = () =>
  useQuery({ queryKey: qk.pterodactyl.summary, queryFn: fetcher<PterodactylSummary>('/api/pterodactyl/summary'), staleTime: 30_000, refetchInterval: 60_000 });

export type ServerAction = PowerSignal | 'suspend' | 'unsuspend';

/** État transitoire affiché tout de suite après une action — uniquement quand il est sans ambiguïté. */
const OPTIMISTIC_STATE: Partial<Record<ServerAction, GameServerState>> = {
  start: 'starting',
  restart: 'starting',
  stop: 'stopping',
};

export function useServerAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ server, action }: { server: GameServer; action: ServerAction }) => {
      const base = `/api/pterodactyl/servers/${encodeURIComponent(String(server.id))}`;
      if (action === 'suspend' || action === 'unsuspend') return api.post(`${base}/${action}`);
      return api.post(`${base}/power`, { signal: action } satisfies PowerRequest);
    },
    // Mise à jour optimiste prudente : appliquée seulement une fois la requête ACCEPTÉE par le serveur
    // (donc après un éventuel code 2FA), jamais avant ; l'état réel revient au rafraîchissement suivant.
    onSuccess: (_data, { server, action }) => {
      const next = OPTIMISTIC_STATE[action];
      if (next) {
        client.setQueryData<GameServer[]>(qk.pterodactyl.servers, (servers) => servers?.map((item) => (item.id === server.id ? { ...item, state: next } : item)));
      }
      // Laisse au daemon le temps d'appliquer le signal avant de relire l'état réel.
      window.setTimeout(() => void client.invalidateQueries({ queryKey: qk.pterodactyl.all }), action === 'suspend' || action === 'unsuspend' ? 400 : 2_500);
    },
  });
}

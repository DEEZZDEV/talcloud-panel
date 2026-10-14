import type { SettingsTestResult, SettingsView } from '@shared/api-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fetcher, qk } from '@/lib/query';

export type SettingsNamespace = 'whmcs' | 'pterodactyl' | 'proxmox' | 'notifications';

/** Domaines de données à recharger quand les réglages d'une intégration changent. */
const DEPENDENT_KEYS: Record<SettingsNamespace, readonly (readonly string[])[]> = {
  whmcs: [['whmcs'], ['pterodactyl'], ['mail', 'message']],
  pterodactyl: [['pterodactyl']],
  proxmox: [['proxmox']],
  notifications: [],
};

export const useSettings = <TValues>(namespace: SettingsNamespace) =>
  useQuery({ queryKey: qk.settings(namespace), queryFn: fetcher<SettingsView<TValues>>(`/api/settings/${namespace}`), staleTime: 60_000 });

/**
 * Enregistre un corps PARTIEL : les secrets laissés vides ne sont pas envoyés (ils restent inchangés côté serveur).
 * La route exige un step-up : le code 2FA est demandé automatiquement par le client API.
 */
export function useSaveSettings<TValues>(namespace: SettingsNamespace) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<SettingsView<TValues>>(`/api/settings/${namespace}`, body),
    onSuccess: (view) => {
      client.setQueryData(qk.settings(namespace), view);
      for (const key of DEPENDENT_KEYS[namespace]) void client.invalidateQueries({ queryKey: key });
    },
  });
}

export const useTestSettings = (namespace: SettingsNamespace) => useMutation({ mutationFn: () => api.post<SettingsTestResult>(`/api/settings/${namespace}/test`) });

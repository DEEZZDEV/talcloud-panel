import type { HomeBlockId, UserPreferences, UserPreferencesUpdate } from '@shared/api-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { applyThemePreference, useTheme, type ThemePreference } from '@/hooks/use-theme';
import { api, errorMessage } from '@/lib/api';
import { fetcher, qk } from '@/lib/query';

/**
 * Préférences PROPRES au compte connecté (thème, push, accueil, boîte mail par défaut). Elles vivent dans le cache
 * React Query, vidé à chaque déconnexion et à chaque connexion : rien ne passe d'un compte à l'autre.
 */

/** Ordre et contenu par défaut (identiques au serveur). */
export const ALL_HOME_BLOCKS: HomeBlockId[] = ['stats', 'revenueChart', 'recentOrders', 'mail', 'offlineServices', 'notifications'];

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'dark',
  push: { orders: true, payments: true, security: true, system: true },
  home: { blocks: [...ALL_HOME_BLOCKS] },
  mail: { defaultAccountId: null },
};

export const usePreferences = () =>
  useQuery({ queryKey: qk.preferences, queryFn: fetcher<UserPreferences>('/api/me/preferences'), staleTime: 5 * 60_000, refetchOnWindowFocus: false });

/** Mise à jour partielle, appliquée tout de suite à l'écran puis confirmée (ou annulée) par le serveur. */
export function useUpdatePreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: qk.preferences,
    mutationFn: (update: UserPreferencesUpdate) => api.put<UserPreferences>('/api/me/preferences', update),
    onMutate: async (update) => {
      await client.cancelQueries({ queryKey: qk.preferences });
      const previous = client.getQueryData<UserPreferences>(qk.preferences);
      if (previous) {
        client.setQueryData<UserPreferences>(qk.preferences, {
          theme: update.theme ?? previous.theme,
          push: { ...previous.push, ...update.push },
          home: update.home ? { blocks: [...update.home.blocks] } : previous.home,
          mail: update.mail ?? previous.mail,
        });
      }
      return { previous };
    },
    onError: (error, _update, context) => {
      if (context?.previous) {
        client.setQueryData(qk.preferences, context.previous);
        applyThemePreference(context.previous.theme);
      }
      toast.error('Préférence non enregistrée', { description: errorMessage(error) });
    },
    onSuccess: (data) => client.setQueryData(qk.preferences, data),
  });
}

/** Change le thème : affichage immédiat, cache local, et enregistrement dans les préférences du compte. */
export function useThemeSetter(): { setTheme: (preference: ThemePreference) => void; toggleTheme: () => void } {
  const update = useUpdatePreferences();
  const { theme } = useTheme();
  const setTheme = useCallback(
    (preference: ThemePreference) => {
      applyThemePreference(preference);
      update.mutate({ theme: preference });
    },
    [update],
  );
  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [setTheme, theme]);
  return { setTheme, toggleTheme };
}

/**
 * Après la connexion : applique le thème enregistré pour CE compte. Le cache local (localStorage) ne sert qu'à éviter
 * un flash au chargement ; la préférence du serveur fait foi.
 */
export function PreferencesSync(): null {
  const preferences = usePreferences();
  const theme = preferences.data?.theme;
  useEffect(() => {
    if (theme) applyThemePreference(theme);
  }, [theme]);
  return null;
}

// ───────────────────────────── Blocs de l'accueil ─────────────────────────────

/** Largeur d'un bloc dans la grille de l'accueil. */
export type BlockWidth = 'full' | 'wide' | 'narrow';

export const HOME_BLOCKS: Record<HomeBlockId, { label: string; description: string; width: BlockWidth }> = {
  stats: { label: 'Statistiques du mois', description: "Chiffre d'affaires, bénéfice, nouveaux clients, commandes, impayés", width: 'full' },
  revenueChart: { label: "Courbe du chiffre d'affaires", description: "Chiffre d'affaires et bénéfice sur 12 mois", width: 'wide' },
  recentOrders: { label: 'Dernières commandes', description: 'Les 6 dernières commandes WHMCS', width: 'wide' },
  mail: { label: 'Mails non lus', description: 'Nombre de messages non lus par boîte', width: 'narrow' },
  offlineServices: { label: 'Services hors ligne', description: 'Serveurs de jeu et infrastructure Proxmox arrêtés', width: 'narrow' },
  notifications: { label: 'Dernières notifications', description: 'Commandes, paiements et alertes récentes', width: 'full' },
};

export type BlockRow = { kind: 'single'; block: HomeBlockId } | { kind: 'pair'; blocks: [HomeBlockId, HomeBlockId] };

/**
 * Range les blocs, dans l'ordre choisi, en rangées : un bloc pleine largeur occupe sa rangée ; deux blocs consécutifs
 * qui ne sont pas pleine largeur partagent une rangée (large + étroit en 2/3 – 1/3, ou deux étroits à parts égales).
 */
export function layoutRows(blocks: HomeBlockId[]): BlockRow[] {
  const rows: BlockRow[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as HomeBlockId;
    const next = blocks[index + 1];
    const width = HOME_BLOCKS[block].width;
    if (width !== 'full' && next && HOME_BLOCKS[next].width !== 'full' && !(width === 'wide' && HOME_BLOCKS[next].width === 'wide')) {
      rows.push({ kind: 'pair', blocks: [block, next] });
      index += 1;
    } else {
      rows.push({ kind: 'single', block });
    }
  }
  return rows;
}

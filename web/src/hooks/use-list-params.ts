import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebounce } from '@/hooks/use-debounce';

/**
 * Filtres d'une liste conservés dans l'URL (`?q=&status=&page=`) : partageables, et le bouton « précédent » fonctionne.
 * La saisie de recherche est immédiate à l'écran et appliquée après un anti-rebond.
 */
export function useListParams(defaultStatus = 'all') {
  const [params, setParams] = useSearchParams();
  const urlSearch = params.get('q') ?? '';
  const status = params.get('status') ?? defaultStatus;
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);

  const [searchInput, setSearchInput] = useState(urlSearch);
  const debounced = useDebounce(searchInput.trim(), 350);

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // La recherche stabilisée passe dans l'URL et ramène à la première page.
  useEffect(() => {
    if (debounced !== urlSearch) update({ q: debounced || null, page: null });
  }, [debounced, urlSearch, update]);

  const setStatus = useCallback((next: string) => update({ status: next === defaultStatus ? null : next, page: null }), [defaultStatus, update]);
  const setPage = useCallback((next: number) => update({ page: next <= 1 ? null : String(next) }), [update]);

  return { search: urlSearch, searchInput, setSearchInput, status, setStatus, page, setPage };
}

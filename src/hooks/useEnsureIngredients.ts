import { useEffect, useMemo, useState } from 'react';
import { fetchApiIngredientsByIds } from '../lib/api';
import { ingredientIdsKey } from '../domain/ingredient-ids';
import { useApp } from '../state/AppStore';

export function useEnsureIngredients(ids: string[]) {
  const { state, actions, mode, ready } = useApp();
  // Callers often build this array inline on each render. Depend on its stable
  // value, otherwise a failed request can retrigger the effect indefinitely.
  const idsKey = ingredientIdsKey(ids);
  const requestedIds = useMemo(() => idsKey ? idsKey.split('\u0000') : [], [idsKey]);
  const missingIds = useMemo(() => {
    const known = new Set(state.items.filter((item) => item.restaurantId === state.restaurant.id)
      .map((item) => item.id));
    return requestedIds.filter((id) => !known.has(id));
  }, [requestedIds, state.items, state.restaurant.id]);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id || missingIds.length === 0) {
      setLoadingKey(null);
      return;
    }
    const requestKey = `${state.restaurant.id}\u0001${missingIds.join('\u0000')}`;
    let current = true;
    setLoadingKey(requestKey);
    setErrorKey(null);
    void fetchApiIngredientsByIds(missingIds).then((ingredients) => {
      if (!current) return;
      const returned = new Set(ingredients.map((item) => item.id));
      const unresolved = missingIds.filter((id) => !returned.has(id));
      if (unresolved.length) throw new Error('Alguns insumos desta operação não estão disponíveis neste restaurante.');
      actions.cacheIngredients(ingredients);
      setLoadingKey(null);
    }).catch((error: unknown) => {
      if (!current) return;
      setLoadingKey(null);
      setErrorKey({ key: requestKey,
        message: error instanceof Error ? error.message : 'Não foi possível carregar os insumos necessários.' });
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, missingIds, retry]);

  const requestKey = `${state.restaurant.id}\u0001${missingIds.join('\u0000')}`;
  const loading = mode === 'production' && missingIds.length > 0 && loadingKey === requestKey;
  const error = mode === 'production' && errorKey?.key === requestKey ? errorKey.message : null;

  return { loading, error, retry: () => setRetry((value) => value + 1) };
}

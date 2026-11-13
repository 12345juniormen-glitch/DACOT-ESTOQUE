import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, Info, Plus, Trash2 } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { fetchApiIngredientsByIds, fetchApiInventoryPage, fetchApiRecipe, fetchApiRecipeSnapshotPage } from '../lib/api';
import { itemCostKnown, recipeCostCents, recipeCostPerPortionCents, recipeCostGaps, recipeMargin, recipeMarginCalculable } from '../domain/selectors';
import {
  convertQty,
  compatibleIngredientUnits,
  ingredientLineCostCents,
  dateTime,
  decimalRaw,
  money,
  moneyInput,
  parseMoney,
  parseStockQty,
  qty as fmtQty,
  shortDate,
} from '../domain/format';
import { UNIT_LABEL, type RecipeSnapshot, type Unit } from '../domain/types';
import {
  BackLink,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  ToneNote,
} from '../components/ui';

export function RecipeDetailPage() {
  const { id } = useParams();
  const { state, actions, can, mode, ready, notify } = useApp();
  const recipe = state.recipes.find((r) => r.id === id);
  const [recipeLoading, setRecipeLoading] = useState(false);
  const [recipeLookupId, setRecipeLookupId] = useState<string | undefined>();
  const [recipeLoadError, setRecipeLoadError] = useState<string | null>(null);
  const [fetchedSnapshots, setFetchedSnapshots] = useState<RecipeSnapshot[]>([]);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotHasMore, setSnapshotHasMore] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotRetry, setSnapshotRetry] = useState(0);
  const snapshotRequestRef = useRef(0);
  const [addOpen, setAddOpen] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceText, setPriceText] = useState('');
  const [yieldOpen, setYieldOpen] = useState(false);
  const [yieldText, setYieldText] = useState('1');
  const [newItemId, setNewItemId] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newUnit, setNewUnit] = useState<Unit>('kg');
  const [ingredientSearch, setIngredientSearch] = useState('');
  const [ingredientOptions, setIngredientOptions] = useState(state.items);
  const [ingredientOptionsLoading, setIngredientOptionsLoading] = useState(false);
  const [ingredientOptionsError, setIngredientOptionsError] = useState<string | null>(null);
  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState('');
  const [removeItemId, setRemoveItemId] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'production' || !id || recipe) return;
    let current = true;
    setRecipeLookupId(id);
    setRecipeLoading(true);
    setRecipeLoadError(null);
    void fetchApiRecipe(id).then((loaded) => {
      if (current) actions.cacheRecipes([loaded]);
    }).catch((error: unknown) => {
      if (current) setRecipeLoadError(error instanceof Error ? error.message : 'Ficha não encontrada.');
    }).finally(() => { if (current) setRecipeLoading(false); });
    return () => { current = false; };
  }, [mode, id, recipe?.id, state.restaurant.id]);

  useEffect(() => {
    if (mode !== 'production' || !id || !recipe) {
      setFetchedSnapshots([]);
      setSnapshotHasMore(false);
      setSnapshotError(null);
      return;
    }
    let current = true;
    const requestId = ++snapshotRequestRef.current;
    setFetchedSnapshots([]);
    setSnapshotHasMore(false);
    setSnapshotLoading(true);
    setSnapshotError(null);
    void fetchApiRecipeSnapshotPage(id)
      .then((page) => {
        if (!current) return;
        setFetchedSnapshots(page.snapshots);
        setSnapshotHasMore(page.hasMore);
      })
      .catch((error: unknown) => {
        if (!current) return;
        const detail = error instanceof Error ? error.message : 'falha de conexão';
        setSnapshotError(detail);
        notify(`Não foi possível carregar o histórico de custo (${detail}).`, 'error');
      })
      .finally(() => { if (current) setSnapshotLoading(false); });
    return () => {
      current = false;
      if (snapshotRequestRef.current === requestId) snapshotRequestRef.current += 1;
    };
  }, [id, mode, recipe?.id, snapshotRetry, notify]);

  useEffect(() => {
    if (mode !== 'production' || !recipe) return;
    const missingIds = [...new Set(recipe.ingredients.map((ingredient) => ingredient.itemId))]
      .filter((ingredientId) => !state.items.some((item) => item.id === ingredientId));
    if (missingIds.length === 0) return;
    let current = true;
    void fetchApiIngredientsByIds(missingIds)
      .then((items) => { if (current) actions.cacheIngredients(items); })
      .catch((error: unknown) => {
        if (current) notify(error instanceof Error
          ? `Não foi possível carregar os insumos desta ficha (${error.message}).`
          : 'Não foi possível carregar os insumos desta ficha.', 'error');
      });
    return () => { current = false; };
  }, [mode, recipe?.id, recipe?.ingredients, state.items, state.restaurant.id, notify]);

  useEffect(() => {
    if (!addOpen || mode !== 'production' || !recipe) return;
    let current = true;
    const timer = window.setTimeout(() => {
      setIngredientOptionsLoading(true);
      setIngredientOptionsError(null);
      void fetchApiInventoryPage({ search: ingredientSearch, category: null, status: null, sort: 'name' },
        0, 50, true).then((page) => {
          if (current) setIngredientOptions(page.items);
        }).catch((error: unknown) => {
          if (current) setIngredientOptionsError(error instanceof Error
            ? error.message : 'Não foi possível buscar insumos.');
        }).finally(() => {
          if (current) setIngredientOptionsLoading(false);
        });
    }, ingredientSearch.trim() ? 250 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [addOpen, mode, recipe?.id, ingredientSearch, state.restaurant.id]);

  if (!recipe) {
    const lookupPending = mode === 'production' && ready
      && (recipeLookupId !== id || recipeLoading);
    return (
      <div>
        <BackLink to="/fichas">Fichas técnicas</BackLink>
        <Panel>
          <EmptyState
            icon={<Info size={18} />}
            title={lookupPending ? 'Carregando ficha técnica…' : recipeLoadError ? 'Não foi possível carregar a ficha' : 'Ficha não encontrada'}
            description={recipeLoadError ?? (lookupPending
              ? 'Buscando a ficha no restaurante autenticado.'
              : 'A ficha pode ter sido removida ou o endereço está incorreto.')}
            action={
              <Link to="/fichas" className="btn btn-ghost">
                Voltar para fichas
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const cost = recipeCostPerPortionCents(state, recipe);
  const batchCost = recipeCostCents(state, recipe);
  const margin = recipeMargin(recipe, cost);
  const costGaps = recipeCostGaps(state, recipe);
  const marginCalculable = recipeMarginCalculable(state, recipe);
  const parsedNewQty = parseStockQty(newQty);
  const parsedEditQty = parseStockQty(editQty);
  const lines = recipe.ingredients
    .map((ingredient) => {
      const item = state.items.find((i) => i.id === ingredient.itemId);
      if (!item) return null;
      const quantityInItemUnit = ingredient.conversionToBase != null
        ? ingredient.qty * ingredient.conversionToBase
        : convertQty(ingredient.qty, ingredient.unit, item.unit, item.unit, item.conversions);
      const lineCost = itemCostKnown(item) ? ingredientLineCostCents(
        ingredient.qty, ingredient.unit, item.unit, item.costCents, item.conversions,
        ingredient.conversionToBase,
      ) : null;
      return { ingredient, item, lineCost, quantityInItemUnit };
    })
    .filter((line): line is NonNullable<typeof line> => line != null)
    .sort((a, b) => (b.lineCost ?? -1) - (a.lineCost ?? -1));
  const snapshotById = new Map(fetchedSnapshots.filter((snap) => snap.recipeId === recipe.id)
    .map((snap) => [snap.id, snap]));
  state.recipeSnapshots.filter((snap) => snap.recipeId === recipe.id)
    .forEach((snap) => snapshotById.set(snap.id, snap));
  const snapshots = [...snapshotById.values()]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const latestSnapshot = snapshots[0];
  const loadMoreSnapshots = async () => {
    if (!id || snapshotLoading || !snapshotHasMore) return;
    const requestId = snapshotRequestRef.current;
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const page = await fetchApiRecipeSnapshotPage(id, fetchedSnapshots.length);
      if (snapshotRequestRef.current !== requestId) return;
      setFetchedSnapshots((previous) => {
        const byId = new Map(previous.map((snapshot) => [snapshot.id, snapshot]));
        page.snapshots.forEach((snapshot) => byId.set(snapshot.id, snapshot));
        return [...byId.values()].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
      });
      setSnapshotHasMore(page.hasMore);
    } catch (error) {
      if (snapshotRequestRef.current !== requestId) return;
      setSnapshotError(error instanceof Error ? error.message : 'Não foi possível carregar mais snapshots.');
    } finally {
      if (snapshotRequestRef.current === requestId) setSnapshotLoading(false);
    }
  };
  const removing = state.items.find((i) => i.id === removeItemId);
  const editing = lines.find((line) => line.item.id === editItemId);
  const availableItems = (mode === 'production' ? ingredientOptions : state.items).filter(
    (item) => item.active !== false && !recipe.ingredients.some((ingredient) => ingredient.itemId === item.id),
  );
  const selectedNewItem = state.items.find((item) => item.id === newItemId)
    ?? ingredientOptions.find((item) => item.id === newItemId);
  const selectableNewItems = selectedNewItem && !availableItems.some((item) => item.id === selectedNewItem.id)
    ? [selectedNewItem, ...availableItems] : availableItems;
  const newUnitOptions = selectedNewItem
    ? compatibleIngredientUnits(selectedNewItem.unit, selectedNewItem.conversions)
    : [];

  return (
    <div>
      <BackLink to="/fichas">Fichas técnicas</BackLink>

      <PageHeader
        eyebrow="Fichas Técnicas / Composição"
        title={recipe.name}
        description="Custo calculado com o preço atual dos insumos. O histórico de snapshots preserva o custo usado em pedidos anteriores."
        actions={
          can('recipes.manage') ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => {
                setYieldText(String(recipe.yieldPortions || 1));
                setYieldOpen(true);
              }}>
                Rendimento: {recipe.yieldPortions || 1} porção(ões)
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => {
                void actions.setRecipeActive(recipe.id, recipe.active === false);
              }}>
                {recipe.active === false ? 'Reativar ficha' : 'Desativar ficha'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setPriceText(moneyInput(recipe.salePriceCents));
                  setPriceOpen(true);
                }}
              >
                Editar preço
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
                <Plus size={14} />
                Adicionar ingrediente
              </button>
            </>
          ) : null
        }
      />

      {recipe.active === false ? <div className="mb-4 border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-warn">
        Esta ficha está inativa e foi mantida no histórico. Reative-a para voltar a tratá-la como ficha atual.
      </div> : null}

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-4">
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Preço de venda</div>
          <div className="mt-2 num text-[21px] text-cream">{money(recipe.salePriceCents)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">valor de cardápio</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Custo por porção</div>
          <div className="mt-2 num text-[21px] text-cream">{marginCalculable ? money(cost) : '—'}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">Lote rende {recipe.yieldPortions || 1} porção(ões) · {lines.length} de {recipe.ingredients.length} insumos</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Margem bruta</div>
          <div className="mt-2 num text-[21px] text-cream">{marginCalculable ? money(margin.marginCents) : '—'}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {marginCalculable ? `${(margin.marginPct * 100).toFixed(1)}% do preço de venda` : 'não calculável'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Percentual de custo</div>
          <div className={`mt-2 num text-[21px] ${marginCalculable && margin.costPct > 0.35 ? 'text-copper' : 'text-cream'}`}>
            {marginCalculable ? `${(margin.costPct * 100).toFixed(1)}%` : '—'}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {marginCalculable ? margin.costPct > 0.35 ? 'acima da faixa de 35%' : 'dentro da faixa de 35%' : 'custo ou preço não informado'}
          </div>
        </div>
      </section>

      {!marginCalculable ? <ToneNote tone="warn">
        Margem indisponível: {recipe.salePriceCents <= 0 ? 'informe o preço de venda.' : null}
        {costGaps.length ? ` Cadastre um custo positivo para: ${costGaps.join(', ')}.` : null}
        {recipe.ingredients.length === 0 ? ' Adicione ao menos um insumo à ficha.' : null}
      </ToneNote> : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          title="Ingredientes"
          subtitle="Quantidades e custo por ingrediente no lote completo; o resumo mostra o custo por porção."
          flush
          bodyClassName=""
          actions={
            can('recipes.manage') ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddOpen(true)}>
                <Plus size={12} />
                Insumo
              </button>
            ) : null
          }
        >
          {lines.length === 0 ? (
            <EmptyState
              icon={<BookOpen size={18} />}
              title="Ficha sem ingredientes"
              description="Adicione insumos para calcular o custo real do prato e a margem."
              action={
                can('recipes.manage') ? (
                  <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
                    Adicionar ingrediente
                  </button>
                ) : null
              }
            />
          ) : (
            <>
              <div className="scroll-x hidden md:block">
                <table className="table min-w-[680px]">
                  <thead>
                    <tr>
                      <th>Insumo</th>
                      <th className="text-right">No lote</th>
                      <th className="text-right">Custo unit.</th>
                      <th className="text-right">Custo no lote</th>
                      <th className="text-right">% do lote</th>
                      <th className="w-[70px]" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map(({ ingredient, item, lineCost }) => (
                      <tr key={item.id}>
                        <td>
                          <Link
                            to={`/estoque/${item.id}`}
                            className="text-[12.5px] text-cream hover:text-copper"
                          >
                            {item.name}
                          </Link>
                          <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                            {item.category} · {itemCostKnown(item) ? `${money(item.costCents)}/${item.unit}` : 'custo não cadastrado'}
                          </div>
                        </td>
                        <td className="text-right num text-[12px] text-muted">
                          {fmtQty(ingredient.qty, ingredient.unit)}
                        </td>
                        <td className="text-right num text-[11.5px] text-dim">
                          {itemCostKnown(item) ? money(item.costCents) : '—'}
                        </td>
                        <td className="text-right num text-[12px] text-cream">{lineCost == null ? '—' : money(lineCost)}</td>
                        <td className="text-right num text-[11px] text-dim">
                          {marginCalculable && batchCost > 0 && lineCost != null
                            ? `${((lineCost / batchCost) * 100).toFixed(1)}%` : '—'}
                        </td>
                        <td className="text-right">
                          {can('recipes.manage') ? (
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                className="text-[10.5px] text-dim hover:text-cream"
                                onClick={() => {
                                  setEditItemId(item.id);
                                  setEditQty(decimalRaw(ingredient.qty));
                                }}
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                className="text-dim hover:text-danger"
                                onClick={() => setRemoveItemId(item.id)}
                                aria-label={`Remover ${item.name}`}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="divide-y divide-line md:hidden">
                {lines.map(({ ingredient, item, lineCost }) => (
                  <div key={item.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Link to={`/estoque/${item.id}`} className="text-[13px] text-cream">
                          {item.name}
                        </Link>
                        <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                          {fmtQty(ingredient.qty, ingredient.unit)} · {itemCostKnown(item) ? `${money(item.costCents)}/${item.unit}` : 'custo não cadastrado'}
                        </div>
                      </div>
                      <span className="num text-[12px] text-cream">{lineCost == null ? '—' : money(lineCost)}</span>
                    </div>
                    {can('recipes.manage') ? (
                      <div className="mt-1.5 flex gap-3">
                        <button
                          type="button"
                          className="text-[10.5px] text-dim hover:text-cream"
                          onClick={() => {
                            setEditItemId(item.id);
                            setEditQty(decimalRaw(ingredient.qty));
                          }}
                        >
                          Editar quantidade
                        </button>
                        <button
                          type="button"
                          className="text-[10.5px] text-dim hover:text-danger"
                          onClick={() => setRemoveItemId(item.id)}
                        >
                          Remover
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between border-t border-line px-4 py-3">
                <span className="text-[11px] text-dim">Custo estimado do prato</span>
                <span className="num text-[15px] text-cream">{marginCalculable ? money(cost) : '—'}</span>
              </div>
            </>
          )}
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title="Composição do custo" subtitle="Participação de cada insumo.">
            {!marginCalculable ? (
              <p className="text-[11.5px] leading-relaxed text-muted">
                A composição percentual não pode ser calculada. Complete os custos dos insumos{costGaps.length ? `: ${costGaps.join(', ')}.` : ' e informe o preço de venda.'}
              </p>
            ) : lines.length === 0 ? (
              <p className="text-[11.5px] leading-relaxed text-dim">
                Sem ingredientes para calcular a composição.
              </p>
            ) : (
              <div className="space-y-3">
                {lines.slice(0, 6).map(({ item, lineCost }) => (
                  <div key={item.id}>
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate text-muted">{item.name}</span>
                      <span className="num shrink-0 text-dim">
                        {batchCost > 0 && lineCost != null ? `${((lineCost / batchCost) * 100).toFixed(1)}%` : '—'}
                      </span>
                    </div>
                    <div className="mt-1 h-[2px] w-full bg-line">
                      <div
                        className="h-full bg-copper/70"
                        style={{ width: `${batchCost > 0 && lineCost != null ? (lineCost / batchCost) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
                <div className="border-t border-line pt-3 text-[10.5px] leading-relaxed text-dim">
                  O custo da ficha é recalculado sempre que o preço de um insumo muda no recebimento.
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Custo atual vs. histórico" subtitle="Proteção do custo de pedidos passados.">
            <div className="space-y-2.5 text-[11.5px]">
              <div className="flex items-center justify-between">
                <span className="text-muted">Custo atual por porção</span>
                <span className="num text-cream">{marginCalculable ? money(cost) : '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Último snapshot por porção</span>
                <span className="num text-cream">
                  {latestSnapshot && latestSnapshot.costComplete !== false ? money(latestSnapshot.costCents) : '—'}
                </span>
              </div>
              {latestSnapshot ? (
                <div className="text-[10px] text-dim">
                  lote de {latestSnapshot.yieldPortions || 1} porção(ões) · registrado em {dateTime(latestSnapshot.at)} · {latestSnapshot.trigger}
                </div>
              ) : null}
            </div>
            <ToneNote>
              Pedidos já realizados mantêm o custo congelado no snapshot da época. O custo atual não
              reescreve histórico.
            </ToneNote>
          </Panel>
        </div>
      </div>

      <Panel
        className="mt-5"
        title="Histórico de custo da ficha"
        subtitle="Snapshots gerados por mudança de preço, ficha ou contagem aprovada."
        flush
        bodyClassName=""
      >
        {snapshotLoading && snapshots.length === 0 ? (
          <div className="px-4 py-5 text-[12px] text-dim">Carregando histórico de custo…</div>
        ) : snapshotError && snapshots.length === 0 ? (
          <EmptyState icon={<BookOpen size={18} />} title="Histórico indisponível"
            description="Não foi possível consultar os snapshots desta ficha. Tente novamente."
            action={<button type="button" className="btn btn-ghost"
              onClick={() => setSnapshotRetry((value) => value + 1)}>Tentar novamente</button>} />
        ) : snapshots.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={18} />}
            title="Nenhum snapshot registrado"
            description="Assim que um preço de insumo mudar, o custo da ficha passa a ser versionado aqui."
          />
        ) : (
          <div className="scroll-x">
            <table className="table min-w-[790px]">
              <thead>
                <tr>
                  <th>Data</th>
                  <th className="text-right">Custo do lote</th>
                  <th className="text-right">Custo/porção</th>
                  <th className="text-right">Rendimento</th>
                  <th className="text-right">Preço de venda</th>
                  <th className="text-right">Margem bruta</th>
                  <th className="text-right">% de custo</th>
                  <th>Origem</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap) => {
                  const snapMargin = snap.salePriceCents - snap.costCents;
                  const snapCalculable = snap.costComplete !== false && snap.salePriceCents > 0;
                  return (
                    <tr key={snap.id}>
                      <td className="whitespace-nowrap text-[11px] text-muted">
                        {shortDate(snap.at)}
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">{snap.costComplete === false ? '—' : money(snap.batchCostCents ?? snap.costCents * (snap.yieldPortions || 1))}</td>
                      <td className="text-right num text-[11.5px] text-cream">{snap.costComplete === false ? '—' : money(snap.costCents)}</td>
                      <td className="text-right num text-[11.5px] text-muted">{snap.yieldPortions || 1}</td>
                      <td className="text-right num text-[11.5px] text-muted">
                        {money(snap.salePriceCents)}
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">{snapCalculable ? money(snapMargin) : '—'}</td>
                      <td className="text-right num text-[11px] text-dim">
                        {snapCalculable ? `${((snap.costCents / snap.salePriceCents) * 100).toFixed(1)}%` : '—'}
                      </td>
                      <td className="text-[10.5px] text-dim">{snap.trigger}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {mode === 'production' && snapshots.length > 0 && snapshotHasMore ? (
          <div className="flex flex-wrap items-center justify-center gap-3 border-t border-line px-4 py-3">
            {snapshotError ? <span role="alert" className="text-[10.5px] text-danger">{snapshotError}</span> : null}
            <button type="button" className="btn btn-ghost" onClick={() => { void loadMoreSnapshots(); }}
              disabled={snapshotLoading}>
              {snapshotLoading ? 'Carregando histórico…' : 'Carregar snapshots anteriores'}
            </button>
          </div>
        ) : null}
      </Panel>

      <Drawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        eyebrow={recipe.name}
        title="Adicionar ingrediente"
        description="Informe a quantidade usada no lote completo. O custo por porção considera o rendimento cadastrado."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                const ok = await Promise.resolve(actions.addRecipeIngredient(
                  recipe.id,
                  newItemId,
                  parsedNewQty ?? 0,
                  newUnit,
                ));
                if (ok) {
                  setAddOpen(false);
                  setNewItemId('');
                  setNewQty('');
                }
              }}
              disabled={!newItemId || parsedNewQty == null || parsedNewQty <= 0}
            >
              Adicionar
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Insumo" htmlFor="recipe-item">
            {mode === 'production' ? <input className="input mb-2 h-9"
              value={ingredientSearch} onChange={(event) => setIngredientSearch(event.target.value)}
              placeholder="Buscar insumo ativo" aria-label="Buscar insumo ativo" /> : null}
            <select
              id="recipe-item"
              className="select"
              value={newItemId}
              onChange={(event) => {
                const nextId = event.target.value;
                setNewItemId(nextId);
                const item = selectableNewItems.find((candidate) => candidate.id === nextId);
                if (item) {
                  actions.cacheIngredients([item]);
                  setNewUnit(item.unit);
                }
              }}
            >
              <option value="">Selecionar insumo</option>
              {selectableNewItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {itemCostKnown(item) ? `${money(item.costCents)}/${item.unit}` : 'custo não cadastrado'}
                </option>
              ))}
            </select>
            {mode === 'production' && ingredientOptionsLoading ? <p role="status" className="mt-1 text-[10.5px] text-dim">Buscando insumos…</p> : null}
            {mode === 'production' && ingredientOptionsError ? <p role="alert" className="mt-1 text-[10.5px] text-danger">{ingredientOptionsError}</p> : null}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantidade no lote" htmlFor="recipe-qty">
              <input
                id="recipe-qty"
                className="input num"
                inputMode="decimal"
                value={newQty}
                onChange={(event) => setNewQty(event.target.value)}
                placeholder="Ex.: 160"
                aria-invalid={!!newQty.trim() && parsedNewQty == null}
              />
            </Field>
            {newQty.trim() && parsedNewQty == null ? <p role="alert" className="text-[10.5px] text-danger">Use uma quantidade válida com até 3 casas decimais.</p> : null}
            <Field label="Unidade" htmlFor="recipe-unit">
              <select
                id="recipe-unit"
                className="select"
                value={newUnit}
                onChange={(event) => setNewUnit(event.target.value as Unit)}
              >
                {newUnitOptions.map((value) => (
                  <option key={value} value={value}>
                    {UNIT_LABEL[value as keyof typeof UNIT_LABEL]
                      ?? `${value} (${selectedNewItem?.conversions?.[value] ?? 0} ${selectedNewItem?.unit})`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="text-[10.5px] leading-relaxed text-dim">
            Use g/ml para insumos controlados em kg/L ou uma embalagem cadastrada para esse insumo;
            o custo e o consumo são convertidos para a unidade-base.
          </p>
        </div>
      </Drawer>

      <Drawer
        open={editItemId != null}
        onClose={() => setEditItemId(null)}
        eyebrow={recipe.name}
        title="Editar quantidade"
        description={editing ? `${editing.item.name} · ${itemCostKnown(editing.item) ? `${money(editing.item.costCents)}/${editing.item.unit}` : 'custo não cadastrado'}` : ''}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditItemId(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                if (!editItemId) return;
                const ok = await Promise.resolve(actions.updateRecipeIngredient(recipe.id, editItemId, parsedEditQty ?? 0));
                if (ok) setEditItemId(null);
              }}
              disabled={parsedEditQty == null || parsedEditQty <= 0}
            >
              Salvar quantidade
            </button>
          </>
        }
      >
        {editing ? (
          <Field
            label={`Quantidade em ${editing.ingredient.unit}`}
            hint={`Equivale a ${fmtQty(editing.quantityInItemUnit, editing.item.unit)} no lote completo.`}
          >
            <input
              className="input num"
              inputMode="decimal"
              value={editQty}
              onChange={(event) => setEditQty(event.target.value)}
              aria-invalid={!!editQty.trim() && parsedEditQty == null}
            />
          </Field>
        ) : null}
        {editing && editQty.trim() && parsedEditQty == null ? <p role="alert" className="text-[10.5px] text-danger">Use uma quantidade válida com até 3 casas decimais.</p> : null}
      </Drawer>

      <Dialog
        open={yieldOpen}
        onClose={() => setYieldOpen(false)}
        title="Rendimento do lote"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setYieldOpen(false)}>Cancelar</button>
            <button type="button" className="btn btn-primary" onClick={async () => {
              const portions = Number(yieldText);
              if (!Number.isInteger(portions) || portions < 1 || portions > 10000) return;
              const ok = await Promise.resolve(actions.updateRecipeYield(recipe.id, portions));
              if (ok) setYieldOpen(false);
            }}>Salvar rendimento</button>
          </>
        }
      >
        <Field label="Porções produzidas pelo lote" hint="O custo total dos ingredientes será dividido por esse número. A ficha mantém o rendimento salvo em cada snapshot.">
          <input className="input num" type="number" min="1" max="10000" step="1" value={yieldText}
            onChange={(event) => setYieldText(event.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={priceOpen}
        onClose={() => setPriceOpen(false)}
        title="Editar preço de venda"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setPriceOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                const ok = await Promise.resolve(actions.updateRecipePrice(recipe.id, parseMoney(priceText)));
                if (ok) setPriceOpen(false);
              }}
            >
              Salvar preço
            </button>
          </>
        }
      >
        <Field label="Preço de venda" hint="O snapshot de custo é recalculado com o preço atual dos insumos.">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-dim">
              R$
            </span>
            <input
              className="input num pl-8"
              inputMode="decimal"
              value={priceText}
              onChange={(event) => setPriceText(event.target.value)}
            />
          </div>
        </Field>
      </Dialog>

      <Dialog
        open={removeItemId != null}
        onClose={() => setRemoveItemId(null)}
        title="Remover ingrediente"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setRemoveItemId(null)}>
              Manter
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                if (!removeItemId) return;
                const result = await Promise.resolve(actions.removeRecipeIngredient(recipe.id, removeItemId));
                if (result !== false) setRemoveItemId(null);
              }}
            >
              Remover
            </button>
          </>
        }
      >
        Remover <span className="text-cream">{removing?.name}</span> desta ficha altera o custo
        estimado do prato. Pedidos anteriores mantêm o snapshot de custo da época.
      </Dialog>
    </div>
  );
}

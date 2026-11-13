import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, BookOpen, Plus } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { recipeCostPerPortionCents, recipeMargin, recipeMarginCalculable } from '../domain/selectors';
import { compatibleIngredientUnits, money, parseMoney, parseStockQty } from '../domain/format';
import { EmptyState, Field, PageHeader, Panel, Drawer } from '../components/ui';
import type { Unit } from '../domain/types';
import { fetchApiIngredientsByIds, fetchApiInventoryPage, fetchApiRecipeInsights,
  fetchApiRecipePage, type ApiRecipeInsights } from '../lib/api';

const RECIPE_PAGE_SIZE = 50;

export function RecipesPage() {
  const { state, actions, can, mode, ready } = useApp();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [yieldPortions, setYieldPortions] = useState('1');
  const [unit, setUnit] = useState<Unit>('un');
  const [ingredientSearch, setIngredientSearch] = useState('');
  const [ingredientOptions, setIngredientOptions] = useState(state.items.filter((item) => item.active !== false));
  const [ingredientOptionsLoading, setIngredientOptionsLoading] = useState(false);
  const [ingredientOptionsError, setIngredientOptionsError] = useState<string | null>(null);
  const [remoteRecipes, setRemoteRecipes] = useState<typeof state.recipes>([]);
  const [recipeHasMore, setRecipeHasMore] = useState(false);
  const [recipeLoading, setRecipeLoading] = useState(false);
  const [recipeLoadingMore, setRecipeLoadingMore] = useState(false);
  const [recipeError, setRecipeError] = useState<string | null>(null);
  const [recipeInsights, setRecipeInsights] = useState<ApiRecipeInsights | null>(null);
  const [recipeInsightsError, setRecipeInsightsError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const loadRecipePage = async (offset: number) => {
    const page = await fetchApiRecipePage(offset, RECIPE_PAGE_SIZE);
    const ingredientIds = [...new Set(page.recipes.flatMap((recipe) => recipe.ingredients.map((line) => line.itemId)))];
    const ingredients = await fetchApiIngredientsByIds(ingredientIds);
    actionsRef.current.cacheIngredients(ingredients);
    actionsRef.current.cacheRecipes(page.recipes);
    return page;
  };

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) return;
    const generation = ++generationRef.current;
    let current = true;
    setRemoteRecipes([]);
    setRecipeHasMore(false);
    setRecipeLoading(true);
    setRecipeError(null);
    setRecipeInsights(null);
    setRecipeInsightsError(null);
    void loadRecipePage(0).then((page) => {
      if (current && generation === generationRef.current) {
        setRemoteRecipes(page.recipes);
        setRecipeHasMore(page.hasMore);
      }
    }).catch((error: unknown) => {
      if (current && generation === generationRef.current) setRecipeError(error instanceof Error
        ? error.message : 'Não foi possível carregar as fichas técnicas.');
    }).finally(() => {
      if (current && generation === generationRef.current) setRecipeLoading(false);
    });
    void fetchApiRecipeInsights().then((insights) => {
      if (current && generation === generationRef.current) setRecipeInsights(insights);
    }).catch((error: unknown) => {
      if (current && generation === generationRef.current) setRecipeInsightsError(error instanceof Error
        ? error.message : 'Não foi possível carregar os indicadores das fichas.');
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id]);
  useEffect(() => {
    if (!createOpen) return;
    if (mode !== 'production') {
      setIngredientOptions(state.items.filter((item) => item.active !== false));
      setIngredientOptionsError(null);
      return;
    }
    if (!ready || !state.restaurant.id) return;
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
  }, [createOpen, mode, ready, state.restaurant.id, ingredientSearch]);
  const selectedItem = state.items.find((candidate) => candidate.id === itemId)
    ?? ingredientOptions.find((candidate) => candidate.id === itemId);
  const selectableIngredients = mode === 'production'
    ? [...(selectedItem ? [selectedItem] : []), ...ingredientOptions.filter((item) => item.id !== itemId)]
    : ingredientOptions;
  const unitOptions = selectedItem
    ? compatibleIngredientUnits(selectedItem.unit, selectedItem.conversions)
    : [];
  const recipeSource = mode === 'production' ? remoteRecipes : state.recipes;
  const rows = recipeSource
    .map((recipe) => {
      const cost = recipeCostPerPortionCents(state, recipe);
      const calculable = recipeMarginCalculable(state, recipe);
      return { recipe, cost, calculable, margin: recipeMargin(recipe, cost) };
    })
    .sort((a, b) => Number(b.calculable) - Number(a.calculable)
      || (a.calculable && b.calculable
        ? b.margin.marginPct - a.margin.marginPct
        : a.recipe.name.localeCompare(b.recipe.name, 'pt-BR')));

  const calculableRows = rows.filter((row) => row.calculable);
  const activeRows = rows.filter(({ recipe }) => recipe.active !== false);
  const averageCost = mode === 'production' && recipeInsights ? recipeInsights.average_cost_ratio
    : calculableRows.length
    ? calculableRows.reduce((sum, row) => sum + row.margin.costPct, 0) / calculableRows.length
    : 0;
  const attention = mode === 'production' && recipeInsights ? recipeInsights.attention_count
    : calculableRows.filter((row) => row.margin.costPct > 0.35).length;
  const incomplete = mode === 'production' && recipeInsights ? recipeInsights.incomplete_count
    : rows.length - calculableRows.length;
  const activeCount = mode === 'production' && recipeInsights ? recipeInsights.active_count : activeRows.length;

  const create = async () => {
    const portions = Number(yieldPortions);
    const recipeQuantity = parseStockQty(quantity);
    if (!recipeQuantity || !Number.isInteger(portions) || portions < 1 || portions > 10000) return;
    const id = await actions.createRecipe({ name, salePriceCents: parseMoney(salePrice),
      itemId, qty: recipeQuantity, unit, yieldPortions: portions });
    if (!id) return;
    setCreateOpen(false);
    setName(''); setSalePrice(''); setItemId(''); setQuantity(''); setYieldPortions('1');
    navigate(`/fichas/${id}`);
  };

  return (
    <div>
      <PageHeader
        eyebrow="06 / Fichas Técnicas"
        title="Fichas técnicas"
        description="Registre a composição e acompanhe o custo atual de cada produto. A baixa automática por vendas ainda depende da integração com Pedidos."
        actions={can('recipes.manage') ? <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus size={14} />Nova ficha</button> : null}
        meta={
          <>
            <span className="text-[11px] text-muted">
              <span className="num text-cream">{activeCount}</span> fichas ativas
            </span>
            <span className="text-[11px] text-dim">·</span>
            <span className="text-[11px] text-muted">
              Custo médio <span className="num text-cream">{(recipeInsights?.calculable_count ?? calculableRows.length) ? `${(averageCost * 100).toFixed(1)}%` : '—'}</span> do preço entre fichas calculáveis
            </span>
            <span className="text-[11px] text-dim">·</span>
            <span className="text-[11px] text-muted">
              <span className="num text-copper">{attention}</span> acima de 35% de custo
            </span>
            {incomplete > 0 ? <><span className="text-[11px] text-dim">·</span><span className="text-[11px] text-warn">{incomplete} sem snapshot completo</span></> : null}
          </>
        }
      />

      <Panel title="Pratos e produtos" subtitle="Custo atual por prato; itens acima de 35% pedem revisão." flush bodyClassName="">
        {mode === 'production' && recipeLoading && rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-dim" role="status">Carregando fichas técnicas…</div>
        ) : mode === 'production' && recipeError && rows.length === 0 ? (
          <EmptyState icon={<BookOpen size={18} />} title="Não foi possível carregar as fichas"
            description={recipeError} action={<button type="button" className="btn btn-ghost" onClick={() => {
              setRecipeError(null); setRecipeLoading(true);
              void loadRecipePage(0).then((page) => { setRemoteRecipes(page.recipes); setRecipeHasMore(page.hasMore); })
                .catch((error: unknown) => setRecipeError(error instanceof Error ? error.message : 'Falha ao carregar fichas.'))
                .finally(() => setRecipeLoading(false));
            }}>Tentar novamente</button>} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={18} />}
            title="Nenhuma ficha técnica cadastrada"
            description="Crie uma ficha para registrar os insumos do produto e acompanhar o custo estimado."
            action={
              <Link to="/estoque" className="btn btn-ghost">
                Ver insumos disponíveis
              </Link>
            }
          />
        ) : (
          <>
            <div className="scroll-x hidden md:block">
              <table className="table min-w-[520px]">
                <thead>
                  <tr>
                    <th>Prato / produto</th>
                    <th className="text-right">Custo atual</th>
                    <th className="text-right">Do preço de venda</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ recipe, cost, calculable, margin }) => (
                    <tr key={recipe.id} className="row-link">
                      <td>
                        <Link to={`/fichas/${recipe.id}`} className="block">
                          <div className="text-[13px] text-cream">{recipe.name}</div>
                          <div className="mt-0.5 text-[10.5px] text-dim">
                            {recipe.active === false ? 'Ficha inativa · ' : ''}{recipe.ingredients.length} ingredientes · {recipe.yieldPortions || 1} porção(ões)
                          </div>
                        </Link>
                      </td>
                      <td className="text-right num text-[12px] text-cream">{calculable ? money(cost) : '—'}</td>
                      <td>
                        <div className={`num text-right text-[12px] ${calculable && margin.costPct > 0.35 ? 'text-warn' : 'text-muted'}`}>
                          {calculable ? `${margin.costPct > 0.35 ? '· ' : ''}${(margin.costPct * 100).toFixed(1)}% do preço de venda` : 'Custo não informado'}
                        </div>
                      </td>
                      <td className="w-8">
                        <ArrowRight size={13} className="text-dim" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-line md:hidden">
              {rows.map(({ recipe, cost, calculable, margin }) => (
                <Link
                  key={recipe.id}
                  to={`/fichas/${recipe.id}`}
                  className="block px-4 py-3.5 active:bg-raised/60"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13.5px] text-cream">{recipe.name}</div>
                      <div className="mt-0.5 text-[10.5px] text-dim">{recipe.active === false ? 'Ficha inativa · ' : ''}{recipe.ingredients.length} ingredientes · {recipe.yieldPortions || 1} porção(ões)</div>
                    </div>
                    <div className="text-right">
                      <div className={`num text-[11.5px] ${calculable && margin.costPct > 0.35 ? 'text-copper' : 'text-muted'}`}>
                        {calculable ? `${(margin.costPct * 100).toFixed(1)}%` : '—'}
                      </div>
                      <div className="text-[9.5px] uppercase tracking-[0.08em] text-dim">{calculable ? 'custo' : 'sem custo'}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className="text-muted">Custo <span className="num text-cream">{calculable ? money(cost) : '—'}</span></span>
                    <span className={`num ${calculable && margin.costPct > 0.35 ? 'text-warn' : 'text-dim'}`}>{calculable ? `${margin.costPct > 0.35 ? '· ' : ''}${(margin.costPct * 100).toFixed(1)}% do preço` : 'Custo não informado'}</span>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
        {mode === 'production' && recipeInsightsError ? <p role="alert" className="border-t border-line px-4 py-3 text-[11px] text-warn">Os indicadores das fichas não atualizaram: {recipeInsightsError}</p> : null}
        {mode === 'production' && recipeError && rows.length > 0 ? <p role="alert" className="border-t border-line px-4 py-3 text-[11px] text-warn">{recipeError}</p> : null}
        {mode === 'production' && recipeHasMore ? <div className="border-t border-line px-4 py-3 text-center">
          <button type="button" className="btn btn-ghost" disabled={recipeLoadingMore} onClick={async () => {
            if (recipeLoadingMore) return;
            const generation = generationRef.current;
            setRecipeLoadingMore(true); setRecipeError(null);
            try {
              const page = await loadRecipePage(remoteRecipes.length);
              if (generation !== generationRef.current) return;
              setRemoteRecipes((previous) => [...previous, ...page.recipes]);
              setRecipeHasMore(page.hasMore);
            } catch (error) {
              if (generation === generationRef.current) setRecipeError(error instanceof Error
                ? error.message : 'Não foi possível carregar mais fichas.');
            } finally { if (generation === generationRef.current) setRecipeLoadingMore(false); }
          }}>{recipeLoadingMore ? 'Carregando…' : 'Carregar mais fichas'}</button>
        </div> : null}
      </Panel>

      <p className="mt-3 text-[10.5px] leading-relaxed text-dim">
        A margem é calculada sobre o custo atual dos ingredientes. Alterações futuras de preço geram
        novo snapshot; pedidos passados preservam o custo da época.
      </p>

      <Drawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        eyebrow="Nova ficha técnica"
        title="Cadastrar produto"
        description="Informe o preço de venda e ao menos um insumo. Você poderá completar a composição depois."
        footer={<><button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>Cancelar</button><button type="button" className="btn btn-primary" onClick={create} disabled={!name.trim() || !itemId || (parseStockQty(quantity) ?? 0) <= 0 || parseMoney(salePrice) <= 0 || !Number.isInteger(Number(yieldPortions)) || Number(yieldPortions) < 1 || Number(yieldPortions) > 10000}>Criar ficha</button></>}
      >
        <div className="space-y-4">
          <Field label="Nome do produto" htmlFor="recipe-name"><input id="recipe-name" className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Hambúrguer da casa" /></Field>
          <Field label="Preço de venda" htmlFor="recipe-price"><input id="recipe-price" className="input num" inputMode="decimal" value={salePrice} onChange={(event) => setSalePrice(event.target.value)} placeholder="0,00" /></Field>
          <Field label="Rendimento do lote (porções)" htmlFor="recipe-yield" hint="O custo dos insumos será dividido pelo rendimento para comparar com o preço por porção."><input id="recipe-yield" className="input num" type="number" min="1" max="10000" step="1" value={yieldPortions} onChange={(event) => setYieldPortions(event.target.value)} /></Field>
          {mode === 'production' ? <input className="input h-9" value={ingredientSearch}
            onChange={(event) => setIngredientSearch(event.target.value)} placeholder="Buscar insumo ativo"
            aria-label="Buscar insumo ativo" /> : null}
          <div className="grid grid-cols-[1fr_86px_72px] gap-2">
            <Field label="Primeiro insumo" htmlFor="recipe-item"><select id="recipe-item" className="select" value={itemId} onChange={(event) => { const nextId = event.target.value; setItemId(nextId); const selected = selectableIngredients.find((item) => item.id === nextId); if (selected) { actions.cacheIngredients([selected]); setUnit(selected.unit); } }}><option value="">Selecionar</option>{selectableIngredients.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="Quantidade no lote" htmlFor="recipe-qty"><input id="recipe-qty" className="input num" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="0" aria-invalid={!!quantity.trim() && parseStockQty(quantity) == null} /></Field>
            <Field label="Unidade" htmlFor="recipe-unit"><select id="recipe-unit" className="select" value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>{unitOptions.map((value) => <option key={value} value={value}>{selectedItem?.conversions?.[value] ? `${value} (${selectedItem.conversions[value]} ${selectedItem.unit})` : value}</option>)}</select></Field>
          </div>
          {mode === 'production' && ingredientOptionsLoading ? <p role="status" className="text-[10.5px] text-dim">Buscando insumos…</p> : null}
          {mode === 'production' && ingredientOptionsError ? <p role="alert" className="text-[10.5px] text-danger">{ingredientOptionsError}</p> : null}
          {quantity.trim() && parseStockQty(quantity) == null ? <p role="alert" className="text-[10.5px] text-danger">Use uma quantidade válida com até 3 casas decimais.</p> : null}
          {itemId ? <p className="text-[10.5px] leading-relaxed text-dim">Estoque controlado em {state.items.find((item) => item.id === itemId)?.unit}; a quantidade será convertida para essa unidade no cálculo de custo.</p> : null}
        </div>
      </Drawer>
    </div>
  );
}

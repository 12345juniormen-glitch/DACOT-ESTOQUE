import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, Info, Plus, Trash2 } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { recipeCostCents, recipeMargin } from '../domain/selectors';
import {
  convertQty,
  dateTime,
  decimalRaw,
  money,
  moneyInput,
  parseMoney,
  parseQty,
  qty as fmtQty,
  shortDate,
} from '../domain/format';
import { UNIT_LABEL, type Unit } from '../domain/types';
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
  const { state, actions, can } = useApp();
  const recipe = state.recipes.find((r) => r.id === id);
  const [addOpen, setAddOpen] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceText, setPriceText] = useState('');
  const [newItemId, setNewItemId] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newUnit, setNewUnit] = useState<Unit>('kg');
  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState('');
  const [removeItemId, setRemoveItemId] = useState<string | null>(null);

  if (!recipe) {
    return (
      <div>
        <BackLink to="/fichas">Fichas técnicas</BackLink>
        <Panel>
          <EmptyState
            icon={<Info size={18} />}
            title="Ficha não encontrada"
            description="A ficha pode ter sido removida ou o endereço está incorreto."
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

  const cost = recipeCostCents(state, recipe);
  const margin = recipeMargin(recipe, cost);
  const lines = recipe.ingredients
    .map((ingredient) => {
      const item = state.items.find((i) => i.id === ingredient.itemId);
      if (!item) return null;
      const quantityInItemUnit = convertQty(ingredient.qty, ingredient.unit, item.unit);
      const lineCost = Math.round(quantityInItemUnit * item.costCents);
      return { ingredient, item, lineCost, quantityInItemUnit };
    })
    .filter((line): line is NonNullable<typeof line> => line != null)
    .sort((a, b) => b.lineCost - a.lineCost);
  const snapshots = state.recipeSnapshots
    .filter((snap) => snap.recipeId === recipe.id)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const latestSnapshot = snapshots[0];
  const removing = state.items.find((i) => i.id === removeItemId);
  const editing = lines.find((line) => line.item.id === editItemId);
  const availableItems = state.items.filter(
    (item) => !recipe.ingredients.some((ingredient) => ingredient.itemId === item.id),
  );

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

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-4">
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Preço de venda</div>
          <div className="mt-2 num text-[21px] text-cream">{money(recipe.salePriceCents)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">valor de cardápio</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Custo estimado</div>
          <div className="mt-2 num text-[21px] text-cream">{money(cost)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">{lines.length} insumos</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Margem bruta</div>
          <div className="mt-2 num text-[21px] text-cream">{money(margin.marginCents)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {(margin.marginPct * 100).toFixed(1)}% do preço de venda
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Percentual de custo</div>
          <div className={`mt-2 num text-[21px] ${margin.costPct > 0.35 ? 'text-copper' : 'text-cream'}`}>
            {(margin.costPct * 100).toFixed(1)}%
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {margin.costPct > 0.35 ? 'acima da faixa de 35%' : 'dentro da faixa de 35%'}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          title="Ingredientes"
          subtitle="Quantidade por porção e custo com o preço atual."
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
                      <th className="text-right">Por porção</th>
                      <th className="text-right">Custo unit.</th>
                      <th className="text-right">Custo na ficha</th>
                      <th className="text-right">% do custo</th>
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
                            {item.category} · {money(item.costCents)}/{item.unit}
                          </div>
                        </td>
                        <td className="text-right num text-[12px] text-muted">
                          {fmtQty(ingredient.qty, ingredient.unit)}
                        </td>
                        <td className="text-right num text-[11.5px] text-dim">
                          {money(item.costCents)}
                        </td>
                        <td className="text-right num text-[12px] text-cream">{money(lineCost)}</td>
                        <td className="text-right num text-[11px] text-dim">
                          {cost > 0 ? ((lineCost / cost) * 100).toFixed(1) : '0,0'}%
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
                          {fmtQty(ingredient.qty, ingredient.unit)} · {money(item.costCents)}/{item.unit}
                        </div>
                      </div>
                      <span className="num text-[12px] text-cream">{money(lineCost)}</span>
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
                <span className="num text-[15px] text-cream">{money(cost)}</span>
              </div>
            </>
          )}
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title="Composição do custo" subtitle="Participação de cada insumo.">
            {lines.length === 0 ? (
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
                        {cost > 0 ? ((lineCost / cost) * 100).toFixed(1) : '0,0'}%
                      </span>
                    </div>
                    <div className="mt-1 h-[2px] w-full bg-line">
                      <div
                        className="h-full bg-copper/70"
                        style={{ width: `${cost > 0 ? (lineCost / cost) * 100 : 0}%` }}
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
                <span className="text-muted">Custo atual</span>
                <span className="num text-cream">{money(cost)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Último snapshot</span>
                <span className="num text-cream">
                  {latestSnapshot ? money(latestSnapshot.costCents) : '—'}
                </span>
              </div>
              {latestSnapshot ? (
                <div className="text-[10px] text-dim">
                  registrado em {dateTime(latestSnapshot.at)} · {latestSnapshot.trigger}
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
        {snapshots.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={18} />}
            title="Nenhum snapshot registrado"
            description="Assim que um preço de insumo mudar, o custo da ficha passa a ser versionado aqui."
          />
        ) : (
          <div className="scroll-x">
            <table className="table min-w-[660px]">
              <thead>
                <tr>
                  <th>Data</th>
                  <th className="text-right">Custo da ficha</th>
                  <th className="text-right">Preço de venda</th>
                  <th className="text-right">Margem bruta</th>
                  <th className="text-right">% de custo</th>
                  <th>Origem</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap) => {
                  const snapMargin = snap.salePriceCents - snap.costCents;
                  return (
                    <tr key={snap.id}>
                      <td className="whitespace-nowrap text-[11px] text-muted">
                        {shortDate(snap.at)}
                      </td>
                      <td className="text-right num text-[11.5px] text-cream">{money(snap.costCents)}</td>
                      <td className="text-right num text-[11.5px] text-muted">
                        {money(snap.salePriceCents)}
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">{money(snapMargin)}</td>
                      <td className="text-right num text-[11px] text-dim">
                        {snap.salePriceCents > 0
                          ? ((snap.costCents / snap.salePriceCents) * 100).toFixed(1)
                          : '0,0'}
                        %
                      </td>
                      <td className="text-[10.5px] text-dim">{snap.trigger}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Drawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        eyebrow={recipe.name}
        title="Adicionar ingrediente"
        description="A quantidade é por porção vendida. O custo é convertido para a unidade do insumo."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const ok = actions.addRecipeIngredient(
                  recipe.id,
                  newItemId,
                  parseQty(newQty),
                  newUnit,
                );
                if (ok) {
                  setAddOpen(false);
                  setNewItemId('');
                  setNewQty('');
                }
              }}
            >
              Adicionar
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Insumo" htmlFor="recipe-item">
            <select
              id="recipe-item"
              className="select"
              value={newItemId}
              onChange={(event) => {
                setNewItemId(event.target.value);
                const item = state.items.find((i) => i.id === event.target.value);
                if (item) setNewUnit(item.unit);
              }}
            >
              <option value="">Selecionar insumo</option>
              {availableItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {money(item.costCents)}/{item.unit}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantidade por porção" htmlFor="recipe-qty">
              <input
                id="recipe-qty"
                className="input num"
                inputMode="decimal"
                value={newQty}
                onChange={(event) => setNewQty(event.target.value)}
                placeholder="Ex.: 160"
              />
            </Field>
            <Field label="Unidade" htmlFor="recipe-unit">
              <select
                id="recipe-unit"
                className="select"
                value={newUnit}
                onChange={(event) => setNewUnit(event.target.value as Unit)}
              >
                {Object.entries(UNIT_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="text-[10.5px] leading-relaxed text-dim">
            Usar gramas para insumos controlados em kg é permitido: o sistema converte
            automaticamente para o consumo em estoque.
          </p>
        </div>
      </Drawer>

      <Drawer
        open={editItemId != null}
        onClose={() => setEditItemId(null)}
        eyebrow={recipe.name}
        title="Editar quantidade"
        description={editing ? `${editing.item.name} · ${money(editing.item.costCents)}/${editing.item.unit}` : ''}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditItemId(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (!editItemId) return;
                const ok = actions.updateRecipeIngredient(recipe.id, editItemId, parseQty(editQty));
                if (ok) setEditItemId(null);
              }}
            >
              Salvar quantidade
            </button>
          </>
        }
      >
        {editing ? (
          <Field
            label={`Quantidade em ${editing.ingredient.unit}`}
            hint={`Equivale a ${fmtQty(editing.quantityInItemUnit, editing.item.unit)} de estoque por porção.`}
          >
            <input
              className="input num"
              inputMode="decimal"
              value={editQty}
              onChange={(event) => setEditQty(event.target.value)}
            />
          </Field>
        ) : null}
      </Drawer>

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
              onClick={() => {
                const ok = actions.updateRecipePrice(recipe.id, parseMoney(priceText));
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
              onClick={() => {
                if (removeItemId) actions.removeRecipeIngredient(recipe.id, removeItemId);
                setRemoveItemId(null);
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

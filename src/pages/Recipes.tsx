import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { recipeCostCents, recipeMargin } from '../domain/selectors';
import { money } from '../domain/format';
import { EmptyState, PageHeader, Panel } from '../components/ui';

export function RecipesPage() {
  const { state } = useApp();
  const rows = state.recipes
    .map((recipe) => {
      const cost = recipeCostCents(state, recipe);
      return { recipe, cost, margin: recipeMargin(recipe, cost) };
    })
    .sort((a, b) => b.margin.marginPct - a.margin.marginPct);

  const averageCost = rows.length
    ? rows.reduce((sum, row) => sum + row.margin.costPct, 0) / rows.length
    : 0;
  const attention = rows.filter((row) => row.margin.costPct > 0.35).length;

  return (
    <div>
      <PageHeader
        eyebrow="06 / Fichas Técnicas"
        title="Fichas técnicas"
        description="Configure a ficha uma vez. Pedidos entregues usam esses ingredientes para calcular o consumo e o custo do prato."
        meta={
          <>
            <span className="text-[11px] text-muted">
              <span className="num text-cream">{rows.length}</span> fichas ativas
            </span>
            <span className="text-[11px] text-dim">·</span>
            <span className="text-[11px] text-muted">
              Custo médio <span className="num text-cream">{(averageCost * 100).toFixed(1)}%</span> do
              preço de venda
            </span>
            <span className="text-[11px] text-dim">·</span>
            <span className="text-[11px] text-muted">
              <span className="num text-copper">{attention}</span> acima de 35% de custo
            </span>
          </>
        }
      />

      <Panel title="Pratos e produtos" subtitle="Custo atual por prato; itens acima de 35% pedem revisão." flush bodyClassName="">
        {rows.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={18} />}
            title="Nenhuma ficha técnica cadastrada"
            description="Crie a ficha de um prato para ligar a venda ao consumo de ingredientes e calcular a margem."
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
                  {rows.map(({ recipe, cost, margin }) => (
                    <tr key={recipe.id} className="row-link">
                      <td>
                        <Link to={`/fichas/${recipe.id}`} className="block">
                          <div className="text-[13px] text-cream">{recipe.name}</div>
                          <div className="mt-0.5 text-[10.5px] text-dim">
                            {recipe.ingredients.length} ingredientes
                          </div>
                        </Link>
                      </td>
                      <td className="text-right num text-[12px] text-cream">{money(cost)}</td>
                      <td>
                        <div className={`num text-right text-[12px] ${margin.costPct > 0.35 ? 'text-warn' : 'text-muted'}`}>
                          {margin.costPct > 0.35 ? '· ' : ''}{(margin.costPct * 100).toFixed(1)}% do preço de venda
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
              {rows.map(({ recipe, cost, margin }) => (
                <Link
                  key={recipe.id}
                  to={`/fichas/${recipe.id}`}
                  className="block px-4 py-3.5 active:bg-raised/60"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13.5px] text-cream">{recipe.name}</div>
                      <div className="mt-0.5 text-[10.5px] text-dim">{recipe.ingredients.length} ingredientes</div>
                    </div>
                    <div className="text-right">
                      <div className={`num text-[11.5px] ${margin.costPct > 0.35 ? 'text-copper' : 'text-muted'}`}>
                        {(margin.costPct * 100).toFixed(1)}%
                      </div>
                      <div className="text-[9.5px] uppercase tracking-[0.08em] text-dim">custo</div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className="text-muted">Custo <span className="num text-cream">{money(cost)}</span></span>
                    <span className={`num ${margin.costPct > 0.35 ? 'text-warn' : 'text-dim'}`}>{margin.costPct > 0.35 ? '· ' : ''}{(margin.costPct * 100).toFixed(1)}% do preço</span>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </Panel>

      <p className="mt-3 text-[10.5px] leading-relaxed text-dim">
        A margem é calculada sobre o custo atual dos ingredientes. Alterações futuras de preço geram
        novo snapshot; pedidos passados preservam o custo da época.
      </p>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { date, qty } from '../domain/format';
import { itemStatus } from '../domain/selectors';
import {
  MOVEMENT_LABEL,
  PURCHASE_STATUS_LABEL,
  STATUS_LABEL,
} from '../domain/types';
import type { AppState } from '../domain/types';
import type { Permission } from '../domain/permissions';
import { useApp } from '../state/AppStore';

type SearchGroup = 'Estoque' | 'Compras' | 'Fornecedores' | 'Fichas técnicas' | 'Contagens' | 'Perdas & movimentos';

interface SearchDocument {
  id: string;
  group: SearchGroup;
  title: string;
  subtitle: string;
  href: string;
  searchable: string;
  status?: 'attention' | 'critical' | 'empty';
}

const GROUP_ORDER: SearchGroup[] = [
  'Estoque',
  'Compras',
  'Fornecedores',
  'Fichas técnicas',
  'Contagens',
  'Perdas & movimentos',
];

const COUNT_STATUS_LABEL = {
  open: 'Em andamento',
  review: 'Em revisão',
  approved: 'Aprovada',
} as const;

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function buildIndex(state: AppState, can: (permission: Permission) => boolean): SearchDocument[] {
  const tenantId = state.restaurant.id;
  const tenantSuppliers = state.suppliers.filter((supplier) => supplier.restaurantId === tenantId);
  const tenantItems = state.items.filter((item) => item.restaurantId === tenantId);
  const tenantUsers = state.users.filter((user) => user.restaurantId === tenantId);
  const suppliersById = new Map(tenantSuppliers.map((supplier) => [supplier.id, supplier]));
  const itemsById = new Map(tenantItems.map((item) => [item.id, item]));
  const usersById = new Map(tenantUsers.map((user) => [user.id, user]));
  const supplierNamesByItem = new Map<string, string[]>();
  for (const offer of state.supplierItems.filter((entry) => entry.restaurantId === tenantId)) {
    const supplierName = suppliersById.get(offer.supplierId)?.name;
    if (!supplierName) continue;
    const names = supplierNamesByItem.get(offer.itemId) ?? [];
    names.push(supplierName);
    supplierNamesByItem.set(offer.itemId, names);
  }
  const documents: SearchDocument[] = [];

  if (can('stock.view')) {
    for (const item of tenantItems) {
      const supplier = item.primarySupplierId ? suppliersById.get(item.primarySupplierId) : undefined;
      const relatedSuppliers = supplierNamesByItem.get(item.id) ?? [];
      const status = itemStatus(item);
      documents.push({
        id: `item:${item.id}`,
        group: 'Estoque',
        title: item.name,
        subtitle: `${item.category} · ${qty(item.currentQty, item.unit)}`,
        href: `/estoque/${item.id}`,
        searchable: normalize([
          item.name,
          item.id,
          item.category,
          item.unit,
          supplier?.name ?? '',
          relatedSuppliers.join(' '),
        ].join(' ')),
        status: status === 'normal' ? undefined : status,
      });
    }
  }

  if (can('purchases.view')) {
    for (const purchase of state.purchases.filter((entry) => entry.restaurantId === tenantId)) {
      const supplier = suppliersById.get(purchase.supplierId);
      const lineItems = purchase.lines.map((line) => itemsById.get(line.itemId)?.name ?? '').join(' ');
      documents.push({
        id: `purchase:${purchase.id}`,
        group: 'Compras',
        title: `${purchase.code} · ${supplier?.name ?? 'Fornecedor'}`,
        subtitle: `Compra · ${PURCHASE_STATUS_LABEL[purchase.status]}`,
        href: `/compras/${purchase.id}`,
        searchable: normalize([
          purchase.code,
          purchase.id,
          supplier?.name ?? '',
          purchase.note,
          PURCHASE_STATUS_LABEL[purchase.status],
          lineItems,
        ].join(' ')),
      });
    }
  }

  if (can('suppliers.view')) {
    for (const supplier of tenantSuppliers) {
      documents.push({
        id: `supplier:${supplier.id}`,
        group: 'Fornecedores',
        title: supplier.name,
        subtitle: 'Fornecedor',
        href: `/fornecedores/${supplier.id}`,
        searchable: normalize([
          supplier.name,
          supplier.id,
          supplier.contact,
          supplier.phone,
          supplier.whatsapp,
          supplier.notes,
        ].join(' ')),
      });
    }
  }

  if (can('recipes.view')) {
    for (const recipe of state.recipes.filter((entry) => entry.restaurantId === tenantId)) {
      const ingredients = recipe.ingredients
        .map((ingredient) => itemsById.get(ingredient.itemId)?.name ?? '')
        .join(' ');
      documents.push({
        id: `recipe:${recipe.id}`,
        group: 'Fichas técnicas',
        title: recipe.name,
        subtitle: `Ficha técnica · ${recipe.ingredients.length} ingredientes`,
        href: `/fichas/${recipe.id}`,
        searchable: normalize([recipe.name, recipe.id, ingredients].join(' ')),
      });
    }
  }

  if (can('count.view')) {
    for (const count of state.counts.filter((entry) => entry.restaurantId === tenantId)) {
      const itemNames = count.lines.map((line) => itemsById.get(line.itemId)?.name ?? '').join(' ');
      const creator = usersById.get(count.createdBy)?.name ?? '';
      documents.push({
        id: `count:${count.id}`,
        group: 'Contagens',
        title: count.code,
        subtitle: `Contagem · ${COUNT_STATUS_LABEL[count.status]}`,
        href: `/contagem/${count.id}`,
        searchable: normalize([count.code, count.id, itemNames, creator, COUNT_STATUS_LABEL[count.status]].join(' ')),
      });
    }
  }

  if (can('losses.view')) {
    for (const loss of state.losses.filter((entry) => entry.restaurantId === tenantId)) {
      const item = itemsById.get(loss.itemId);
      const user = usersById.get(loss.userId);
      documents.push({
        id: `loss:${loss.id}`,
        group: 'Perdas & movimentos',
        title: `${item?.name ?? 'Insumo'} · ${loss.reason}`,
        subtitle: `Perda · ${date(loss.at)}`,
        href: `/perdas?focus=${encodeURIComponent(loss.id)}`,
        searchable: normalize([loss.id, item?.name ?? '', item?.category ?? '', loss.reason, loss.note, user?.name ?? '', date(loss.at)].join(' ')),
      });
    }

  }

  if (can('stock.view')) {
    for (const movement of state.movements.filter((entry) => entry.restaurantId === tenantId)) {
      const item = itemsById.get(movement.itemId);
      documents.push({
        id: `movement:${movement.id}`,
        group: 'Perdas & movimentos',
        title: item?.name ?? 'Insumo',
        subtitle: `Movimentação · ${MOVEMENT_LABEL[movement.type]} · ${date(movement.occurredAt)}`,
        href: `/estoque/${movement.itemId}`,
        searchable: normalize([
          movement.id,
          item?.name ?? '',
          item?.category ?? '',
          movement.reason,
          movement.origin,
          movement.type,
          MOVEMENT_LABEL[movement.type],
          date(movement.occurredAt),
        ].join(' ')),
      });
    }
  }

  return documents;
}

function score(document: SearchDocument, query: string, tokens: string[]): number {
  if (document.searchable === query) return 0;
  const title = normalize(document.title);
  if (title === query) return 1;
  if (title.startsWith(query)) return 2;
  if (title.includes(query)) return 3;
  if (tokens.every((token) => title.includes(token))) return 4;
  return 5;
}

export function GlobalSearch() {
  const { state, can } = useApp();
  const navigate = useNavigate();
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcutLabel = isMac ? '⌘K' : 'Ctrl K';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const index = useMemo(() => buildIndex(state, can), [state, can]);
  const searchableQuery = normalize(debouncedQuery);
  const tokens = searchableQuery.split(/\s+/).filter(Boolean);
  const matches = useMemo(() => {
    if (!searchableQuery) return [];
    return index
      .filter((document) => tokens.every((token) => document.searchable.includes(token)))
      .sort((a, b) => score(a, searchableQuery, tokens) - score(b, searchableQuery, tokens));
  }, [index, searchableQuery]);

  const groups = useMemo(() => {
    return GROUP_ORDER.flatMap((group) => {
      const results = matches.filter((document) => document.group === group).slice(0, 3);
      if (results.length === 0) return [];
      return [{ group, results }];
    });
  }, [matches]);
  const visibleResults = useMemo(() => groups.flatMap((group) => group.results), [groups]);
  const clippedResults = matches.length > visibleResults.length;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 120);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [searchableQuery]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    const onGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, []);

  useEffect(() => {
    if (activeIndex < visibleResults.length) {
      document.getElementById(`global-search-result-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, visibleResults.length]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setDebouncedQuery('');
    setActiveIndex(0);
    window.requestAnimationFrame(() => openerRef.current?.focus());
  };

  const openResult = (href: string) => {
    close();
    navigate(href);
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' && visibleResults.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % visibleResults.length);
    } else if (event.key === 'ArrowUp' && visibleResults.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + visibleResults.length) % visibleResults.length);
    } else if (event.key === 'Enter' && visibleResults[activeIndex]) {
      event.preventDefault();
      openResult(visibleResults[activeIndex].href);
    } else if (event.key === 'Tab' && dialogRef.current) {
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)');
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  const openFromButton = (event: ReactMouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget;
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-quiet h-8 gap-1.5 px-2 text-muted"
        onClick={openFromButton}
        aria-label="Buscar na DACOT"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Buscar na DACOT (${shortcutLabel})`}
      >
        <Search size={14} strokeWidth={1.7} />
        <span className="hidden text-[11.5px] sm:inline">Buscar</span>
        <span className="hidden border border-line px-1 font-mono text-[9px] text-dim lg:inline">{shortcutLabel}</span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[80] flex items-stretch justify-center bg-black/75 sm:items-start sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            id="global-search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Busca global DACOT"
            onKeyDown={handleDialogKeyDown}
            className="flex h-[100dvh] min-h-0 w-full flex-col border-x border-line bg-panel pt-[env(safe-area-inset-top)] sm:mt-[8vh] sm:h-auto sm:max-h-[82vh] sm:max-w-[640px] sm:border"
          >
            <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line px-4 sm:min-h-[60px] sm:px-5">
              <Search size={17} className="shrink-0 text-copper" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar na DACOT..."
                className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-cream outline-none placeholder:text-dim sm:text-[14px]"
                aria-label="Buscar insumos, compras, fornecedores e fichas técnicas"
                aria-controls="global-search-results"
                aria-activedescendant={visibleResults[activeIndex] ? `global-search-result-${activeIndex}` : undefined}
                autoComplete="off"
                spellCheck="false"
              />
              <button
                type="button"
                className="grid h-10 w-10 shrink-0 place-items-center text-muted hover:text-cream"
                onClick={close}
                aria-label="Fechar busca"
              >
                <X size={18} />
              </button>
            </div>

            <div id="global-search-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 sm:px-3">
              {!query.trim() ? (
                <div className="px-3 py-6 text-[12px] text-dim sm:py-8">
                  Busque insumos, compras, fornecedores, contagens, perdas e fichas técnicas.
                </div>
              ) : normalize(query) !== searchableQuery ? (
                <div className="px-3 py-6 text-[12px] text-dim">Buscando...</div>
              ) : visibleResults.length === 0 ? (
                <div className="px-3 py-6 text-[12px] text-dim sm:py-8">
                  Nenhum resultado para “{query.trim()}”.
                </div>
              ) : (
                <>
                  {groups.map(({ group, results }) => (
                    <section key={group} role="group" aria-label={group} className="mb-2 last:mb-0">
                      <h2 className="px-3 pb-1 pt-2 text-[9.5px] font-medium uppercase tracking-[0.15em] text-dim">
                        {group}
                      </h2>
                      {results.map((result) => {
                        const resultIndex = visibleResults.findIndex((candidate) => candidate.id === result.id);
                        const selected = resultIndex === activeIndex;
                        return (
                          <button
                            key={result.id}
                            id={`global-search-result-${resultIndex}`}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onMouseEnter={() => setActiveIndex(resultIndex)}
                            onClick={() => openResult(result.href)}
                            className={`flex min-h-12 w-full min-w-0 items-center justify-between gap-3 border-l-2 px-3 py-2.5 text-left transition-colors ${selected ? 'border-copper bg-raised' : 'border-transparent hover:bg-raised/70'}`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] text-cream">{result.title}</span>
                              <span className="mt-0.5 block truncate text-[10.5px] text-dim">{result.subtitle}</span>
                            </span>
                            {result.status ? (
                              <span className={`shrink-0 text-[10px] ${result.status === 'attention' ? 'text-warn' : 'text-danger'}`}>
                                ● {STATUS_LABEL[result.status]}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </section>
                  ))}
                  {clippedResults ? (
                    <div className="px-3 py-2 text-[10.5px] text-dim">
                      Mostrando até 3 resultados por tipo. Refine a busca para encontrar outros registros.
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div className="hidden shrink-0 items-center justify-between border-t border-line px-4 py-2.5 text-[10px] text-dim sm:flex">
              <span>↑ ↓ navegar · Enter abrir · Esc fechar</span>
              <span className="font-mono">{shortcutLabel.replace('K', ' K')}</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

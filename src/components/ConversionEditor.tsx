import { Plus, Trash2 } from 'lucide-react';
import { Field } from './ui';
import type { Unit } from '../domain/types';

export interface ConversionDraft {
  unit: string;
  factor: string;
}

const BUILT_IN_UNITS = new Set(['g', 'kg', 'ml', 'l', 'un']);

export function conversionDrafts(conversions: Record<string, number> | undefined): ConversionDraft[] {
  return Object.entries(conversions ?? {})
    .filter(([unit]) => !BUILT_IN_UNITS.has(unit.toLowerCase()))
    .map(([unit, factor]) => ({ unit, factor: String(factor) }));
}

export function parseConversionDrafts(drafts: ConversionDraft[]): Record<string, number> | null {
  if (drafts.length > 20) return null;
  const entries: [string, number][] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const unit = draft.unit.trim().toLowerCase();
    const factor = Number(draft.factor.replace(',', '.'));
    if (!unit || BUILT_IN_UNITS.has(unit) || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,31}$/u.test(unit)
      || !Number.isFinite(factor) || factor <= 0 || factor >= 1_000_000 || seen.has(unit)) return null;
    seen.add(unit);
    entries.push([unit, factor]);
  }
  return Object.fromEntries(entries);
}

export function ConversionEditor({ baseUnit, value, onChange }: {
  baseUnit: Unit;
  value: ConversionDraft[];
  onChange: (drafts: ConversionDraft[]) => void;
}) {
  return (
    <section className="space-y-2 border border-line bg-[#0b0b0a] p-3">
      <div>
        <div className="text-[11px] font-medium text-cream">Unidades de embalagem</div>
        <p className="mt-1 text-[10px] leading-relaxed text-dim">
          Opcional. Informe quantas unidades-base há em cada embalagem. Ex.: 1 caixa = 12 un; 1 fardo = 6 L.
        </p>
      </div>
      {value.map((draft, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Field label="Nome" htmlFor={`conversion-name-${index}`}>
            <input id={`conversion-name-${index}`} className="input h-8 text-[11px]" value={draft.unit}
              placeholder="caixa" maxLength={32}
              onChange={(event) => onChange(value.map((entry, i) => i === index ? { ...entry, unit: event.target.value } : entry))} />
          </Field>
          <Field label={`Equivale a (${baseUnit})`} htmlFor={`conversion-factor-${index}`}>
            <input id={`conversion-factor-${index}`} className="input num h-8 text-[11px]" inputMode="decimal"
              value={draft.factor} placeholder="12"
              onChange={(event) => onChange(value.map((entry, i) => i === index ? { ...entry, factor: event.target.value } : entry))} />
          </Field>
          <button type="button" className="btn btn-ghost h-8 px-2" aria-label="Remover conversão"
            onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" disabled={value.length >= 20}
        onClick={() => onChange([...value, { unit: '', factor: '' }])}>
        <Plus size={12} /> Adicionar embalagem
      </button>
    </section>
  );
}

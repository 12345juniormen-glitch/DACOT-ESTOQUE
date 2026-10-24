import type { Cents, Unit } from './types';

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const decimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function money(cents: Cents): string {
  return brl.format(cents / 100);
}

export function moneySigned(cents: Cents): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return sign + brl.format(Math.abs(cents) / 100);
}

export function qty(value: number, unit?: Unit): string {
  return unit ? `${decimal.format(value)} ${unit}` : decimal.format(value);
}

export function decimalRaw(value: number): string {
  return decimal.format(value);
}

export function parseQty(raw: string): number {
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function moneyInput(cents: Cents): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

export function parseMoney(raw: string): Cents {
  const normalized = raw.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'America/Sao_Paulo',
});

const shortDateFmt = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
});

const timeFmt = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Sao_Paulo',
});

const monthFmt = new Intl.DateTimeFormat('pt-BR', {
  month: 'short',
  timeZone: 'America/Sao_Paulo',
});

const weekdayFmt = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short',
  timeZone: 'America/Sao_Paulo',
});

export function date(iso: string): string {
  return dateFmt.format(new Date(iso));
}

export function shortDate(iso: string): string {
  return shortDateFmt.format(new Date(iso));
}

export function time(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function dateTime(iso: string): string {
  return `${dateFmt.format(new Date(iso))} ${timeFmt.format(new Date(iso))}`;
}

export function monthShort(iso: string): string {
  return monthFmt.format(new Date(iso)).replace('.', '').toUpperCase();
}

export function weekday(iso: string): string {
  return weekdayFmt.format(new Date(iso)).replace('.', '');
}

export function monthLabel(reference: Date): string {
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(reference);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

export function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Converte unidades de mesma dimensão (g↔kg, ml↔L). Sem conversão cruzada. */
export function convertQty(value: number, from: Unit, to: Unit): number {
  if (from === to) return value;
  const factors: Record<Unit, number | null> = {
    kg: 1,
    g: 1000,
    L: 1,
    ml: 1000,
    un: null,
  };
  const fFrom = factors[from];
  const fTo = factors[to];
  if (fFrom == null || fTo == null) return value;
  if ((from === 'kg' || from === 'g') !== (to === 'kg' || to === 'g')) return value;
  return (value / fFrom) * fTo;
}

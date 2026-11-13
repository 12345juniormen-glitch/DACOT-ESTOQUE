import type { Cents, Unit } from './types';

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const decimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

export function money(cents: Cents): string {
  return brl.format(cents / 100);
}

export function moneySigned(cents: Cents): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return sign + brl.format(Math.abs(cents) / 100);
}

/** Round a signed base-unit variance to cents using half-away-from-zero at 0.001-unit precision. */
export function roundCentsFromMilliUnits(quantity: number, unitCostCents: number): Cents {
  const quantityMilli = Math.round(quantity * 1000);
  const numerator = quantityMilli * unitCostCents;
  return Math.sign(numerator) * Math.floor((Math.abs(numerator) + 500) / 1000);
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

/** Strict non-negative quantity parser for physical counts, where invalid text must never become zero. */
export function parseCountQty(raw: string): number | null {
  const normalized = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Strict quantity parser for stock fields persisted at 0.001-unit precision. */
export function parseStockQty(raw: string): number | null {
  const value = parseCountQty(raw);
  if (value == null) return null;
  const scaled = value * 1000;
  return Number.isFinite(scaled) && Math.abs(scaled - Math.round(scaled)) <= 1e-8 ? value : null;
}

export function moneyInput(cents: Cents): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

export function parseMoneyInput(raw: string): Cents | null {
  let input = raw.replace(/[^\d,.-]/g, '');
  if (!input || !/^-?\d*(?:[.,]\d*)*$/.test(input) || (input.match(/-/g)?.length ?? 0) > 1
      || (input.includes('-') && !input.startsWith('-'))) return null;
  const negative = input.startsWith('-');
  if (negative) input = input.slice(1);

  const commas = [...input.matchAll(/,/g)].map((match) => match.index ?? 0);
  const dots = [...input.matchAll(/\./g)].map((match) => match.index ?? 0);
  let integerPart: string;
  let fractionalPart = '';
  if (commas.length && dots.length) {
    const decimalIndex = Math.max(commas.at(-1)!, dots.at(-1)!);
    integerPart = input.slice(0, decimalIndex).replace(/[.,]/g, '');
    fractionalPart = input.slice(decimalIndex + 1).replace(/[.,]/g, '');
  } else {
    const separator = commas.length ? ',' : dots.length ? '.' : null;
    if (separator === null) {
      integerPart = input;
    } else {
      const positions = separator === ',' ? commas : dots;
      const lastIndex = positions.at(-1)!;
      const tail = input.slice(lastIndex + 1);
      const thousandsDots = separator === '.' && positions.length === 1
        && tail.length === 3 && input.slice(0, lastIndex).length >= 1
        && input.slice(0, lastIndex).length <= 3;
      const repeatedThousands = positions.length > 1
        && input.split(separator).slice(1).every((part) => part.length === 3);
      if (thousandsDots || repeatedThousands) {
        integerPart = input.replaceAll(separator, '');
      } else {
        integerPart = input.slice(0, lastIndex).replaceAll(separator, '');
        fractionalPart = tail;
      }
    }
  }

  if (!integerPart) integerPart = '0';
  if (!/^\d+$/.test(integerPart) || (fractionalPart && !/^\d+$/.test(fractionalPart))) return null;
  const fraction = `${fractionalPart}00`;
  let cents = BigInt(integerPart) * 100n + BigInt(fraction.slice(0, 2));
  if (fraction[2] >= '5') cents += 1n;
  if (negative) cents = -cents;
  const value = Number(cents);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseMoney(raw: string): Cents {
  return parseMoneyInput(raw) ?? 0;
}

export function parseOptionalNonNegativeMoney(raw: string): { cents: Cents; known: boolean } | null {
  if (!raw.trim()) return { cents: 0, known: false };
  const cents = parseMoneyInput(raw);
  if (cents == null || cents < 0) return null;
  return { cents, known: true };
}

/** Use the suggested value only for a blank field; an explicit zero remains zero. */
export function parseMoneyOrFallback(raw: string | undefined, fallbackCents: Cents): Cents {
  return raw?.trim() ? parseMoney(raw) : fallbackCents;
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

/** Converte unidades padrão ou a embalagem explicitamente cadastrada no ingrediente. */
export function convertQty(
  value: number,
  from: Unit,
  to: Unit,
  baseUnit?: Unit,
  conversions: Record<string, number> = {},
): number {
  const normalizedFrom = from.trim().toLowerCase();
  const normalizedTo = to.trim().toLowerCase();
  const normalizedBase = baseUnit?.trim().toLowerCase();
  if (normalizedFrom === normalizedTo) return value;
  if (normalizedBase) {
    const factors = Object.fromEntries(
      Object.entries(conversions).map(([unit, factor]) => [unit.trim().toLowerCase(), factor]),
    );
    const fromFactor = factors[normalizedFrom];
    const toFactor = factors[normalizedTo];
    if (normalizedTo === normalizedBase && Number.isFinite(fromFactor) && fromFactor > 0) {
      return value * fromFactor;
    }
    if (normalizedFrom === normalizedBase && Number.isFinite(toFactor) && toFactor > 0) {
      return value / toFactor;
    }
    if (Number.isFinite(fromFactor) && fromFactor > 0 && Number.isFinite(toFactor) && toFactor > 0) {
      return (value * fromFactor) / toFactor;
    }
  }
  const factors: Partial<Record<Unit, number | null>> = {
    kg: 1,
    g: 1000,
    L: 1,
    ml: 1000,
    un: null,
  };
  const fFrom = factors[normalizedFrom];
  const fTo = factors[normalizedTo];
  if (fFrom == null || fTo == null) return value;
  if ((normalizedFrom === 'kg' || normalizedFrom === 'g') !== (normalizedTo === 'kg' || normalizedTo === 'g')) return value;
  return (value / fFrom) * fTo;
}

export function compatibleIngredientUnits(baseUnit: Unit, conversions: Record<string, number> = {}): Unit[] {
  const base = baseUnit.trim().toLowerCase();
  const standard = base === 'kg' || base === 'g' ? ['kg', 'g']
    : base === 'l' || base === 'ml' ? ['L', 'ml'] : [baseUnit];
  return [...standard, ...Object.keys(conversions)];
}

type DecimalRatio = { numerator: bigint; denominator: bigint };

function decimalRatio(value: number): DecimalRatio | null {
  if (!Number.isFinite(value)) return null;
  const text = value.toString().toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText ? Number(exponentText) : 0;
  const [whole, fraction = ''] = coefficient.split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  const digits = `${whole.replace('-', '')}${fraction}`;
  const scale = fraction.length - exponent;
  const integer = sign * BigInt(digits || '0');
  return scale >= 0
    ? { numerator: integer, denominator: 10n ** BigInt(scale) }
    : { numerator: integer * 10n ** BigInt(-scale), denominator: 1n };
}

function unitFactorToBase(unit: Unit, baseUnit: Unit, conversions: Record<string, number>): DecimalRatio | null {
  const normalizedUnit = unit.trim().toLowerCase();
  const normalizedBase = baseUnit.trim().toLowerCase();
  if (normalizedUnit === normalizedBase) return { numerator: 1n, denominator: 1n };
  const custom = Object.entries(conversions).find(([name]) => name.trim().toLowerCase() === normalizedUnit)?.[1];
  if (custom != null && custom > 0) return decimalRatio(custom);
  const builtIn: Record<string, number> = {
    'kg:g': 0.001, 'g:kg': 1000,
    'l:ml': 0.001, 'ml:l': 1000,
  };
  const factor = builtIn[`${normalizedBase}:${normalizedUnit}`];
  return factor == null ? null : decimalRatio(factor);
}

/** Returns how many base units are represented by one unit of the selected measure. */
export function quantityFactorToBase(unit: Unit, baseUnit: Unit, conversions: Record<string, number> = {}): number | null {
  const ratio = unitFactorToBase(unit, baseUnit, conversions);
  if (!ratio) return null;
  const factor = Number(ratio.numerator) / Number(ratio.denominator);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

/** Calculates a recipe line in whole cents using decimal ratios and half-up rounding. */
export function ingredientLineCostCents(
  quantity: number,
  unit: Unit,
  baseUnit: Unit,
  unitCostCents: number,
  conversions: Record<string, number> = {},
  conversionOverride?: number,
): number {
  const quantityRatio = decimalRatio(quantity);
  const factor = conversionOverride == null
    ? unitFactorToBase(unit, baseUnit, conversions)
    : decimalRatio(conversionOverride);
  if (factor && factor.numerator <= 0n) return 0;
  if (!quantityRatio || !factor || !Number.isSafeInteger(unitCostCents)) {
    return Math.round(convertQty(quantity, unit, baseUnit, baseUnit, conversions) * unitCostCents);
  }
  const numerator = quantityRatio.numerator * factor.numerator * BigInt(unitCostCents);
  const denominator = quantityRatio.denominator * factor.denominator;
  if (numerator < 0n) {
    const magnitude = -numerator;
    const rounded = (magnitude * 2n + denominator) / (2n * denominator);
    return Number(-rounded);
  }
  return Number((numerator * 2n + denominator) / (2n * denominator));
}

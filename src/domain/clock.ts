/** Relógio fixo da demonstração (base visual). Em produção vem da API. */
export const NOW_ISO = '2026-10-23T19:40:00-03:00';
export const NOW = new Date(NOW_ISO);
export const DAY_MS = 86_400_000;

export function startOfMonth(reference: Date = NOW): Date {
  return new Date(reference.getFullYear(), reference.getMonth(), 1, 0, 0, 0, 0);
}

export function daysAgoISO(days: number, hour = 12, minute = 0): string {
  const d = new Date(NOW.getTime() - days * DAY_MS);
  d.setHours(hour, minute, 0, 0);
  const sign = '-03:00';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:${pad(minute)}:00${sign}`;
}

export function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

export function isThisMonth(iso: string, reference: Date = NOW): boolean {
  const d = new Date(iso);
  return d.getFullYear() === reference.getFullYear() && d.getMonth() === reference.getMonth();
}

export function isWithinDays(iso: string, days: number, reference: Date = NOW): boolean {
  return new Date(iso).getTime() >= reference.getTime() - days * DAY_MS;
}

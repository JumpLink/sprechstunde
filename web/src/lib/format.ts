export const ms = (value: number | null | undefined): string => (value == null ? '–' : `${Math.round(value)} ms`);

export function when(iso: string, language: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(language, { dateStyle: 'short', timeStyle: 'medium' });
}

export const optional = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());

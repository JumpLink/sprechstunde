const STORAGE_KEY = 'sprechstunde.theme';

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

let dark = $state(false);

function apply(): void {
  document.documentElement.classList.toggle('dark', dark);
}

export const isDark = (): boolean => dark;

export function initTheme(): void {
  const stored = localStorage.getItem(STORAGE_KEY);
  dark = stored ? stored === 'dark' : systemDark();
  apply();
}

export function toggleTheme(): void {
  dark = !dark;
  localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
  apply();
}

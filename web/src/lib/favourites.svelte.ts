const STORAGE_KEY = 'sprechstunde.favourite-voices';

function load(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

// Kept in this browser for now; with per-user accounts (ADR 0001, step 3) they move to the database.
const keys = $state<string[]>(load());

export const favourites = {
  get keys(): ReadonlySet<string> {
    return new Set(keys);
  },
  has: (key: string): boolean => keys.includes(key),
  toggle(key: string): void {
    const at = keys.indexOf(key);
    if (at >= 0) keys.splice(at, 1);
    else keys.push(key);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
    } catch {
      // Private mode or a full quota: the favourite lasts until the page closes.
    }
  },
};

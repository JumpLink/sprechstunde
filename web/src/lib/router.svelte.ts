/** A path router in forty lines: five pages, no params. The server answers every page path with index.html. */

let path = $state(location.pathname);

export const currentPath = (): string => path;

/** A page with unsaved work sets this; it returns true when leaving is fine. */
let guard: (() => boolean) | undefined;
export const setGuard = (next: (() => boolean) | undefined): void => {
  guard = next;
};
window.addEventListener('beforeunload', (event) => {
  if (guard && !guard()) event.preventDefault();
});

export function navigate(to: string): void {
  if (to === path || (guard && !guard())) return;
  history.pushState({}, '', to);
  path = to;
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => {
  if (guard && !guard()) {
    history.pushState({}, '', path);
    return;
  }
  path = location.pathname;
});

/** Same-origin link clicks stay in the app. */
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const anchor = (event.target as Element | null)?.closest('a');
  if (!anchor || anchor.target || anchor.origin !== location.origin || anchor.hasAttribute('download')) return;
  event.preventDefault();
  navigate(anchor.pathname);
});

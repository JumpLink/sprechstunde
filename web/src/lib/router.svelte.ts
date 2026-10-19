/** A path router in forty lines: five pages, no params. The server answers every page path with index.html. */

let path = $state(location.pathname);

export const currentPath = (): string => path;

export function navigate(to: string): void {
  if (to === path) return;
  history.pushState({}, '', to);
  path = to;
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => {
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

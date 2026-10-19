<script lang="ts">
  import { Languages, Moon, Sun } from '@lucide/svelte';
  import { Toaster } from 'svelte-sonner';
  import { _, currentLanguage, setLanguage } from '$lib/i18n.svelte';
  import { navItems } from '$lib/nav';
  import { currentPath } from '$lib/router.svelte';
  import { app } from '$lib/store.svelte';
  import { isDark, toggleTheme } from '$lib/theme.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Calls from './pages/Calls.svelte';
  import Knowledge from './pages/Knowledge.svelte';
  import Llm from './pages/Llm.svelte';
  import Overview from './pages/Overview.svelte';
  import Voices from './pages/Voices.svelte';

  const items = $derived(navItems());
  const path = $derived(currentPath().replace(/(.)\/+$/, '$1'));
  const current = $derived(items.find((item) => item.path === path));

  const active = (itemPath: string): boolean => itemPath === (current?.path ?? '/');
  const linkClass = (itemPath: string): string =>
    active(itemPath) ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground';
</script>

<div class="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
  <aside class="sticky top-0 hidden h-screen flex-col border-r bg-card p-4 md:flex">
    <div class="mb-6 px-2 text-lg font-semibold tracking-tight">Sprechstunde</div>
    <nav class="flex flex-col gap-1" aria-label={_('Main navigation')}>
      {#each items as item (item.path)}
        <a
          href={item.path}
          aria-current={active(item.path) ? 'page' : undefined}
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors {linkClass(item.path)}"
        >
          <item.icon class="size-4" />
          {item.label}
        </a>
      {/each}
    </nav>
  </aside>

  <div class="flex min-w-0 flex-col pb-20 md:pb-0">
    <header class="sticky top-0 z-20 flex items-center justify-between gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur sm:px-6">
      <h1 class="truncate text-lg font-semibold">{current?.label ?? _('Not found')}</h1>
      <div class="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={_('Switch language')}
          onclick={() => setLanguage(currentLanguage() === 'de' ? 'en' : 'de')}
        >
          <Languages class="size-4" />
          {currentLanguage() === 'de' ? 'DE' : 'EN'}
        </Button>
        <Button variant="ghost" size="icon" aria-label={_('Switch between light and dark')} onclick={toggleTheme}>
          {#if isDark()}<Sun class="size-4" />{:else}<Moon class="size-4" />{/if}
        </Button>
      </div>
    </header>

    <main class="mx-auto w-full max-w-5xl flex-1 space-y-4 p-4 sm:p-6">
      {#if app.error}
        <div role="alert" class="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {app.error}
        </div>
      {/if}
      {#if app.state?.settingsError}
        <div role="alert" class="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {app.state.settingsError}
        </div>
      {/if}
      {#if !current}
        <p class="text-muted-foreground">{_('There is no such page.')}</p>
      {:else if current.path === '/'}
        <Overview />
      {:else if current.path === '/voices'}
        <Voices />
      {:else if current.path === '/llm'}
        <Llm />
      {:else if current.path === '/knowledge'}
        <Knowledge />
      {:else}
        <Calls />
      {/if}
    </main>
  </div>

  <nav
    class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card md:hidden"
    aria-label={_('Main navigation')}
  >
    {#each items as item (item.path)}
      <a
        href={item.path}
        aria-current={active(item.path) ? 'page' : undefined}
        class="flex flex-col items-center gap-1 px-1 py-2 text-[0.7rem] font-medium {linkClass(item.path)}"
      >
        <item.icon class="size-5" />
        <span class="max-w-full truncate">{item.label}</span>
      </a>
    {/each}
  </nav>
</div>

<Toaster richColors position="top-center" theme={isDark() ? 'dark' : 'light'} />

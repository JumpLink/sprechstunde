<script lang="ts">
  import { RefreshCw, Search, SlidersHorizontal, X } from '@lucide/svelte';
  import { Dialog, Tabs } from 'bits-ui';
  import { onDestroy, untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { sampleUrl } from '$lib/api';
  import {
    activeCount,
    emptyFilters,
    type Context,
    type Facet,
    type Filters,
    filtered,
    recommend,
    type Tab,
  } from '$lib/browse';
  import { type Candidate, specKey, specOf } from '$lib/casting';
  import { favourites } from '$lib/favourites.svelte';
  import { _, fill } from '$lib/i18n.svelte';
  import { app } from '$lib/store.svelte';
  import type { Gender } from '$lib/types';
  import Button from '$lib/ui/Button.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { controlClass } from '$lib/utils';
  import FilterPanel from './FilterPanel.svelte';
  import VoiceRow from './VoiceRow.svelte';
  import VoiceTile from './VoiceTile.svelte';

  interface Props {
    candidates: Candidate[];
    loading: boolean;
    /** Preset for the gender filter; the person can change it. */
    gender?: Gender;
    /** Facets to leave out of the filter panel. */
    hide?: Facet[];
    selected: Candidate[];
    heard: Record<string, { busy?: boolean; ttfaMs?: number; error?: string }>;
    onpick: (candidate: Candidate) => void;
    onhear: (candidate: Candidate) => void;
    /** Called before a vendor sample starts, so a greeting does not play over it. */
    onstop: () => void;
    actionLabel: string;
    actionDisabled?: boolean;
    onaction: () => void;
  }

  let { candidates, loading, gender, hide, selected, heard, onpick, onhear, onstop, actionLabel, actionDisabled = false, onaction }: Props =
    $props();

  const PAGE = 30;
  const RECOMMENDED = 4;

  const key = (candidate: Candidate): string => specKey(specOf(candidate));

  function initialFilters(): Filters {
    const filters = emptyFilters();
    // Neutral is no filter: any voice may be cast as a neutral character.
    if (gender && gender !== 'neutral') filters.facets.gender = new Set([gender]);
    return filters;
  }

  let filters = $state<Filters>(untrack(initialFilters));
  let shown = $state(PAGE);
  let round = $state(0);
  let sheet = $state(false);
  let wide = $state(false);
  let sampling = $state('');
  let audio: HTMLAudioElement | undefined;
  const seen = new Set<string>();

  $effect(() => {
    const query = matchMedia('(min-width: 1024px)');
    const update = (): void => {
      wide = query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  const context = $derived<Context>({ kugelEu: app.state?.kugelEu ?? false, favourites: favourites.keys });
  const list = $derived(filtered(candidates, filters, context));
  // Kugel reports every voice of this account as private, so "own" only tells something where it sets some voices apart.
  const anyOwn = $derived(candidates.some((candidate) => candidate.own) && candidates.some((candidate) => !candidate.own));
  const showRecommended = $derived(filters.tab === 'all' && filters.search.trim() === '' && list.length > RECOMMENDED);
  const recommended = $derived.by(() => {
    void round;
    return showRecommended ? recommend(list, RECOMMENDED, seen) : [];
  });
  const tabs = $derived<Array<{ value: Tab; title: string }>>([
    { value: 'all', title: _('All') },
    ...(anyOwn ? [{ value: 'own' as const, title: _('Own voices') }] : []),
    { value: 'favourites', title: fill(_('Favourites (%s)'), favourites.keys.size) },
  ]);
  const filterCount = $derived(activeCount(filters));

  function change(next: Partial<Filters>): void {
    filters = { ...filters, ...next };
    shown = PAGE;
    round = 0;
    seen.clear();
  }

  function toggle(facet: Facet, value: string): void {
    const set = new Set(filters.facets[facet]);
    if (!set.delete(value)) set.add(value);
    change({ facets: { ...filters.facets, [facet]: set } });
  }

  const reset = (): void => change({ facets: emptyFilters().facets, eu: false, local: false });

  function stopSample(): void {
    audio?.pause();
    audio = undefined;
    sampling = '';
  }

  onDestroy(stopSample);

  function sample(candidate: Candidate): void {
    const id = key(candidate);
    const wasPlaying = sampling === id;
    stopSample();
    if (wasPlaying) return;
    onstop();
    const player = new Audio(sampleUrl(candidate.provider, candidate.voice, candidate.model));
    audio = player;
    sampling = id;
    const done = (): void => {
      if (audio === player) stopSample();
    };
    player.onended = done;
    player.onerror = () => {
      done();
      toast.error(_('The vendor sample could not be played'));
    };
    player.play().catch(done);
  }

  function hear(candidate: Candidate): void {
    stopSample();
    onhear(candidate);
  }

  const isSelected = (candidate: Candidate): boolean => selected.some((entry) => key(entry) === key(candidate));
  const rowProps = (candidate: Candidate) => ({
    candidate,
    selected: isSelected(candidate),
    favourite: favourites.has(key(candidate)),
    sampling: sampling === key(candidate),
    heard: heard[key(candidate)],
    onsample: () => sample(candidate),
    onhear: () => hear(candidate),
    onfavourite: () => favourites.toggle(key(candidate)),
    onselect: () => onpick(candidate),
  });
</script>

{#snippet panel()}
  <FilterPanel {candidates} {hide} {filters} {context} ontoggle={toggle} onflag={(flag) => change({ [flag]: !filters[flag] })} onreset={reset} />
{/snippet}

<div class="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start lg:gap-6">
  {#if wide}
    <aside class="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border bg-card p-4" aria-label={_('Filter')}>
      {@render panel()}
    </aside>
  {/if}

  <div class="min-w-0 space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <Tabs.Root value={filters.tab} onValueChange={(value) => change({ tab: value as Tab })}>
        <Tabs.List class="inline-flex rounded-lg bg-muted p-1" aria-label={_('Which voices')}>
          {#each tabs as { value, title } (value)}
            <Tabs.Trigger
              {value}
              class="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs"
            >
              {title}
            </Tabs.Trigger>
          {/each}
        </Tabs.List>
      </Tabs.Root>
      <p class="ml-auto text-sm text-muted-foreground" aria-live="polite">{fill(_('%s voices'), list.length)}</p>
    </div>

    <div class="flex gap-2">
      <div class="relative min-w-0 flex-1">
        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          class="{controlClass} pl-9"
          value={filters.search}
          oninput={(event) => change({ search: event.currentTarget.value })}
          placeholder={_('Search by name or description')}
          aria-label={_('Search by name or description')}
        />
      </div>
      {#if !wide}
        <Button variant="outline" onclick={() => (sheet = true)}>
          <SlidersHorizontal class="size-4" />{_('Filter')}{#if filterCount > 0}<span class="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{filterCount}</span>{/if}
        </Button>
      {/if}
    </div>

    {#if loading && candidates.length === 0}
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {#each [1, 2, 3, 4] as n (n)}<Skeleton class="h-48" />{/each}
      </div>
    {:else if candidates.length === 0}
      <Empty title={_('No voices')}>{_('No vendor offers a voice right now. Check the API keys.')}</Empty>
    {:else}
      {#if showRecommended}
        <section aria-labelledby="recommended-title" class="space-y-3">
          <div class="flex items-center justify-between gap-2">
            <h3 id="recommended-title" class="text-sm font-semibold">{_('Recommended')}</h3>
            <Button variant="ghost" size="sm" onclick={() => (round += 1)}><RefreshCw class="size-4" />{_('Other voices')}</Button>
          </div>
          <ul class="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {#each recommended as candidate (key(candidate))}
              <VoiceTile {...rowProps(candidate)} />
            {/each}
          </ul>
        </section>
      {/if}

      {#if list.length === 0}
        <Empty title={filters.tab === 'favourites' ? _('No favourites yet') : _('No voice matches')}>
          {filters.tab === 'favourites' ? _('Tap the heart on a voice to keep it here.') : _('Loosen the filters.')}
        </Empty>
      {:else}
        <ul class="space-y-2">
          {#each list.slice(0, shown) as candidate (key(candidate))}
            <VoiceRow {...rowProps(candidate)} />
          {/each}
        </ul>
        {#if list.length > shown}
          <div class="flex justify-center">
            <Button variant="outline" onclick={() => (shown += PAGE)}>{fill(_('Load more (%s left)'), list.length - shown)}</Button>
          </div>
        {/if}
      {/if}
    {/if}

    {#if selected.length > 0}
      <div class="sticky bottom-16 z-10 lg:bottom-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3 shadow-lg" role="region" aria-label={_('Selection')}>
        <p class="min-w-0 text-sm" aria-live="polite">
          <span class="font-medium">{fill(_('%s selected'), selected.length)}</span>
          <span class="text-muted-foreground"> · {selected.map((entry) => entry.name).join(', ')}</span>
        </p>
        <Button disabled={actionDisabled} onclick={onaction}>{actionLabel}</Button>
      </div>
    {/if}
  </div>
</div>

{#if !wide}
  <Dialog.Root bind:open={sheet}>
    <Dialog.Portal>
      <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
      <Dialog.Content class="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border bg-card p-4 shadow-lg">
        <div class="mb-4 flex items-center justify-between">
          <Dialog.Title class="text-base font-semibold">{_('Filter')}</Dialog.Title>
          <Dialog.Close class="rounded-md p-2 hover:bg-muted" aria-label={_('Close')}><X class="size-4" /></Dialog.Close>
        </div>
        <Dialog.Description class="sr-only">{_('Narrow the voices down')}</Dialog.Description>
        {@render panel()}
        <Button class="mt-4 w-full" onclick={() => (sheet = false)}>{fill(_('Show %s voices'), list.length)}</Button>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{/if}

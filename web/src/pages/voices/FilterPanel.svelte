<script lang="ts">
  import { activeCount, type Context, type Facet, type Filters, hasEu, hasLocal, offered, options, UNKNOWN } from '$lib/browse';
  import type { Candidate } from '$lib/casting';
  import { _, currentLanguage } from '$lib/i18n.svelte';
  import Button from '$lib/ui/Button.svelte';
  import { cn } from '$lib/utils';
  import { vendorOf } from '$lib/vendor';
  import { genderLabel } from '$lib/voices';
  import { ageLabel } from './facts';
  import type { Gender } from '$lib/types';

  interface Props {
    candidates: Candidate[];
    filters: Filters;
    context: Context;
    ontoggle: (facet: Facet, value: string) => void;
    onflag: (flag: 'eu' | 'local') => void;
    onreset: () => void;
  }

  let { candidates, filters, context, ontoggle, onflag, onreset }: Props = $props();

  const titles = $derived<Record<Facet, string>>({
    vendor: _('Vendor'),
    language: _('Language'),
    gender: _('Gender'),
    age: _('Age'),
    category: _('Category'),
    quality: _('Quality'),
  });

  const shown = $derived((['vendor', 'language', 'gender', 'age', 'category', 'quality'] as Facet[]).filter((facet) => offered(candidates, facet)));

  function label(facet: Facet, value: string): string {
    if (facet === 'vendor') return vendorOf(value).name;
    if (facet === 'language') return new Intl.DisplayNames([currentLanguage()], { type: 'language' }).of(value) ?? value;
    if (facet === 'gender') return value === UNKNOWN ? _('Unknown') : genderLabel(value as Gender);
    if (facet === 'age') return ageLabel(value);
    return value;
  }
</script>

<div class="space-y-5">
  {#each shown as facet (facet)}
    <fieldset class="space-y-2">
      <legend class="mb-2 text-sm font-medium">{titles[facet]}</legend>
      <div class="flex flex-wrap gap-1.5">
        {#each options(candidates, filters, context, facet) as option (option.value)}
          {@const on = filters.facets[facet].has(option.value)}
          <button
            type="button"
            aria-pressed={on}
            class={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-muted',
              on ? 'border-primary bg-primary/10 font-medium' : 'bg-card',
              option.count === 0 && !on && 'opacity-50',
            )}
            onclick={() => ontoggle(facet, option.value)}
          >
            {label(facet, option.value)}
            <span class="text-muted-foreground">{option.count}</span>
          </button>
        {/each}
      </div>
    </fieldset>
  {/each}
  {#if hasEu(candidates, context) || hasLocal(candidates)}
    <fieldset class="space-y-2">
      <legend class="mb-2 text-sm font-medium">{_('Where it runs')}</legend>
      {#if hasEu(candidates, context)}
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" class="size-4 accent-primary" checked={filters.eu} onchange={() => onflag('eu')} />
          {_('EU endpoint only')}
        </label>
      {/if}
      {#if hasLocal(candidates)}
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" class="size-4 accent-primary" checked={filters.local} onchange={() => onflag('local')} />
          {_('Local only')}
        </label>
      {/if}
    </fieldset>
  {/if}
  <Button variant="outline" size="sm" class="w-full" disabled={activeCount(filters) === 0} onclick={onreset}>{_('Reset')}</Button>
</div>

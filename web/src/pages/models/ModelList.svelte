<script lang="ts">
  import { Search } from '@lucide/svelte';
  import { _, fill } from '$lib/i18n.svelte';
  import { catalogOf, ensureCatalogs, modelsInUse } from '$lib/models.svelte';
  import { app } from '$lib/store.svelte';
  import type { Catalog, CatalogModel } from '$lib/types';
  import Badge from '$lib/ui/Badge.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import ModelFacts from '$lib/ui/ModelFacts.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { controlClass } from '$lib/utils';

  let search = $state('');

  const targets = $derived(['llm', ...(app.state?.providers ?? [])]);
  const uses = $derived(app.state ? modelsInUse(app.state) : []);

  $effect(() => ensureCatalogs(targets));

  /** One group per real model: the canonical entry first, then the names that point at it. */
  function groupsOf(catalog: Catalog): CatalogModel[][] {
    const groups = new Map<string, CatalogModel[]>();
    for (const model of catalog.models) {
      const key = model.aliasOf ?? model.id;
      groups.set(key, [...(groups.get(key) ?? []), model]);
    }
    const needle = search.trim().toLowerCase();
    return [...groups.values()]
      .map((group) => group.toSorted((a, b) => Number(!!a.aliasOf) - Number(!!b.aliasOf)))
      .filter(
        (group) =>
          !needle ||
          group.some((model) => [model.id, model.label, model.description ?? ''].join(' ').toLowerCase().includes(needle)),
      );
  }

  const roles = (target: string, group: CatalogModel[]): Array<'primary' | 'fallback'> =>
    (['primary', 'fallback'] as const).filter((role) =>
      uses.some((use) => use.target === target && use.role === role && group.some((model) => model.id === use.id)),
    );
  const used = (target: string, id: string): boolean => uses.some((use) => use.target === target && use.id === id);
  const title = (target: string): string => (target === 'llm' ? _('Language models (Mistral)') : target);
</script>

<div class="relative">
  <Search class="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
  <input
    class="{controlClass} pl-9"
    type="search"
    bind:value={search}
    placeholder={_('Search models')}
    aria-label={_('Search models')}
  />
</div>

{#each targets as target (target)}
  {@const catalog = catalogOf(target)}
  <Card title={title(target)}>
    {#if !catalog}
      <Skeleton class="h-24" />
    {:else if !catalog.available}
      <p class="text-sm text-muted-foreground">{catalog.reason ?? _('This vendor cannot be asked right now.')}</p>
    {:else}
      {@const groups = groupsOf(catalog)}
      {#if groups.length === 0}
        <Empty title={_('No models found')} />
      {:else}
        <ul class="grid gap-3 sm:grid-cols-2">
          {#each groups as group (group[0]!.id)}
            {@const main = group[0]!}
            {@const names = group.slice(1)}
            <li class="min-w-0 space-y-2 rounded-lg border p-3">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 class="font-medium">{main.label}</h3>
                {#each roles(target, group) as role (role)}
                  <Badge tone={role === 'primary' ? 'success' : 'neutral'}>
                    {role === 'primary' ? _('In use') : _('Fallback')}
                  </Badge>
                {/each}
                {#if group.some((model) => model.deprecated)}<Badge tone="warning">{_('Deprecated')}</Badge>{/if}
                {#if names.length > 0}<Badge>{fill(_('Aliases: %s'), names.length)}</Badge>{/if}
              </div>
              <p class="text-xs break-all text-muted-foreground">{main.id}</p>
              <ModelFacts {target} model={main} clamp />
              {#if names.length > 0}
                <ul class="space-y-1 border-t pt-2 text-xs">
                  {#each names as model (model.id)}
                    <li class="break-words">
                      <code class={used(target, model.id) ? 'font-semibold text-foreground' : ''}>{model.id}</code>
                      {#if model.latest}<span class="text-muted-foreground">· {_('follows the newest version')}</span>{/if}
                      {#if model.deprecated}<span class="text-amber-700 dark:text-amber-300">· {_('deprecated')}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </Card>
{/each}

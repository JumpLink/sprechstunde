<script lang="ts">
  import { TriangleAlert } from '@lucide/svelte';
  import { currentLanguage, _, fill } from '$lib/i18n.svelte';
  import { findModel, perMillion, tokens } from '$lib/models.svelte';
  import type { CatalogModel } from '$lib/types';
  import Badge from './Badge.svelte';

  let { target, model, clamp = false }: { target: string; model: CatalogModel; clamp?: boolean } = $props();

  const date = (iso: string): string => new Date(iso).toLocaleDateString(currentLanguage());
  const resolved = $derived(model.aliasOf ? findModel(target, model.aliasOf) : undefined);
  const abilities = $derived(
    [
      [model.capabilities?.tools, _('Tools')],
      [model.capabilities?.vision, _('Images')],
      [model.capabilities?.reasoning, _('Reasoning')],
      [model.capabilities?.audioIn, _('Audio in')],
      [model.capabilities?.audioOut, _('Audio out')],
    ].filter(([on]) => on) as Array<[boolean, string]>,
  );
  const facts = $derived(
    [
      model.contextLength && fill(_('%s tokens of context'), tokens(model.contextLength)),
      model.maxOutput && fill(_('%s tokens of output'), tokens(model.maxOutput)),
      model.maxInput && fill(_('%s characters per request'), tokens(model.maxInput)),
      model.pricing?.prompt !== undefined && fill(_('%s per 1M input tokens'), perMillion(model.pricing.prompt)),
      model.pricing?.completion ? fill(_('%s per 1M output tokens'), perMillion(model.pricing.completion)) : false,
      model.created && fill(_('released %s'), date(model.created)),
    ].filter(Boolean) as string[],
  );
</script>

<div class="space-y-2 text-sm">
  {#if model.deprecated}
    <p class="flex items-start gap-2 text-amber-700 dark:text-amber-300" role="status">
      <TriangleAlert class="mt-0.5 size-4 shrink-0" />
      <span>
        {model.deprecatedAt ? fill(_('Deprecated (%s).'), date(model.deprecatedAt)) : _('Deprecated.')}
        {#if model.replacement}{fill(_('The vendor suggests %s instead.'), model.replacement)}{/if}
      </span>
    </p>
  {/if}
  {#if model.latest}
    <p class="text-muted-foreground">
      {_('Follows the newest version of this model.')}
      {#if resolved && resolved.id !== model.id}{fill(_('Currently %s.'), `${resolved.label} (${resolved.id})`)}{/if}
    </p>
  {:else if model.aliasOf && model.aliasOf !== model.id}
    <p class="text-muted-foreground">{fill(_('Another name for %s.'), model.aliasOf)}</p>
  {/if}
  {#if model.description}
    <p class={clamp ? 'line-clamp-3' : ''}>{model.description}</p>
  {/if}
  {#if abilities.length > 0}
    <div class="flex flex-wrap gap-1">
      {#each abilities as [, name] (name)}<Badge>{name}</Badge>{/each}
    </div>
  {/if}
  {#if facts.length > 0}
    <p class="text-xs text-muted-foreground">{facts.join(' · ')}</p>
  {/if}
</div>

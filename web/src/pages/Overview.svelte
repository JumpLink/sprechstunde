<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { ms } from '$lib/format';
  import { _, fill } from '$lib/i18n.svelte';
  import { ensureCatalogs, findModel, modelsInUse, DEFAULT_LLM } from '$lib/models.svelte';
  import { app } from '$lib/store.svelte';
  import type { Latency } from '$lib/types';
  import Badge from '$lib/ui/Badge.svelte';
  import Card from '$lib/ui/Card.svelte';
  import ChoiceLine from '$lib/ui/ChoiceLine.svelte';
  import VendorBadge from '$lib/ui/VendorBadge.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import ModelName from '$lib/ui/ModelName.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { resolveSlot } from '$lib/voices';

  let latency = $state<Latency>();

  onMount(async () => {
    try {
      latency = await api<Latency>('GET', '/api/latency');
    } catch {
      latency = { skipped: 0, characters: [], calls: [] };
    }
  });

  const snapshot = $derived(app.state);
  const profileName = $derived.by(() => {
    const profiles = app.profiles;
    if (!profiles) return '';
    const selected = profiles.profiles.find((entry) => entry.file === profiles.active);
    return selected ? (selected.name ?? selected.id) : (profiles.default?.name ?? profiles.default?.id ?? '');
  });
  const uses = $derived(snapshot ? modelsInUse(snapshot) : []);
  $effect(() => ensureCatalogs([...new Set(uses.map((use) => use.target))]));
  const outdated = $derived(
    uses.flatMap((use) => {
      const model = findModel(use.target, use.id);
      return model?.deprecated ? [{ use, model }] : [];
    }),
  );
  const recent = $derived(latency?.calls.slice(0, 10) ?? []);

  /** Median of the per-call medians: a number for "how fast are the last calls". */
  function typical(metric: string): number | null {
    const values = recent
      .map((call) => call.summary[metric]?.p50)
      .filter((value): value is number => typeof value === 'number')
      .sort((a, b) => a - b);
    return values.length ? (values[Math.floor(values.length / 2)] ?? null) : null;
  }

  const metrics = $derived([
    { name: 'tts.ttfbMs', label: _('Voice, first audio') },
    { name: 'llm.ttftMs', label: _('Model, first token') },
    { name: 'eou.endOfUtteranceDelayMs', label: _('End of speech detected') },
    { name: 'eou.transcriptionDelayMs', label: _('Transcription') },
  ]);
</script>

{#if !snapshot || !app.profiles}
  <div class="grid gap-4 sm:grid-cols-2">
    {#each [1, 2, 3, 4] as n (n)}<Skeleton class="h-32" />{/each}
  </div>
{:else}
  {@const primary = resolveSlot(snapshot, 'primary')}
  {@const fallback = resolveSlot(snapshot, 'fallback')}
  {#each outdated as { use, model } (use.target + use.id + use.role)}
    <div role="alert" class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
      {fill(_('%s is deprecated.'), model.label)}
      {#if model.replacement}{fill(_('The vendor suggests %s instead.'), model.replacement)}{/if}
      <a class="underline" href="/models">{_('Show models')}</a>
    </div>
  {/each}
  <div class="grid gap-4 sm:grid-cols-2">
    <Card title={_('Active profile')} description={_('What the assistant knows and says on the next call')}>
      <p class="text-lg font-medium">{profileName || _('Start profile')}</p>
      <p class="mt-1 text-sm text-muted-foreground">
        {app.profiles.active ? app.profiles.active : _('The profile the agent started with')}
      </p>
      <a class="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline" href="/knowledge">
        {_('Show knowledge and tools')}
      </a>
      <p class="mt-3 break-all text-xs text-muted-foreground">{_('Settings file')}: {snapshot.settingsPath}</p>
    </Card>

    <Card title={_('Default character')} description={_('Its voice, and the one that takes over when it fails')}>
      <dl class="space-y-3 text-sm">
        <div>
          <dt class="text-muted-foreground">{_('Voice')}</dt>
          <dd class="font-medium">{primary.label}</dd>
          <dd class="text-muted-foreground">
            {#if primary.choice}<ChoiceLine {...primary.choice} />{/if}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{_('Fallback')}</dt>
          <dd class="font-medium">{fallback.label}</dd>
          <dd class="text-muted-foreground">
            {#if fallback.choice}<ChoiceLine {...fallback.choice} />{/if}
          </dd>
        </div>
      </dl>
      <a class="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline" href="/characters">
        {_('Show characters')}
      </a>
    </Card>

    <Card title={_('Language model')} description={_('Answers first, the fallback after a timeout or error')}>
      <dl class="space-y-3 text-sm">
        <div>
          <dt class="text-muted-foreground">{_('Model')}</dt>
          <dd>
            <ModelName target="llm" id={snapshot.settings.llm.model ?? DEFAULT_LLM} />
            {#if !snapshot.settings.llm.model}<span class="text-xs text-muted-foreground">({_('default')})</span>{/if}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{_('Fallback')}</dt>
          <dd>
            {#if snapshot.settings.llm.fallbackModel}
              <ModelName target="llm" id={snapshot.settings.llm.fallbackModel} />
            {:else}
              <span class="font-medium">{_('None')}</span>
            {/if}
          </dd>
        </div>
      </dl>
      <a class="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline" href="/llm">
        {_('Change model')}
      </a>
    </Card>

    <Card title={_('Latest calls')} description={_('Median over the last ten calls')}>
      {#if !latency}
        <Skeleton class="h-24" />
      {:else if recent.length === 0}
        <Empty title={_('No calls measured yet')}>{_('Numbers appear after the first call.')}</Empty>
      {:else}
        <dl class="grid grid-cols-2 gap-3 text-sm">
          {#each metrics as metric (metric.name)}
            <div>
              <dt class="text-muted-foreground">{metric.label}</dt>
              <dd class="text-lg font-semibold tabular-nums">{ms(typical(metric.name))}</dd>
            </div>
          {/each}
        </dl>
        <p class="mt-3 text-xs text-muted-foreground">{fill(_('%s calls'), recent.length)}</p>
      {/if}
    </Card>
  </div>

  <Card title={_('API keys')} description={_('Which providers this server can call')}>
    <div class="flex flex-wrap gap-2">
      {#each Object.entries(snapshot?.keys) as [provider, present] (provider)}
        <span class="inline-flex items-center gap-1">
          <VendorBadge {provider} />
          <Badge tone={present ? 'success' : 'neutral'}>{present ? _('key set') : _('no key')}</Badge>
        </span>
      {/each}
    </div>
  </Card>
{/if}

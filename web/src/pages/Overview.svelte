<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { ms } from '$lib/format';
  import { _, fill } from '$lib/i18n.svelte';
  import { app } from '$lib/store.svelte';
  import type { Latency } from '$lib/types';
  import Badge from '$lib/ui/Badge.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { resolveSlot } from '$lib/voices';

  let latency = $state<Latency>();

  onMount(async () => {
    try {
      latency = await api<Latency>('GET', '/api/latency');
    } catch {
      latency = { skipped: 0, presets: [], calls: [] };
    }
  });

  const snapshot = $derived(app.state);
  const profileName = $derived.by(() => {
    const profiles = app.profiles;
    if (!profiles) return '';
    const selected = profiles.profiles.find((entry) => entry.file === profiles.active);
    return selected ? (selected.name ?? selected.id) : (profiles.default?.name ?? profiles.default?.id ?? '');
  });
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

    <Card title={_('Voice')} description={_('Primary voice and the one that takes over when it fails')}>
      <dl class="space-y-3 text-sm">
        <div>
          <dt class="text-muted-foreground">{_('Primary')}</dt>
          <dd class="font-medium">{primary.label}</dd>
          <dd class="break-words text-muted-foreground">{primary.detail}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{_('Fallback')}</dt>
          <dd class="font-medium">{fallback.label}</dd>
          <dd class="break-words text-muted-foreground">{fallback.detail}</dd>
        </div>
      </dl>
      <a class="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline" href="/voices">
        {_('Change voices')}
      </a>
    </Card>

    <Card title={_('Language model')} description={_('Answers first, the fallback after a timeout or error')}>
      <dl class="space-y-3 text-sm">
        <div>
          <dt class="text-muted-foreground">{_('Model')}</dt>
          <dd class="font-medium">{snapshot?.settings.llm.model ?? _('Default (mistral-small-latest)')}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{_('Fallback')}</dt>
          <dd class="font-medium">{snapshot?.settings.llm.fallbackModel ?? _('None')}</dd>
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
        <Badge tone={present ? 'success' : 'neutral'}>{provider}: {present ? _('key set') : _('no key')}</Badge>
      {/each}
    </div>
  </Card>
{/if}

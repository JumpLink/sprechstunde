<script lang="ts">
  import { onMount } from 'svelte';
  import { api, message } from '$lib/api';
  import { ms, when } from '$lib/format';
  import { _, currentLanguage, fill } from '$lib/i18n.svelte';
  import { app } from '$lib/store.svelte';
  import { characterName } from '$lib/voices';
  import type { Latency } from '$lib/types';
  import Card from '$lib/ui/Card.svelte';
  import ModelName from '$lib/ui/ModelName.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';

  let latency = $state<Latency>();
  let error = $state<string>();

  onMount(async () => {
    try {
      latency = await api<Latency>('GET', '/api/latency');
    } catch (cause) {
      error = message(cause);
    }
  });

  const names = $derived(app.state?.metricNames ?? []);
  const short = (name: string): string => name.replace('.', ' ').replace(/Ms$/, '');
  const th = 'px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground';
  const td = 'px-3 py-2 whitespace-nowrap tabular-nums';
</script>

{#if error}
  <p class="text-destructive" role="alert">{error}</p>
{:else if !latency}
  <Skeleton class="h-64" />
{:else if latency.calls.length === 0}
  <Empty title={_('No calls measured yet')}>{_('Numbers appear after the first call.')}</Empty>
{:else}
  <Card title={_('By character')} description={_('Median per metric in milliseconds')}>
    <div class="-mx-4 overflow-x-auto sm:-mx-5">
      <table class="w-full text-sm">
        <thead class="border-b">
          <tr>
            <th class={th}>{_('Character')}</th>
            <th class={th}>{_('Calls')}</th>
            {#each names as name (name)}<th class={th}>{short(name)}</th>{/each}
          </tr>
        </thead>
        <tbody class="divide-y">
          {#each latency.characters as row, index (index)}
            <tr>
              <td class="{td} font-medium">{row.character ? characterName(app.state, row.character) : (row.provider ?? '–')}</td>
              <td class={td}>{row.calls}</td>
              {#each names as name (name)}<td class={td}>{ms(row.summary[name]?.p50)}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  <Card title={_('Recent calls')} description={latency.skipped ? fill(_('%s unreadable lines were skipped'), latency.skipped) : undefined}>
    <div class="-mx-4 overflow-x-auto sm:-mx-5">
      <table class="w-full text-sm">
        <thead class="border-b">
          <tr>
            <th class={th}>{_('Start')}</th>
            <th class={th}>{_('Seconds')}</th>
            <th class={th}>{_('Character')}</th>
            <th class={th}>{_('Model')}</th>
            {#each names as name (name)}<th class={th}>{short(name)}</th>{/each}
          </tr>
        </thead>
        <tbody class="divide-y">
          {#each latency.calls as call, index (index)}
            <tr>
              <td class={td}>{when(call.start, currentLanguage())}</td>
              <td class={td}>{Math.round(call.seconds)}</td>
              <td class={td}>{call.character ? characterName(app.state, call.character) : (call.provider ?? '–')}</td>
              <td class={td}>{#if call.llmModel}<ModelName target="llm" id={call.llmModel} />{:else}–{/if}</td>
              {#each names as name (name)}<td class={td}>{ms(call.summary[name]?.p50)}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
{/if}

<script lang="ts">
  import { Check, ChevronDown, Copy } from '@lucide/svelte';
  import { Collapsible } from 'bits-ui';
  import { toast } from 'svelte-sonner';
  import { api, message } from '$lib/api';
  import { _, fill } from '$lib/i18n.svelte';
  import { app, reload } from '$lib/store.svelte';
  import type { Knowledge } from '$lib/types';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { controlClass } from '$lib/utils';

  let knowledge = $state<Knowledge>();
  let chosen = $state<string>();
  let search = $state('');
  let copied = $state(false);
  let promptOpen = $state(false);

  const profiles = $derived(app.profiles);

  async function load(file?: string): Promise<void> {
    try {
      knowledge = await api<Knowledge>('GET', file ? `/api/knowledge?file=${encodeURIComponent(file)}` : '/api/knowledge');
    } catch (error) {
      toast.error(message(error));
    }
  }

  $effect(() => {
    if (app.profiles && chosen === undefined) {
      chosen = app.profiles.active ?? '';
      void load(chosen || undefined);
    }
  });

  async function choose(file: string): Promise<void> {
    chosen = file;
    knowledge = undefined;
    await load(file || undefined);
  }

  async function activate(): Promise<void> {
    try {
      await api('PUT', '/api/profile', { file: chosen || null });
      await reload();
      toast.success(_('Profile saved'));
    } catch (error) {
      toast.error(message(error));
    }
  }

  async function copy(): Promise<void> {
    if (!knowledge) return;
    try {
      await navigator.clipboard.writeText(knowledge.systemPrompt);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      toast.error(_('Copying is not possible here'));
    }
  }

  const facts = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    return (knowledge?.facts ?? []).filter((fact) => !needle || `${fact.topic} ${fact.answer}`.toLowerCase().includes(needle));
  });
  const isActive = $derived((chosen ?? '') === (profiles?.active ?? ''));
</script>

<div class="space-y-4">
  <Card title={_('Profile')} description={_('Which venue profile the next call uses. The agent reads it per call.')}>
    {#if !profiles}
      <Skeleton class="h-10" />
    {:else}
      {#if profiles.error}<p class="mb-3 text-sm text-destructive" role="alert">{profiles.error}</p>{/if}
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-0 flex-1 space-y-1.5">
          <label class="text-sm font-medium" for="profile-pick">{_('Profile')}</label>
          <select id="profile-pick" class={controlClass} value={chosen ?? ''} onchange={(e) => choose(e.currentTarget.value)}>
            <option value="">
              {_('Start profile')}{profiles.default ? ` (${profiles.default.name ?? profiles.default.id})` : ''}
            </option>
            {#each profiles.profiles as entry (entry.file)}
              <option value={entry.file}>
                {entry.error ? fill(_('%s (broken)'), entry.file) : `${entry.name ?? entry.id} · ${entry.file}`}
              </option>
            {/each}
          </select>
        </div>
        <Button onclick={activate} disabled={isActive}>{isActive ? _('Active') : _('Use this profile')}</Button>
      </div>
    {/if}
  </Card>

  {#if !knowledge}
    <Skeleton class="h-48" />
    <Skeleton class="h-48" />
  {:else}
    <Card title={knowledge.profile.assistantName} description={fill(_('Language %s, time zone %s'), knowledge.profile.locale, knowledge.profile.timeZone)}>
      <dl class="space-y-4 text-sm">
        <div>
          <dt class="font-medium">{_('Greeting')}</dt>
          <dd class="mt-1 text-muted-foreground">{knowledge.greeting}</dd>
        </div>
        {#if knowledge.instructions}
          <div>
            <dt class="font-medium">{_('Instructions')}</dt>
            <dd class="mt-1 whitespace-pre-wrap text-muted-foreground">{knowledge.instructions}</dd>
          </div>
        {/if}
        {#if knowledge.fallback}
          <div>
            <dt class="font-medium">{_('Fallback text')}</dt>
            <dd class="mt-1 text-muted-foreground">{knowledge.fallback}</dd>
          </div>
        {/if}
      </dl>
    </Card>

    <Card title={_('Facts')} description={fill(_('%s facts the assistant can answer from'), knowledge.facts.length)}>
      <input type="search" class="{controlClass} mb-4" bind:value={search} placeholder={_('Search facts')} aria-label={_('Search facts')} />
      {#if facts.length === 0}
        <Empty title={_('No facts found')} />
      {:else}
        <ul class="grid gap-3 sm:grid-cols-2">
          {#each facts as fact, index (index)}
            <li class="rounded-lg border p-3">
              <p class="text-sm font-medium">{fact.topic}</p>
              <p class="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">{fact.answer}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <Card title={_('Tools')} description={_('What the assistant can do besides talking')}>
      {#if knowledge.tools.length === 0}
        <Empty title={_('No tools for this profile')} />
      {:else}
        <ul class="space-y-3">
          {#each knowledge.tools as tool (tool.name)}
            <li class="rounded-lg border p-3">
              <p class="flex flex-wrap items-center gap-2">
                <code class="font-mono text-sm font-semibold">{tool.name}</code>
                <Badge>{tool.availableWhen}</Badge>
              </p>
              <p class="mt-1 text-sm text-muted-foreground">{tool.description}</p>
              {#if Object.keys(tool.parameters.properties).length > 0}
                <ul class="mt-2 space-y-1 text-sm">
                  {#each Object.entries(tool.parameters.properties) as [param, schema] (param)}
                    <li>
                      <code class="font-mono">{param}</code>
                      {#if tool.parameters.required.includes(param)}<Badge tone="warning">{_('required')}</Badge>{/if}
                      <span class="text-muted-foreground">{(schema as { description?: string }).description ?? ''}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if knowledge.transfer}
        <dl class="mt-4 space-y-2 border-t pt-4 text-sm">
          <div>
            <dt class="font-medium">{_('Announcement before transferring')}</dt>
            <dd class="mt-1 text-muted-foreground">{knowledge.transfer.announce}</dd>
          </div>
          <div>
            <dt class="font-medium">{_('Transfer target')}</dt>
            <dd class="mt-1 font-mono text-muted-foreground">{knowledge.transfer.targetMasked}</dd>
          </div>
        </dl>
      {/if}
    </Card>

    <Card title={_('System prompt')} description={_('Exactly what the model receives')}>
      <Collapsible.Root bind:open={promptOpen}>
        <div class="flex flex-wrap gap-2">
          <Collapsible.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="outline" size="sm">
                <ChevronDown class="size-4 transition-transform {promptOpen ? 'rotate-180' : ''}" />
                {promptOpen ? _('Hide') : _('Show')}
              </Button>
            {/snippet}
          </Collapsible.Trigger>
          <Button variant="outline" size="sm" onclick={copy}>
            {#if copied}<Check class="size-4" />{_('Copied')}{:else}<Copy class="size-4" />{_('Copy')}{/if}
          </Button>
        </div>
        <Collapsible.Content>
          <pre class="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{knowledge.systemPrompt}</pre>
        </Collapsible.Content>
      </Collapsible.Root>
    </Card>
  {/if}
</div>

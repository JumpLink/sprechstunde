<script lang="ts">
  import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, History, Plus, Trash2 } from '@lucide/svelte';
  import { Collapsible, Dialog } from 'bits-ui';
  import { onDestroy } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { ApiError, api, message } from '$lib/api';
  import { when } from '$lib/format';
  import { _, currentLanguage, fill } from '$lib/i18n.svelte';
  import { setGuard } from '$lib/router.svelte';
  import { app, reload } from '$lib/store.svelte';
  import type { Draft, HistoryVersion, Knowledge } from '$lib/types';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Confirm from '$lib/ui/Confirm.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import Field from '$lib/ui/Field.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { controlClass } from '$lib/utils';

  let knowledge = $state<Knowledge>();
  let chosen = $state<string>();
  let search = $state('');
  let copied = $state(false);
  let promptOpen = $state(false);

  let draft = $state<Draft>();
  let target = $state('');
  let saved = $state('');
  let saving = $state(false);
  let draftPrompt = $state<string>();
  let conflict = $state(false);
  let historyOpen = $state(false);
  let versions = $state<HistoryVersion[]>();
  let copyName = $state('');
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const profiles = $derived(app.profiles);
  const defaultName = $derived(
    app.state?.settings.characters.find((entry) => entry.id === app.state?.settings.defaultCharacter)?.name ?? _('none'),
  );
  const editable = $derived(Boolean(knowledge?.editable && draft));
  const snapshot = (): string => JSON.stringify({ draft, target });
  const dirty = $derived(editable && snapshot() !== saved);

  setGuard(() => !dirty || confirm(_('You have unsaved changes. Leave and discard them?')));
  onDestroy(() => {
    setGuard(undefined);
    clearTimeout(previewTimer);
  });

  function adopt(next: Knowledge): void {
    knowledge = next;
    draft = next.draft ? structuredClone($state.snapshot(next.draft)) : undefined;
    target = '';
    saved = snapshot();
    draftPrompt = undefined;
  }

  async function load(file?: string): Promise<void> {
    try {
      adopt(await api<Knowledge>('GET', file ? `/api/knowledge?file=${encodeURIComponent(file)}` : '/api/knowledge'));
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
    if (dirty && !confirm(_('You have unsaved changes. Leave and discard them?'))) {
      return;
    }
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
      await navigator.clipboard.writeText(draftPrompt ?? knowledge.systemPrompt);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      toast.error(_('Copying is not possible here'));
    }
  }

  const body = (): { revision?: string; draft: unknown } => ({
    revision: knowledge?.revision,
    draft: { ...$state.snapshot(draft), ...(target.trim() && { transferTarget: target.trim() }) },
  });

  async function save(): Promise<void> {
    if (!knowledge?.file || saving) return;
    saving = true;
    try {
      await api('PUT', `/api/profiles/${encodeURIComponent(knowledge.file)}`, body());
      toast.success(_('Profile saved'));
      await Promise.all([load(knowledge.file), reload()]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) conflict = true;
      else toast.error(message(error));
    } finally {
      saving = false;
    }
  }

  function discard(): void {
    if (knowledge) adopt(knowledge);
  }

  // The prompt a call would get from the edited draft, nothing written.
  $effect(() => {
    if (!dirty || !knowledge?.file) {
      draftPrompt = undefined;
      return;
    }
    const payload = { file: knowledge.file, draft: body().draft };
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try {
        draftPrompt = (await api<{ systemPrompt: string }>('POST', '/api/knowledge/preview', payload)).systemPrompt;
      } catch {
        draftPrompt = undefined; // an invalid draft has no prompt; Save explains why
      }
    }, 400);
  });

  async function duplicate(): Promise<void> {
    const name = copyName.trim().endsWith('.json') ? copyName.trim() : `${copyName.trim()}.json`;
    try {
      await api('POST', '/api/profiles', { from: knowledge?.file ?? null, file: name });
      await reload();
      toast.success(_('Profile created'));
      copyName = '';
      chosen = name;
      knowledge = undefined;
      await load(name);
    } catch (error) {
      toast.error(message(error));
    }
  }

  async function openHistory(): Promise<void> {
    if (!knowledge?.file) return;
    historyOpen = true;
    versions = undefined;
    try {
      versions = (await api<{ versions: HistoryVersion[] }>('GET', `/api/profiles/${encodeURIComponent(knowledge.file)}/history`)).versions;
    } catch (error) {
      toast.error(message(error));
    }
  }

  async function restore(version: string): Promise<void> {
    if (!knowledge?.file) return;
    if (dirty && !confirm(_('You have unsaved changes. Leave and discard them?'))) return;
    try {
      await api('POST', `/api/profiles/${encodeURIComponent(knowledge.file)}/restore`, {
        version,
        revision: knowledge.revision,
      });
      historyOpen = false;
      toast.success(_('Version restored'));
      await Promise.all([load(knowledge.file), reload()]);
    } catch (error) {
      toast.error(message(error));
    }
  }

  function move(index: number, by: number): void {
    if (!draft) return;
    const to = index + by;
    if (to < 0 || to >= draft.facts.length) return;
    const [fact] = draft.facts.splice(index, 1);
    draft.facts.splice(to, 0, fact!);
  }

  const shownFacts = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    const list = (editable ? draft?.facts : knowledge?.facts) ?? [];
    return list.map((fact, index) => ({ fact, index })).filter(({ fact }) => !needle || `${fact.topic} ${fact.answer}`.toLowerCase().includes(needle));
  });
  const isActive = $derived((chosen ?? '') === (profiles?.active ?? ''));
  const promptText = $derived(draftPrompt ?? knowledge?.systemPrompt ?? '');
</script>

<div class="space-y-4 {dirty ? 'pb-20' : ''}">
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
        <Button onclick={activate} disabled={isActive || dirty}>{isActive ? _('Active') : _('Use this profile')}</Button>
        {#if editable}
          <Button variant="outline" onclick={openHistory}><History class="size-4" />{_('History')}</Button>
        {/if}
      </div>
    {/if}
  </Card>

  {#if !knowledge}
    <Skeleton class="h-48" />
    <Skeleton class="h-48" />
  {:else}
    {#if !knowledge.editable}
      <Card title={_('Read-only')} description={_('This profile is not in the profiles directory, so it cannot be changed here. Make an editable copy to work on it.')}>
        <form
          class="flex flex-wrap items-end gap-3"
          onsubmit={(e) => {
            e.preventDefault();
            void duplicate();
          }}
        >
          <div class="min-w-0 flex-1">
            <Field label={_('Name of the copy')} for="copy-name" hint={_('A file name such as my-venue.json')}>
              <input id="copy-name" class={controlClass} bind:value={copyName} placeholder="my-venue.json" required />
            </Field>
          </div>
          <Button type="submit" disabled={!copyName.trim()}>{_('Duplicate into profiles directory')}</Button>
        </form>
      </Card>
    {/if}

    {#if editable && draft}
      <Card title={draft.assistantName || _('Profile')} description={fill(_('Language %s, time zone %s'), knowledge.profile.locale, knowledge.profile.timeZone)}>
        <div class="space-y-4">
          <Field label={_('Name of the assistant')} for="k-name">
            <input id="k-name" class={controlClass} bind:value={draft.assistantName} />
          </Field>
          <Field
            label={_('Character')}
            for="k-character"
            hint={_('Its voice, name and manner replace the name above on calls.')}
          >
            <select
              id="k-character"
              class={controlClass}
              value={draft.character ?? ''}
              onchange={(e) => draft && (draft.character = e.currentTarget.value === '' ? null : e.currentTarget.value)}
            >
              <option value="">{fill(_('Default character (%s)'), defaultName)}</option>
              {#each app.state?.settings.characters ?? [] as option (option.id)}
                <option value={option.id}>{option.name}</option>
              {/each}
            </select>
          </Field>
          <Field label={_('Greeting')} for="k-greeting" hint={_('Must say that the caller talks to an AI (EU AI Act, Art. 50). It cannot be empty.')}>
            <textarea id="k-greeting" class="{controlClass} min-h-20" bind:value={draft.greeting}></textarea>
          </Field>
          <Field label={_('Instructions')} for="k-instructions">
            <textarea id="k-instructions" class="{controlClass} min-h-40" bind:value={draft.instructions}></textarea>
          </Field>
          <Field label={_('Fallback text')} for="k-fallback" hint={_('Spoken when the assistant cannot answer. Leave empty for none.')}>
            <textarea
              id="k-fallback"
              class="{controlClass} min-h-16"
              value={draft.fallback ?? ''}
              oninput={(e) => draft && (draft.fallback = e.currentTarget.value === '' ? null : e.currentTarget.value)}
            ></textarea>
          </Field>
        </div>
      </Card>
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
    {/if}

    <Card title={_('Facts')} description={fill(_('%s facts the assistant can answer from'), (editable ? draft?.facts : knowledge.facts)?.length ?? 0)}>
      {#snippet actions()}
        {#if editable && draft}
          <Button size="sm" variant="outline" onclick={() => draft?.facts.push({ topic: '', answer: '' })}>
            <Plus class="size-4" />{_('Add fact')}
          </Button>
        {/if}
      {/snippet}
      <input type="search" class="{controlClass} mb-4" bind:value={search} placeholder={_('Search facts')} aria-label={_('Search facts')} />
      {#if shownFacts.length === 0}
        <Empty title={_('No facts found')} />
      {:else if editable && draft}
        <ul class="space-y-3">
          {#each shownFacts as { index } (index)}
            <li class="rounded-lg border p-3">
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1 space-y-2">
                  <input class={controlClass} bind:value={draft.facts[index]!.topic} placeholder={_('Topic')} aria-label={_('Topic')} />
                  <textarea
                    class="{controlClass} min-h-16"
                    bind:value={draft.facts[index]!.answer}
                    placeholder={_('Answer')}
                    aria-label={_('Answer')}
                  ></textarea>
                </div>
                <div class="flex shrink-0 flex-col gap-1">
                  <Button size="icon" variant="ghost" aria-label={_('Move up')} disabled={index === 0 || search !== ''} onclick={() => move(index, -1)}>
                    <ArrowUp class="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={_('Move down')}
                    disabled={index === draft.facts.length - 1 || search !== ''}
                    onclick={() => move(index, 1)}
                  >
                    <ArrowDown class="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={_('Delete fact')} onclick={() => draft?.facts.splice(index, 1)}>
                    <Trash2 class="size-4" />
                  </Button>
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <ul class="grid gap-3 sm:grid-cols-2">
          {#each shownFacts as { fact, index } (index)}
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
      {#if editable && draft}
        <div class="mt-4 space-y-4 border-t pt-4">
          <label class="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={draft.transfer !== null}
              onchange={(e) => {
                if (!draft) return;
                draft.transfer = e.currentTarget.checked ? { announce: '', targetMasked: knowledge?.draft?.transfer?.targetMasked ?? '' } : null;
              }}
            />
            {_('Transfer calls to a person')}
          </label>
          {#if draft.transfer}
            <Field label={_('Announcement before transferring')} for="k-announce">
              <textarea id="k-announce" class="{controlClass} min-h-16" bind:value={draft.transfer.announce}></textarea>
            </Field>
            <Field
              label={_('Transfer target')}
              for="k-target"
              hint={draft.transfer.targetMasked
                ? fill(_('Now: %s. The number is never shown in full. Enter a new one to replace it, or leave empty to keep it.'), draft.transfer.targetMasked)
                : _('A phone number, tel:+… or sip:user@host')}
            >
              <input id="k-target" class={controlClass} bind:value={target} autocomplete="off" placeholder="+49 …" />
            </Field>
          {/if}
        </div>
      {:else if knowledge.transfer}
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

    <Card
      title={_('System prompt')}
      description={draftPrompt ? _('What the model would receive with your unsaved changes') : _('Exactly what the model receives')}
    >
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
          <pre class="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{promptText}</pre>
        </Collapsible.Content>
      </Collapsible.Root>
    </Card>
  {/if}
</div>

{#if dirty}
  <div class="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 p-3 backdrop-blur" role="region" aria-label={_('Unsaved changes')}>
    <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
      <Badge tone="warning">{_('Unsaved changes')}</Badge>
      <div class="flex gap-2">
        <Button variant="outline" onclick={discard} disabled={saving}>{_('Discard')}</Button>
        <Button onclick={save} disabled={saving}>{_('Save')}</Button>
      </div>
    </div>
  </div>
{/if}

<Confirm
  bind:open={conflict}
  title={_('The profile changed')}
  description={_('Someone changed this profile after you opened it. Reload to see the current version; your edits here are lost.')}
  confirmLabel={_('Reload')}
  onconfirm={() => knowledge?.file && load(knowledge.file)}
/>

<Dialog.Root bind:open={historyOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
    <Dialog.Content class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col gap-4 border-l bg-card p-5 shadow-lg">
      <Dialog.Title class="text-base font-semibold">{_('History')}</Dialog.Title>
      <Dialog.Description class="text-sm text-muted-foreground">{_('The last 20 versions of this profile. Restoring keeps the current one in the history.')}</Dialog.Description>
      <div class="min-h-0 flex-1 overflow-auto">
        {#if !versions}
          <Skeleton class="h-24" />
        {:else if versions.length === 0}
          <Empty title={_('No earlier versions yet')} />
        {:else}
          <ul class="space-y-2">
            {#each versions as entry (entry.version)}
              <li class="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <span>{when(entry.at, currentLanguage())}<span class="block text-xs text-muted-foreground">{fill(_('%s bytes'), entry.size)}</span></span>
                <Button size="sm" variant="outline" onclick={() => restore(entry.version)}>{_('Restore')}</Button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="outline">{_('Close')}</Button>
        {/snippet}
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

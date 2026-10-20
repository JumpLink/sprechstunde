<script lang="ts">
  import { AlertTriangle, Check, FileText, Globe, History, Network, Plus, RefreshCw, Trash2, X } from '@lucide/svelte';
  import { Dialog } from 'bits-ui';
  import { toast } from 'svelte-sonner';
  import { ApiError, api, message } from '$lib/api';
  import { when } from '$lib/format';
  import { _, currentLanguage, fill } from '$lib/i18n.svelte';
  import { app } from '$lib/store.svelte';
  import type { KnowledgeSource, RefreshSummary, SourceKind, SourceRevision, SourceSection } from '$lib/types';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Confirm from '$lib/ui/Confirm.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import Field from '$lib/ui/Field.svelte';
  import Markdown from '$lib/ui/Markdown.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { controlClass } from '$lib/utils';

  const icons = { manual: FileText, web: Globe, sitemap: Network };
  const kindLabel = (kind: SourceKind): string =>
    kind === 'manual' ? _('Text') : kind === 'web' ? _('Web page') : _('Sitemap');

  let venue = $state('');
  let sources = $state<KnowledgeSource[]>();
  let openId = $state<string>();
  let sections = $state<SourceSection[]>();
  let published = $state<{ text: string; stale: boolean }>();
  let busy = $state<string>();
  let drafts = $state<Record<string, string>>({});
  let previewing = $state<Record<string, boolean>>({});
  let history = $state<{ title: string; items: SourceRevision[] }>();
  let removing = $state<KnowledgeSource>();
  let removeOpen = $state(false);

  let adding = $state(false);
  let kind = $state<SourceKind>('web');
  let title = $state('');
  let url = $state('');
  let text = $state('');
  let globs = $state('');
  let hours = $state('24');
  let auto = $state(false);

  const venues = $derived((app.profiles?.profiles ?? []).filter((entry) => !entry.error));
  const open = $derived(sources?.find((entry) => entry.id === openId));
  const language = $derived(currentLanguage());

  $effect(() => {
    if (venues.length > 0 && !venues.some((entry) => entry.file === venue)) {
      venue = venues.find((entry) => entry.file === app.profiles?.active)?.file ?? venues[0]!.file;
    }
  });
  $effect(() => {
    if (venue) void loadAll(venue);
  });

  const q = (value: string): string => encodeURIComponent(value);

  async function loadList(): Promise<void> {
    sources = await api<KnowledgeSource[]>('GET', `/api/knowledge/sources?venue=${q(venue)}`);
    published = await api<{ text: string; stale: boolean }>('GET', `/api/knowledge/published?venue=${q(venue)}`);
  }
  async function loadOpen(): Promise<void> {
    if (!openId) return void (sections = undefined);
    sections = (await api<{ sections: SourceSection[] }>('GET', `/api/knowledge/sources/${openId}`)).sections;
    drafts = {};
    previewing = {};
  }
  async function loadAll(file: string): Promise<void> {
    sources = undefined;
    openId = undefined;
    sections = undefined;
    try {
      await loadList();
    } catch (error) {
      if (file === venue) toast.error(message(error));
    }
  }
  async function refreshView(): Promise<void> {
    await Promise.all([loadList(), loadOpen()]);
  }

  async function run(label: string, job: () => Promise<void>): Promise<void> {
    busy = label;
    try {
      await job();
    } catch (error) {
      toast.error(message(error));
      if (error instanceof ApiError && error.status === 409) await refreshView().catch(() => undefined);
    } finally {
      busy = undefined;
    }
  }

  async function choose(id: string): Promise<void> {
    openId = openId === id ? undefined : id;
    await run('open', loadOpen);
  }

  const fetchNow = (source: KnowledgeSource): Promise<void> =>
    run(`fetch-${source.id}`, async () => {
      const summary = await api<RefreshSummary>('POST', `/api/knowledge/sources/${source.id}/refresh`, {});
      if (summary.error && summary.pages === 0) toast.error(summary.error);
      else if (summary.pending > 0) toast.success(fill(_('%s changes wait for your review'), summary.pending));
      else toast.success(_('Nothing new'));
      await refreshView();
    });

  const decide = (revision: SourceRevision, what: 'approve' | 'reject'): Promise<void> =>
    run(what, async () => {
      await api('POST', `/api/knowledge/revisions/${revision.id}/${what}`, {});
      toast.success(what === 'approve' ? _('Change accepted') : _('Change discarded'));
      await refreshView();
    });

  const saveEdit = (section: SourceSection): Promise<void> =>
    run('edit', async () => {
      await api('PUT', `/api/knowledge/sections/${section.id}`, {
        markdown: drafts[section.id],
        title: section.title,
        baseRevisionId: section.liveRevisionId,
      });
      toast.success(_('Saved'));
      await refreshView();
    });

  async function showHistory(section: SourceSection): Promise<void> {
    await run('history', async () => {
      const items = await api<SourceRevision[]>('GET', `/api/knowledge/sections/${section.id}/history`);
      history = { title: section.title, items };
    });
  }

  const patch = (source: KnowledgeSource, body: Record<string, unknown>): Promise<void> =>
    run('patch', async () => {
      await api('PUT', `/api/knowledge/sources/${source.id}`, body);
      await loadList();
    });

  function startAdd(): void {
    kind = 'web';
    title = url = text = globs = '';
    hours = '24';
    auto = false;
    adding = true;
  }

  const create = (): Promise<void> =>
    run('add', async () => {
      const made = await api<KnowledgeSource>('POST', '/api/knowledge/sources', {
        venue,
        kind,
        title,
        ...(kind === 'manual' ? { markdown: text } : { url, refreshHours: hours === '' ? null : Number(hours), autoApprove: auto }),
        ...(kind === 'sitemap' && { includeGlobs: globs.split('\n').map((line) => line.trim()).filter(Boolean) }),
      });
      adding = false;
      await loadList();
      if (kind !== 'manual') await fetchNow(made);
      openId = made.id;
      await loadOpen();
    });

  const remove = (): Promise<void> =>
    run('remove', async () => {
      if (!removing) return;
      await api('DELETE', `/api/knowledge/sources/${removing.id}`);
      if (openId === removing.id) openId = undefined;
      await refreshView();
      toast.success(_('Source removed'));
    });

  const status = (source: KnowledgeSource): { tone: 'neutral' | 'success' | 'warning' | 'danger'; label: string } =>
    source.lastError
      ? { tone: 'danger', label: _('Fetch failed') }
      : source.kind !== 'manual' && !source.lastCheckedAt
        ? { tone: 'neutral', label: _('Not fetched yet') }
        : source.pendingCount > 0
        ? { tone: 'warning', label: fill(_('%s to review'), source.pendingCount) }
        : { tone: 'success', label: _('Up to date') };

  const diffClass = { same: 'text-muted-foreground', add: 'bg-success/15', del: 'bg-destructive/15 line-through' };
  const diffMark = { same: ' ', add: '+', del: '−' };
</script>

<div class="space-y-4">
  <Card title={_('Venue')} description={_('Sources belong to one venue. The assistant of that venue answers from them.')}>
    {#if !app.profiles}
      <Skeleton class="h-10" />
    {:else if venues.length === 0}
      <Empty title={_('No venue profile found')} />
    {:else}
      <select class={controlClass} bind:value={venue} aria-label={_('Venue')}>
        {#each venues as entry (entry.file)}
          <option value={entry.file}>{entry.name ?? entry.id} · {entry.file}</option>
        {/each}
      </select>
    {/if}
  </Card>

  {#if venue}
    <Card title={_('Sources')} description={_('Web pages are fetched, then you decide what goes live. Your own text is live at once.')}>
      {#snippet actions()}
        <Button size="sm" onclick={startAdd}><Plus class="size-4" />{_('Add source')}</Button>
      {/snippet}
      {#if !sources}
        <Skeleton class="h-24" />
      {:else if sources.length === 0}
        <Empty title={_('No sources yet')}>{_('Add a web page, a sitemap or your own text.')}</Empty>
      {:else}
        <ul class="divide-y">
          {#each sources as source (source.id)}
            {@const Icon = icons[source.kind]}
            {@const state = status(source)}
            <li class="py-3">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Icon class="size-5 shrink-0 text-muted-foreground" aria-label={kindLabel(source.kind)} />
                <button
                  type="button"
                  class="min-w-40 flex-1 text-left"
                  aria-expanded={openId === source.id}
                  onclick={() => choose(source.id)}
                >
                  <span class="block truncate font-medium">{source.title}</span>
                  <span class="block truncate text-xs text-muted-foreground">
                    {source.lastFetchedAt ? fill(_('Fetched %s'), when(source.lastFetchedAt, language)) : source.kind === 'manual' ? kindLabel('manual') : _('Not fetched yet')}
                  </span>
                </button>
                <Badge tone={state.tone}>{state.label}</Badge>
                {#if source.kind !== 'manual'}
                  <Button size="sm" variant="outline" disabled={busy !== undefined} onclick={() => fetchNow(source)}>
                    <RefreshCw class="size-4 {busy === `fetch-${source.id}` ? 'animate-spin' : ''}" />{_('Fetch now')}
                  </Button>
                {/if}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={_('Remove source')}
                  onclick={() => {
                    removing = source;
                    removeOpen = true;
                  }}><Trash2 class="size-4" /></Button
                >
              </div>
              {#if source.url}
                <a href={source.url} target="_blank" rel="noopener noreferrer" class="mt-1 block truncate pl-8 text-xs text-primary underline">{source.url}</a>
              {/if}
              {#if source.lastError}
                <p class="mt-1 pl-8 text-xs text-destructive" role="alert">{source.lastError}</p>
              {/if}

              {#if openId === source.id}
                <div class="mt-3 space-y-3 sm:pl-8">
                  {#if source.kind !== 'manual'}
                    <div class="flex flex-wrap items-end gap-4 rounded-lg border p-3">
                      <Field label={_('Fetch again every')} for="refresh-{source.id}">
                        <select
                          id="refresh-{source.id}"
                          class={controlClass}
                          value={source.refreshHours === null ? '' : String(source.refreshHours)}
                          onchange={(e) => patch(source, { refreshHours: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
                        >
                          <option value="">{_('Never')}</option>
                          <option value="6">{_('6 hours')}</option>
                          <option value="24">{_('Day')}</option>
                          <option value="168">{_('Week')}</option>
                        </select>
                      </Field>
                      <label class="flex items-center gap-2 pb-2 text-sm">
                        <input
                          type="checkbox"
                          checked={source.autoApprove}
                          onchange={(e) => patch(source, { autoApprove: e.currentTarget.checked })}
                        />
                        {_('Accept changes without asking')}
                      </label>
                    </div>
                  {/if}

                  {#if !sections}
                    <Skeleton class="h-24" />
                  {:else if sections.length === 0}
                    <Empty title={_('Nothing fetched yet')}>{_('Press "Fetch now".')}</Empty>
                  {/if}
                  {#each sections ?? [] as section (section.id)}
                    <div class="space-y-3 rounded-lg border p-3">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="min-w-0">
                          <p class="truncate font-medium">{section.title}</p>
                          {#if section.url && section.url !== source.url}
                            <a href={section.url} target="_blank" rel="noopener noreferrer" class="block truncate text-xs text-primary underline">{section.url}</a>
                          {/if}
                        </div>
                        <div class="flex items-center gap-1">
                          {#if section.gone}<Badge tone="warning">{_('No longer listed')}</Badge>{/if}
                          {#if section.live?.origin === 'edited'}<Badge>{_('Edited by hand')}</Badge>{/if}
                          <Button size="sm" variant="ghost" onclick={() => showHistory(section)}><History class="size-4" />{_('History')}</Button>
                        </div>
                      </div>

                      {#if section.pending && section.diff}
                        <div class="space-y-2 rounded-md border border-amber-500/40 p-2">
                          <p class="text-sm font-medium">{fill(_('The page changed: %s lines differ'), section.diffChanged)}</p>
                          {#if section.overwritesEdit}
                            <p class="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300" role="alert">
                              <AlertTriangle class="mt-0.5 size-4 shrink-0" />{_('Accepting replaces the text you edited by hand.')}
                            </p>
                          {/if}
                          <pre class="max-h-72 overflow-auto rounded-md bg-muted/50 p-2 text-xs"><code>{#each section.diff as line}<span class="block whitespace-pre-wrap break-words px-1 {diffClass[line.kind]}">{diffMark[line.kind]} {line.text}</span>{/each}</code></pre>
                          <div class="flex flex-wrap gap-2">
                            <Button size="sm" disabled={busy !== undefined} onclick={() => decide(section.pending!, 'approve')}><Check class="size-4" />{_('Accept')}</Button>
                            <Button size="sm" variant="outline" disabled={busy !== undefined} onclick={() => decide(section.pending!, 'reject')}><X class="size-4" />{_('Discard')}</Button>
                          </div>
                        </div>
                      {/if}

                      {#if section.live}
                        {@const draft = drafts[section.id]}
                        {#if draft === undefined || previewing[section.id]}
                          <div class="max-h-72 overflow-auto"><Markdown text={draft ?? section.live.markdown} /></div>
                        {:else}
                          <textarea
                            class="{controlClass} min-h-40 font-mono"
                            aria-label={_('Text')}
                            value={draft}
                            oninput={(e) => (drafts[section.id] = e.currentTarget.value)}
                          ></textarea>
                        {/if}
                        <div class="flex flex-wrap gap-2">
                          {#if draft === undefined}
                            <Button size="sm" variant="outline" onclick={() => (drafts[section.id] = section.live!.markdown)}>{_('Edit')}</Button>
                          {:else}
                            <Button size="sm" disabled={busy !== undefined || draft === section.live.markdown} onclick={() => saveEdit(section)}>{_('Save')}</Button>
                            <Button size="sm" variant="outline" onclick={() => (previewing[section.id] = !previewing[section.id])}>
                              {previewing[section.id] ? _('Edit') : _('Preview')}
                            </Button>
                            <Button size="sm" variant="ghost" onclick={() => { delete drafts[section.id]; delete previewing[section.id]; }}>{_('Cancel')}</Button>
                          {/if}
                        </div>
                      {:else if !section.pending}
                        <p class="text-sm text-muted-foreground">{_('Not live yet.')}</p>
                      {:else}
                        <p class="text-sm text-muted-foreground">{_('Not live yet: accept the change above to publish it.')}</p>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <Card title={_('What the bot knows')} description={_('Exactly the text the assistant gets from your sources, with where each part comes from.')}>
      {#if published?.stale}
        <p class="mb-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300" role="alert">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />{_('Publishing failed and is being retried. The bot still has the older text.')}
        </p>
      {/if}
      {#if published === undefined}
        <Skeleton class="h-24" />
      {:else if published.text === ''}
        <Empty title={_('Nothing yet')}>{_('Accepted sources show up here.')}</Empty>
      {:else}
        <pre class="max-h-96 overflow-auto rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap break-words">{published.text}</pre>
      {/if}
    </Card>
  {/if}
</div>

<Dialog.Root bind:open={adding}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
    <Dialog.Content class="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto rounded-xl border bg-card p-5 shadow-lg">
      <Dialog.Title class="text-base font-semibold">{_('Add source')}</Dialog.Title>
      <Dialog.Description class="text-sm text-muted-foreground">{_('Pages are fetched politely: the site\'s robots.txt is respected.')}</Dialog.Description>
      <form
        class="space-y-4"
        onsubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label={_('Kind')}>
          {#each ['web', 'sitemap', 'manual'] as const as option}
            {@const Icon = icons[option]}
            <button
              type="button"
              role="radio"
              aria-checked={kind === option}
              class="flex flex-col items-center gap-1 rounded-lg border p-3 text-sm {kind === option ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}"
              onclick={() => (kind = option)}
            >
              <Icon class="size-5" />{kindLabel(option)}
            </button>
          {/each}
        </div>
        <Field label={_('Title')} for="s-title">
          <input id="s-title" class={controlClass} bind:value={title} required maxlength="120" />
        </Field>
        {#if kind === 'manual'}
          <Field label={_('Text')} for="s-text" hint={_('Markdown works.')}>
            <textarea id="s-text" class="{controlClass} min-h-40" bind:value={text}></textarea>
          </Field>
        {:else}
          <Field label={kind === 'web' ? _('Web address') : _('Address of the sitemap')} for="s-url">
            <input id="s-url" type="url" class={controlClass} bind:value={url} required placeholder={kind === 'web' ? 'https://example.com/menu' : 'https://example.com/sitemap.xml'} />
          </Field>
          {#if kind === 'sitemap'}
            <Field label={_('Only these pages')} for="s-globs" hint={_('One pattern per line, such as /menu/**. Empty takes every page.')}>
              <textarea id="s-globs" class="{controlClass} min-h-20 font-mono" bind:value={globs}></textarea>
            </Field>
          {/if}
          <Field label={_('Fetch again every')} for="s-hours">
            <select id="s-hours" class={controlClass} bind:value={hours}>
              <option value="">{_('Never')}</option>
              <option value="6">{_('6 hours')}</option>
              <option value="24">{_('Day')}</option>
              <option value="168">{_('Week')}</option>
            </select>
          </Field>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={auto} />{_('Accept changes without asking')}
          </label>
        {/if}
        <div class="flex justify-end gap-2">
          <Dialog.Close>
            {#snippet child({ props })}<Button {...props} type="button" variant="outline">{_('Cancel')}</Button>{/snippet}
          </Dialog.Close>
          <Button type="submit" disabled={busy !== undefined || !title.trim() || (kind !== 'manual' && !url.trim())}>{_('Add')}</Button>
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<Dialog.Root open={history !== undefined} onOpenChange={(next) => !next && (history = undefined)}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
    <Dialog.Content class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col gap-4 border-l bg-card p-5 shadow-lg">
      <Dialog.Title class="text-base font-semibold">{_('History')}</Dialog.Title>
      <Dialog.Description class="text-sm text-muted-foreground">{history?.title}</Dialog.Description>
      <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {#each history?.items ?? [] as item (item.id)}
          <li class="rounded-lg border p-3 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <Badge tone={item.status === 'approved' ? 'success' : item.status === 'pending' ? 'warning' : 'neutral'}>
                {item.status === 'approved' ? _('Accepted') : item.status === 'pending' ? _('Waiting') : _('Discarded')}
              </Badge>
              <span>{item.origin === 'edited' ? _('Edited by hand') : _('Fetched')}</span>
            </div>
            <p class="mt-1 text-xs text-muted-foreground">{when(item.fetchedAt ?? item.createdAt, language)}{item.author ? ` · ${item.author}` : ''}</p>
          </li>
        {/each}
      </ul>
      <Dialog.Close>
        {#snippet child({ props })}<Button {...props} variant="outline">{_('Close')}</Button>{/snippet}
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<Confirm
  bind:open={removeOpen}
  title={_('Remove this source?')}
  description={_('Its fetched texts and their history are deleted, and the assistant stops using them.')}
  confirmLabel={_('Remove source')}
  onconfirm={remove}
/>

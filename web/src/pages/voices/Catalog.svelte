<script lang="ts">
  import { Play, Plus, RefreshCw } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { api, message, preview } from '$lib/api';
  import { when } from '$lib/format';
  import { _, currentLanguage, fill } from '$lib/i18n.svelte';
  import { app } from '$lib/store.svelte';
  import type { Catalog, CatalogVoice, Preset, Provider } from '$lib/types';
  import Audio from '$lib/ui/Audio.svelte';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { controlClass } from '$lib/utils';

  interface Props {
    onsave: (preset: Preset) => void;
  }

  let { onsave }: Props = $props();

  const PAGE = 24;

  let provider = $state<Provider>('mistral');
  let catalog = $state<Catalog>();
  let loading = $state(false);
  let model = $state('');
  let language = $state('');
  let gender = $state('');
  let search = $state('');
  let shown = $state(PAGE);
  let ownText = $state(app.state?.sampleText ?? '');
  let tested = $state<Record<string, { url?: string; ttfaMs?: number; error?: string; busy?: boolean }>>({});

  $effect(() => {
    if (!ownText && app.state) ownText = app.state.sampleText;
  });

  const providers = $derived(app.state?.providers ?? []);

  async function load(refresh = false): Promise<void> {
    loading = true;
    try {
      catalog = await api<Catalog>('GET', `/api/catalog/${provider}${refresh ? '?refresh=1' : ''}`);
      if (refresh) toast.success(_('Catalog refreshed'));
    } catch (error) {
      catalog = undefined;
      toast.error(message(error));
    } finally {
      loading = false;
    }
  }

  function pick(next: Provider): void {
    provider = next;
    model = language = gender = search = '';
    shown = PAGE;
    tested = {};
    void load();
  }

  $effect(() => {
    if (!catalog && !loading) void load();
  });

  const voices = $derived(catalog?.voices ?? []);
  const languages = $derived([...new Set(voices.flatMap((voice) => voice.languages))].sort());
  const genders = $derived([...new Set(voices.map((voice) => voice.gender).filter((g): g is string => Boolean(g)))].sort());
  const filtered = $derived(
    voices.filter((voice) => {
      if (model && voice.model && voice.model !== model) return false;
      if (language && !voice.languages.some((tag) => tag === language || tag.startsWith(`${language}-`))) return false;
      if (gender && voice.gender !== gender) return false;
      const needle = search.trim().toLowerCase();
      return !needle || `${voice.name} ${voice.id} ${voice.description ?? ''}`.toLowerCase().includes(needle);
    }),
  );

  const key = (voice: CatalogVoice): string => `${voice.model ?? ''}|${voice.id}`;

  async function test(voice: CatalogVoice): Promise<void> {
    const id = key(voice);
    tested[id] = { busy: true };
    try {
      const result = await preview(
        { voice: { provider, model: voice.model || model || undefined, voice: voice.id } },
        ownText,
        false,
      );
      tested[id] = result;
    } catch (error) {
      tested[id] = { error: message(error) };
    }
  }

  function save(voice: CatalogVoice): void {
    const id = `${provider}-${voice.id}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
    onsave({
      id,
      label: `${voice.name} (${provider})`,
      provider,
      model: voice.model || model || undefined,
      voice: voice.id,
    });
  }
</script>

<div class="space-y-4">
  <Card title={_('Voice catalog')} description={_('What each provider offers, with the vendor samples')}>
    {#snippet actions()}
      {#if catalog}<span class="text-xs text-muted-foreground">{fill(_('Fetched %s'), when(catalog.fetchedAt, currentLanguage()))}</span>{/if}
      <Button variant="outline" size="sm" disabled={loading} onclick={() => load(true)}>
        <RefreshCw class="size-4 {loading ? 'animate-spin' : ''}" />{_('Refresh')}
      </Button>
    {/snippet}

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="cat-provider">{_('Provider')}</label>
        <select id="cat-provider" class={controlClass} value={provider} onchange={(e) => pick(e.currentTarget.value as Provider)}>
          {#each providers as option (option)}<option value={option}>{option}</option>{/each}
        </select>
      </div>
      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="cat-model">{_('Model')}</label>
        <select id="cat-model" class={controlClass} bind:value={model} disabled={!catalog || catalog.models.length === 0}>
          <option value="">{_('All models')}</option>
          {#each catalog?.models ?? [] as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
        </select>
      </div>
      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="cat-language">{_('Language')}</label>
        <select id="cat-language" class={controlClass} bind:value={language}>
          <option value="">{_('Any language')}</option>
          {#each languages as option (option)}<option value={option}>{option}</option>{/each}
        </select>
      </div>
      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="cat-gender">{_('Gender')}</label>
        <select id="cat-gender" class={controlClass} bind:value={gender}>
          <option value="">{_('Any')}</option>
          {#each genders as option (option)}<option value={option}>{option}</option>{/each}
        </select>
      </div>
      <div class="space-y-1.5 sm:col-span-2 lg:col-span-4">
        <label class="text-sm font-medium" for="cat-search">{_('Search')}</label>
        <input id="cat-search" type="search" class={controlClass} bind:value={search} placeholder={_('Name, id or description')} />
      </div>
      <div class="space-y-1.5 sm:col-span-2 lg:col-span-4">
        <label class="text-sm font-medium" for="cat-text">{_('Test with your own text')}</label>
        <textarea id="cat-text" rows="2" class={controlClass} bind:value={ownText}></textarea>
      </div>
    </div>
  </Card>

  {#if loading && !catalog}
    <div class="grid gap-3 sm:grid-cols-2">
      {#each [1, 2, 3, 4] as n (n)}<Skeleton class="h-36" />{/each}
    </div>
  {:else if catalog && !catalog.available}
    <Empty title={_('This catalog is not available')}>
      {catalog.reason ?? _('The provider did not answer.')}
    </Empty>
  {:else if catalog && filtered.length === 0}
    <Empty title={_('No voice matches')}>{_('Loosen the filters.')}</Empty>
  {:else}
    <p class="text-sm text-muted-foreground" aria-live="polite">{fill(_('%s voices'), filtered.length)}</p>
    <ul class="grid gap-3 sm:grid-cols-2">
      {#each filtered.slice(0, shown) as voice (key(voice))}
        {@const result = tested[key(voice)]}
        <li class="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <div class="min-w-0">
            <p class="font-medium break-words">{voice.name}</p>
            <p class="text-xs break-all text-muted-foreground">{voice.id}{voice.model ? ` · ${voice.model}` : ''}</p>
          </div>
          <div class="flex flex-wrap gap-1">
            {#each voice.languages.slice(0, 6) as tag (tag)}<Badge>{tag}</Badge>{/each}
            {#if voice.gender}<Badge tone="neutral">{voice.gender}</Badge>{/if}
          </div>
          {#if voice.description}<p class="text-sm text-muted-foreground">{voice.description}</p>{/if}
          {#if voice.sampleUrl}
            <div>
              <p class="mb-1 text-xs text-muted-foreground">{_('Vendor sample')}</p>
              <Audio src={voice.sampleUrl} />
            </div>
          {/if}
          {#if result?.url}
            <div>
              <p class="mb-1 text-xs text-muted-foreground">{fill(_('Your text, first audio after %s ms'), result.ttfaMs ?? 0)}</p>
              <Audio src={result.url} />
            </div>
          {:else if result?.error}
            <p class="text-sm text-destructive" role="alert">{result.error}</p>
          {/if}
          <div class="mt-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={result?.busy} onclick={() => test(voice)}>
              <Play class="size-4" />{result?.busy ? _('Synthesizing…') : _('Test with my text')}
            </Button>
            <Button size="sm" onclick={() => save(voice)}><Plus class="size-4" />{_('Save as preset')}</Button>
          </div>
        </li>
      {/each}
    </ul>
    {#if filtered.length > shown}
      <div class="flex justify-center">
        <Button variant="outline" onclick={() => (shown += PAGE)}>{_('Show more')}</Button>
      </div>
    {/if}
  {/if}
</div>

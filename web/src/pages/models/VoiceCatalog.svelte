<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { message, preview, revoke } from '$lib/api';
  import { type Candidate, candidatesFrom, previewCache, specKey, specOf } from '$lib/casting';
  import { _ } from '$lib/i18n.svelte';
  import { catalogOf, ensureCatalogs, refreshCatalogs } from '$lib/models.svelte';
  import { app } from '$lib/store.svelte';
  import type { VoiceSpec } from '$lib/types';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import VendorBadge from '$lib/ui/VendorBadge.svelte';
  import { controlClass } from '$lib/utils';
  import VoiceBrowser from '../voices/VoiceBrowser.svelte';

  interface Props {
    onsave: (voice: VoiceSpec) => void;
  }

  let { onsave }: Props = $props();

  let ownText = $state('');
  let picked = $state<Candidate>();
  let heard = $state<Record<string, { busy?: boolean; ttfaMs?: number; error?: string }>>({});
  let refreshing = $state(false);
  const cache = previewCache();

  onDestroy(() => cache.clear());

  $effect(() => {
    if (!ownText && app.state) ownText = app.state.sampleText;
  });

  const providers = $derived((app.state?.providers ?? []).filter((provider) => app.state?.keys[provider] !== false));
  $effect(() => ensureCatalogs(providers));
  const catalogs = $derived(providers.map((provider) => catalogOf(provider)));
  const loading = $derived(catalogs.some((catalog) => !catalog));
  const candidates = $derived(candidatesFrom(catalogs, ''));
  const unavailable = $derived(catalogs.filter((catalog) => catalog && !catalog.available));

  async function hear(candidate: Candidate): Promise<void> {
    const key = specKey(specOf(candidate));
    cache.stop();
    heard[key] = { busy: true };
    try {
      const result = await preview({ voice: specOf(candidate) }, ownText, false);
      heard[key] = { ttfaMs: Math.round(result.ttfaMs) };
      await cache.play(result.url);
      revoke(result.url);
    } catch (error) {
      heard[key] = { error: message(error) };
    }
  }

  async function refresh(): Promise<void> {
    refreshing = true;
    try {
      await refreshCatalogs(providers);
      toast.success(_('Catalog refreshed'));
    } catch (error) {
      toast.error(message(error));
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="space-y-4">
  <Card title={_('Voice catalog')} description={_('What each provider offers, with the vendor samples')}>
    {#snippet actions()}
      <Button variant="outline" size="sm" disabled={refreshing} onclick={refresh}>
        <RefreshCw class="size-4 {refreshing ? 'animate-spin' : ''}" />{_('Refresh')}
      </Button>
    {/snippet}
    <div class="space-y-4">
      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="cat-text">{_('Test with your own text')}</label>
        <textarea id="cat-text" rows="2" class={controlClass} bind:value={ownText}></textarea>
      </div>
      {#each unavailable as catalog (catalog?.provider)}
        {#if catalog}
          <p class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <VendorBadge provider={catalog.provider} />{catalog.reason ?? _('The provider did not answer.')}
          </p>
        {/if}
      {/each}
      <VoiceBrowser
        {candidates}
        {loading}
        selected={picked ? [picked] : []}
        {heard}
        onpick={(candidate) => (picked = picked && specKey(specOf(picked)) === specKey(specOf(candidate)) ? undefined : candidate)}
        onhear={hear}
        onstop={() => cache.stop()}
        actionLabel={_('Cast as a character')}
        onaction={() => picked && onsave(specOf(picked))}
      />
    </div>
  </Card>
</div>

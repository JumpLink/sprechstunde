<script lang="ts">
  import { _ } from '$lib/i18n.svelte';
  import { app } from '$lib/store.svelte';
  import Badge from './Badge.svelte';

  let { provider }: { provider: string } = $props();
</script>

{#if provider === 'pocket'}<Badge tone="success">{_('Local')}</Badge>{/if}
{#if provider === 'kugel' && app.state?.kugelEu}<Badge tone="success">{_('EU endpoint')}</Badge>{/if}

<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, children }: { title: string; children?: Snippet } = $props();
</script>

<div class="rounded-lg border border-dashed px-4 py-8 text-center">
  <p class="font-medium">{title}</p>
  {#if children}<div class="mt-1 text-sm text-muted-foreground">{@render children()}</div>{/if}
</div>

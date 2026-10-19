<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    hint?: string;
    for?: string;
    children: Snippet;
  }

  let { label, hint, for: htmlFor, children }: Props = $props();
</script>

<div class="space-y-1.5">
  <label class="text-sm font-medium" for={htmlFor}>{label}</label>
  {@render children()}
  {#if hint}<p class="text-xs text-muted-foreground">{hint}</p>{/if}
</div>

<script lang="ts">
  import { ensureCatalogs, findModel } from '$lib/models.svelte';

  let { target, id }: { target: string; id?: string } = $props();

  $effect(() => ensureCatalogs([target]));
  const model = $derived(findModel(target, id));
</script>

{#if id}
  <span class="font-medium">{model?.label ?? id}</span>
  {#if model && model.label !== id}<span class="text-xs break-all text-muted-foreground">{id}</span>{/if}
{/if}

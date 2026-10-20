<script lang="ts">
  import { ensureCatalogs, findModel } from '$lib/models.svelte';
  import ModelFacts from './ModelFacts.svelte';

  let { target, id }: { target: string; id?: string } = $props();

  $effect(() => ensureCatalogs([target]));
  const model = $derived(findModel(target, id));
</script>

{#if model}
  <div class="rounded-lg border bg-muted/40 p-3">
    <p class="mb-2 font-medium">{model.label}</p>
    <ModelFacts {target} {model} />
  </div>
{/if}

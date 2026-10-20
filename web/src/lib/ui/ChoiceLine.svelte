<script lang="ts">
  import ModelName from './ModelName.svelte';

  let { provider, model, voice }: { provider: string; model?: string; voice?: string } = $props();
</script>

<span class="break-words">
  {provider}{#if model}
    · <ModelName target={provider} id={model} />{/if}{#if voice}
    · {voice}{/if}
</span>

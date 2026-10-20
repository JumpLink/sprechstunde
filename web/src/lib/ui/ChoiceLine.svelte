<script lang="ts">
  import ModelName from './ModelName.svelte';
  import VendorBadge from './VendorBadge.svelte';

  let { provider, model, voice }: { provider: string; model?: string; voice?: string } = $props();
</script>

<span class="break-words">
  <VendorBadge {provider} />{#if model}{' · '}<ModelName target={provider} id={model} />{/if}{#if voice}{' · '}{voice}{/if}
</span>

<script lang="ts">
  import { CircleDot, Mars, Venus } from '@lucide/svelte';
  import type { Gender } from '$lib/types';
  import { genderLabel } from '$lib/voices';

  let { gender }: { gender?: Gender } = $props();
</script>

{#if gender}
  {@const Icon = gender === 'female' ? Venus : gender === 'male' ? Mars : CircleDot}
  <Icon class="size-4 shrink-0 text-muted-foreground" aria-label={genderLabel(gender)} role="img" />
{/if}

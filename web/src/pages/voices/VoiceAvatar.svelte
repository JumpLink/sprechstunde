<script lang="ts">
  import { avatarUrl } from '$lib/api';
  import type { Candidate } from '$lib/casting';
  import { vendorOf } from '$lib/vendor';
  import { initials } from '$lib/voices';
  import { cn } from '$lib/utils';

  interface Props {
    candidate: Candidate;
    class?: string;
  }

  let { candidate, class: className }: Props = $props();

  let failed = $state(false);
  const colour = $derived(vendorOf(candidate.provider).colour);
</script>

{#if candidate.hasAvatar && !failed}
  <img
    src={avatarUrl(candidate.provider, candidate.voice, candidate.model)}
    alt=""
    loading="lazy"
    decoding="async"
    class={cn('shrink-0 bg-muted object-cover', className)}
    onerror={() => (failed = true)}
  />
{:else}
  <span
    aria-hidden="true"
    class={cn(
      'inline-flex shrink-0 items-center justify-center bg-[color-mix(in_oklab,var(--v)_16%,transparent)] font-semibold text-[var(--v)]',
      className,
    )}
    style:--v={colour}
  >
    {initials(candidate.name)}
  </span>
{/if}

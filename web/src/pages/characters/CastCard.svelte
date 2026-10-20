<script lang="ts">
  import { Check, Loader, Play } from '@lucide/svelte';
  import { _, fill } from '$lib/i18n.svelte';
  import type { Candidate } from '$lib/casting';
  import { genderLabel } from '$lib/voices';
  import Badge from '$lib/ui/Badge.svelte';
  import RegionBadges from '$lib/ui/RegionBadges.svelte';
  import VendorBadge from '$lib/ui/VendorBadge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import { cn } from '$lib/utils';

  interface Props {
    candidate: Candidate;
    heard?: { busy?: boolean; ttfaMs?: number; error?: string };
    /** `A` and `B` in the comparison. */
    tag?: string;
    selected?: boolean;
    /** Without a way to choose, the card only presents the voice. */
    selectLabel?: string;
    onplay: () => void;
    onselect?: () => void;
  }

  let { candidate, heard, tag, selected = false, selectLabel, onplay, onselect }: Props = $props();
</script>

<li class={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs', selected && 'border-primary ring-2 ring-primary/30')}>
  <div class="min-w-0">
    <p class="flex flex-wrap items-center gap-2 font-medium">
      {#if tag}<span class="inline-flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">{tag}</span>{/if}
      <span class="break-words">{candidate.name}</span>
    </p>
    <p class="mt-1.5 flex flex-wrap gap-1.5">
      <VendorBadge provider={candidate.provider} model={candidate.model} />
      <RegionBadges provider={candidate.provider} />
      {#if candidate.gender}<Badge>{genderLabel(candidate.gender)}</Badge>{/if}
    </p>
    {#if candidate.description}<p class="mt-2 line-clamp-2 text-xs text-muted-foreground">{candidate.description}</p>{/if}
  </div>
  <div class="mt-auto space-y-2">
    <Button variant="outline" size="sm" class="w-full" disabled={heard?.busy} onclick={onplay}>
      {#if heard?.busy}<Loader class="size-4 animate-spin" />{_('Synthesizing…')}{:else}<Play class="size-4" />{_('Hear greeting')}{/if}
    </Button>
    <p class="min-h-4 text-xs {heard?.error ? 'text-destructive' : 'text-muted-foreground'}" aria-live="polite">
      {#if heard?.error}{heard.error}{:else if heard?.ttfaMs !== undefined}{fill(_('First audio after %s ms'), heard.ttfaMs)}{/if}
    </p>
    {#if onselect}
      <Button variant={selected ? 'default' : 'outline'} size="sm" class="w-full" aria-pressed={selected} onclick={onselect}>
        {#if selected}<Check class="size-4" />{/if}{selectLabel}
      </Button>
    {/if}
  </div>
</li>

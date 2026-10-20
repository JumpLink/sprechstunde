<script lang="ts">
  import { BadgeCheck, Check, Heart, Loader, MessageCircle, Square, Volume2 } from '@lucide/svelte';
  import type { Candidate } from '$lib/casting';
  import { _, fill } from '$lib/i18n.svelte';
  import Button from '$lib/ui/Button.svelte';
  import RegionBadges from '$lib/ui/RegionBadges.svelte';
  import VendorBadge from '$lib/ui/VendorBadge.svelte';
  import { cn } from '$lib/utils';
  import { ageLabel, categoryLabel, qualityLabel } from './facts';
  import GenderMark from './GenderMark.svelte';
  import VoiceAvatar from './VoiceAvatar.svelte';

  interface Props {
    candidate: Candidate;
    selected: boolean;
    favourite: boolean;
    sampling: boolean;
    heard?: { busy?: boolean; ttfaMs?: number; error?: string };
    onsample: () => void;
    onhear: () => void;
    onfavourite: () => void;
    onselect: () => void;
  }

  let { candidate, selected, favourite, sampling, heard, onsample, onhear, onfavourite, onselect }: Props = $props();

  const facts = $derived([candidate.age && ageLabel(candidate.age), candidate.quality && qualityLabel(candidate.quality), candidate.category && categoryLabel(candidate.category)].filter(Boolean));
</script>

<li
  class={cn(
    'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-3 shadow-xs',
    selected && 'border-primary ring-2 ring-primary',
  )}
>
  <VoiceAvatar {candidate} class="size-11 rounded-full text-sm" />
  <div class="min-w-0 flex-1 basis-44">
    <p class="flex items-center gap-1.5 font-medium">
      <span class="break-words">{candidate.name}</span>
      <GenderMark gender={candidate.gender} />
      {#if candidate.verified}<BadgeCheck class="size-4 shrink-0 text-primary" aria-label={_('Verified')} role="img" />{/if}
    </p>
    <p class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <VendorBadge provider={candidate.provider} model={candidate.model} />
      <RegionBadges provider={candidate.provider} />
      {#if facts.length > 0}<span>{facts.join(' · ')}</span>{/if}
    </p>
    <p class="min-h-4 text-xs {heard?.error ? 'mt-1 text-destructive' : 'text-muted-foreground'}" aria-live="polite">
      {#if heard?.error}{heard.error}{:else if heard?.ttfaMs !== undefined}{fill(_('First audio after %s ms'), heard.ttfaMs)}{/if}
    </p>
  </div>
  <div class="flex items-center gap-1.5">
    {#if candidate.hasSample}
      <Button variant="outline" size="icon" onclick={onsample} aria-label={_('Hear the vendor sample')} title={_('Hear the vendor sample')}>
        {#if sampling}<Square class="size-4" />{:else}<Volume2 class="size-4" />{/if}
      </Button>
    {/if}
    <Button variant="outline" size="icon" disabled={heard?.busy} onclick={onhear} aria-label={_('Hear greeting')} title={_('Hear greeting')}>
      {#if heard?.busy}<Loader class="size-4 animate-spin" />{:else}<MessageCircle class="size-4" />{/if}
    </Button>
    <Button
      variant="outline"
      size="icon"
      onclick={onfavourite}
      aria-pressed={favourite}
      aria-label={favourite ? _('Remove from favourites') : _('Add to favourites')}
      title={favourite ? _('Remove from favourites') : _('Add to favourites')}
    >
      <Heart class={cn('size-4', favourite && 'fill-current text-destructive')} />
    </Button>
    <Button variant={selected ? 'default' : 'outline'} size="sm" aria-pressed={selected} onclick={onselect}>
      {#if selected}<Check class="size-4" />{_('Chosen')}{:else}{_('Pick')}{/if}
    </Button>
  </div>
</li>

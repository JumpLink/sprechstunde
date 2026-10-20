<script lang="ts">
  import { BadgeCheck, Check, Heart, Loader, MessageCircle, Square, Volume2 } from '@lucide/svelte';
  import type { Candidate } from '$lib/casting';
  import { _, fill } from '$lib/i18n.svelte';
  import Button from '$lib/ui/Button.svelte';
  import RegionBadges from '$lib/ui/RegionBadges.svelte';
  import VendorBadge from '$lib/ui/VendorBadge.svelte';
  import { cn } from '$lib/utils';
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
</script>

<li
  class={cn(
    'flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs',
    selected && 'border-primary ring-2 ring-primary',
  )}
>
  <div class="relative">
    <VoiceAvatar {candidate} class="aspect-[4/3] w-full text-4xl" />
    <!-- The overlay plays the vendor's own sample, which costs nothing; without one it speaks the greeting. -->
    <Button
      size="icon"
      class="absolute right-2 bottom-2 size-10 rounded-full shadow-md"
      disabled={!candidate.hasSample && heard?.busy}
      onclick={candidate.hasSample ? onsample : onhear}
      aria-label={candidate.hasSample ? _('Hear the vendor sample') : _('Hear greeting')}
    >
      {#if sampling}<Square class="size-4" />{:else if !candidate.hasSample && heard?.busy}<Loader class="size-4 animate-spin" />{:else}<Volume2 class="size-5" />{/if}
    </Button>
  </div>
  <div class="flex flex-1 flex-col gap-2 p-3">
    <p class="flex items-center gap-1.5 font-medium">
      <span class="break-words">{candidate.name}</span>
      <GenderMark gender={candidate.gender} />
      {#if candidate.verified}<BadgeCheck class="size-4 shrink-0 text-primary" aria-label={_('Verified')} role="img" />{/if}
    </p>
    <p class="flex flex-wrap items-center gap-1.5">
      <VendorBadge provider={candidate.provider} model={candidate.model} />
      <RegionBadges provider={candidate.provider} />
    </p>
    <p class="min-h-4 text-xs {heard?.error ? 'text-destructive' : 'text-muted-foreground'}" aria-live="polite">
      {#if heard?.error}{heard.error}{:else if heard?.ttfaMs !== undefined}{fill(_('First audio after %s ms'), heard.ttfaMs)}{/if}
    </p>
    <div class="mt-auto flex gap-1.5">
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
      <Button class="flex-1" variant={selected ? 'default' : 'outline'} size="sm" aria-pressed={selected} onclick={onselect}>
        {#if selected}<Check class="size-4" />{_('Chosen')}{:else}{_('Pick')}{/if}
      </Button>
    </div>
  </div>
</li>

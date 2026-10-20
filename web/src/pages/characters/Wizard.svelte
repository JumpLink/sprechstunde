<script lang="ts">
  import { ArrowLeft, ArrowRight, CircleDot, Mars, Play, Plus, Venus, X } from '@lucide/svelte';
  import { onDestroy, untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { api, message } from '$lib/api';
  import {
    type Candidate,
    candidatesFrom,
    defaultFallback,
    greetingWithName,
    type Heard,
    loadGreeting,
    poolFor,
    previewCache,
    specKey,
    specOf,
  } from '$lib/casting';
  import { _, fill } from '$lib/i18n.svelte';
  import { catalogOf, ensureCatalogs } from '$lib/models.svelte';
  import { app, reload } from '$lib/store.svelte';
  import type { Character, CharactersView, Gender, Knowledge, VoiceSpec } from '$lib/types';
  import { genderLabel } from '$lib/voices';
  import Avatar from '$lib/ui/Avatar.svelte';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import ChoiceLine from '$lib/ui/ChoiceLine.svelte';
  import Field from '$lib/ui/Field.svelte';
  import { cn, controlClass } from '$lib/utils';
  import VoiceBrowser from '../voices/VoiceBrowser.svelte';
  import CastCard from './CastCard.svelte';

  interface Props {
    /** The character being edited; unset when casting a new one. */
    initial?: Character;
    /** A voice picked in the catalog browser. */
    seed?: VoiceSpec;
    onclose: () => void;
  }

  let { initial, seed, onclose }: Props = $props();

  type Step = 'who' | 'casting' | 'compare' | 'done';

  const MAX_NAME = 60;
  const MAX_TONE = 300;

  // The wizard is keyed by what it was opened with, so reading the props once is what is wanted.
  /* svelte-ignore state_referenced_locally */
  let name = $state(initial?.name ?? '');
  /* svelte-ignore state_referenced_locally */
  let gender = $state<Gender | undefined>(initial && !initial.genderUnknown ? initial.gender : undefined);
  /* svelte-ignore state_referenced_locally */
  let tone = $state(initial?.tone ?? '');
  let step = $state<Step>('who');
  let phone = $state(false);
  let favourites = $state<Candidate[]>([]);
  let chosen = $state<Candidate>();
  let fallbackKey = $state('');
  let picking = $state(false);
  let otherLanguages = $state(false);
  let assignFile = $state('');
  let plays = $state<Record<string, { busy?: boolean; ttfaMs?: number; error?: string }>>({});
  let busy = $state(false);
  const cache = previewCache();

  onDestroy(() => cache.clear());

  const suggestions = $derived([
    _('Warm and calm'),
    _('Friendly and brisk'),
    _('Formal and polite'),
    _('Relaxed, like a neighbour'),
    _('Short and to the point'),
  ]);

  const providers = $derived((app.state?.providers ?? []).filter((provider) => app.state?.keys[provider] !== false));
  $effect(() => ensureCatalogs(providers));
  const loading = $derived(providers.some((provider) => !catalogOf(provider)));
  const catalogs = $derived(providers.map((provider) => catalogOf(provider)));
  const candidates = $derived(candidatesFrom(catalogs, 'de'));
  const everyCandidate = $derived(candidatesFrom(catalogs, ''));

  /** A saved or picked voice as a card, with the vendor's name for it when the catalog knows it. */
  function candidateOf(spec: VoiceSpec): Candidate {
    const listed = catalogOf(spec.provider)?.voices.find((voice) => voice.id === (spec.voice ?? ''));
    return {
      provider: spec.provider,
      ...(spec.model && { model: spec.model }),
      voice: spec.voice ?? '',
      name: listed?.name ?? spec.voice ?? spec.provider,
      ...(listed?.gender && { gender: listed.gender }),
      languages: listed?.languages ?? [],
    };
  }

  const startVoice = $derived(seed ?? initial?.voice);
  /* svelte-ignore state_referenced_locally */
  const same = (a: Candidate, b: Candidate): boolean => specKey(specOf(a)) === specKey(specOf(b));

  $effect(() => {
    if (startVoice && favourites.length === 0) favourites = [untrack(() => candidateOf(startVoice))];
  });

  const isFavourite = (candidate: Candidate): boolean => favourites.some((favourite) => same(favourite, candidate));

  function pick(candidate: Candidate): void {
    favourites = isFavourite(candidate)
      ? favourites.filter((favourite) => !same(favourite, candidate))
      : [...favourites, candidate].slice(-2);
  }

  async function hear(spec: VoiceSpec): Promise<Heard | undefined> {
    const key = specKey(spec);
    plays[key] = { busy: true };
    try {
      const venue = await loadGreeting();
      const text = greetingWithName(venue.greeting, venue.assistantName, name || venue.assistantName);
      const result = await cache.hear(spec, text, phone);
      plays[key] = { ttfaMs: Math.round(result.ttfaMs) };
      return result;
    } catch (error) {
      plays[key] = { error: message(error) };
      return undefined;
    }
  }

  async function play(spec: VoiceSpec): Promise<void> {
    const result = await hear(spec);
    if (result) await cache.play(result.url);
  }

  /** The same greeting in two voices, one after the other. */
  async function playPair(first: Candidate | undefined, second: Candidate | undefined): Promise<void> {
    if (!first || !second) return;
    const [a, b] = await Promise.all([hear(specOf(first)), hear(specOf(second))]);
    if (a) await cache.play(a.url);
    if (b) await cache.play(b.url);
  }

  const steps = $derived<Step[]>(favourites.length > 1 ? ['who', 'casting', 'compare', 'done'] : ['who', 'casting', 'done']);
  const titles = $derived<Record<Step, string>>({
    who: _('Who?'),
    casting: _('Casting'),
    compare: _('Compare'),
    done: _('Done'),
  });

  const primary = $derived(favourites.length > 1 ? chosen : favourites[0]);
  const nameOk = $derived(name.trim().length > 0 && name.trim().length <= MAX_NAME);
  const canNext = $derived(
    step === 'who'
      ? nameOk && gender !== undefined && tone.length <= MAX_TONE
      : step === 'casting'
        ? favourites.length > 0
        : step === 'compare'
          ? Boolean(chosen)
          : true,
  );

  function go(to: Step): void {
    cache.stop();
    if (to === 'done') {
      chosen = favourites.length > 1 ? chosen : favourites[0];
      if (!fallbackKey && chosen) {
        const current = initial?.fallbackVoice;
        const suggestion = current ? undefined : defaultFallback(chosen, candidates);
        fallbackKey = current ? specKey(current) : suggestion ? specKey(specOf(suggestion)) : '';
      }
    }
    step = to;
  }

  function next(event?: SubmitEvent): void {
    event?.preventDefault();
    if (!canNext) return;
    if (step === 'who') {
      go('casting');
    } else if (step === 'casting') {
      if (favourites.length > 1) {
        chosen = chosen && favourites.some((favourite) => same(favourite, chosen!)) ? chosen : undefined;
        go('compare');
      } else go('done');
    } else if (step === 'compare') go('done');
  }

  function back(): void {
    const index = steps.indexOf(step);
    if (index > 0) go(steps[index - 1]!);
  }

  /** The voices the fallback picker lists: German ones, or every language when the person asks. */
  const fallbackPool = $derived(otherLanguages ? everyCandidate : candidates);
  // Another vendor than the first voice is the point of a fallback; the person can lift the filter.
  // A vendor with no voice of the character's gender would only show as an empty chip.
  const fallbackVendors = $derived([...new Set(poolFor(fallbackPool, gender ?? 'neutral').known.map((candidate) => candidate.provider))].filter((provider) => provider !== primary?.provider));
  const fallbackCandidate = $derived.by<Candidate | undefined>(() => {
    if (fallbackKey === '') return undefined;
    const listed = everyCandidate.find((candidate) => specKey(specOf(candidate)) === fallbackKey);
    const saved = initial?.fallbackVoice;
    return listed ?? (saved && specKey(saved) === fallbackKey ? candidateOf(saved) : undefined);
  });
  const fallbackSpec = $derived<VoiceSpec | undefined>(
    fallbackCandidate && initial?.fallbackVoice && specKey(initial.fallbackVoice) === fallbackKey
      ? initial.fallbackVoice
      : fallbackCandidate && specOf(fallbackCandidate),
  );

  const venues = $derived((app.profiles?.profiles ?? []).filter((entry) => !entry.error));

  async function save(): Promise<void> {
    if (!primary || !gender) return;
    busy = true;
    const voice = initial && specKey(initial.voice) === specKey(specOf(primary)) ? initial.voice : specOf(primary);
    const body = {
      name: name.trim(),
      gender,
      voice,
      ...(fallbackSpec && { fallbackVoice: fallbackSpec }),
      ...(tone.trim() && { tone: tone.trim() }),
    };
    try {
      const revision = app.characters?.revision;
      const view = initial
        ? await api<CharactersView>('PUT', `/api/characters/${encodeURIComponent(initial.id)}`, { ...body, revision })
        : await api<CharactersView>('POST', '/api/characters', body);
      const id = initial?.id ?? view.created?.id;
      if (assignFile && id) {
        const venue = await api<Knowledge>('GET', `/api/knowledge?file=${encodeURIComponent(assignFile)}`);
        await api('PUT', `/api/profiles/${encodeURIComponent(assignFile)}`, {
          revision: venue.revision,
          draft: { ...venue.draft, character: id },
        });
      }
      await reload();
      toast.success(fill(_('%s saved'), name.trim()));
      onclose();
    } catch (error) {
      toast.error(message(error));
    } finally {
      busy = false;
    }
  }

  const genders = $derived<Array<{ value: Gender; label: string; hint: string; icon: typeof Venus }>>([
    { value: 'female', label: _('Female'), hint: _('She says “eine KI-Assistentin”'), icon: Venus },
    { value: 'male', label: _('Male'), hint: _('He says “ein KI-Assistent”'), icon: Mars },
    { value: 'neutral', label: _('Neutral'), hint: _('Says “eine KI”'), icon: CircleDot },
  ]);
</script>

<div class="space-y-4">
  <ol class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label={_('Steps')}>
    {#each steps as entry, index (entry)}
      <li
        class={cn('flex items-center gap-2 rounded-full px-3 py-1', entry === step ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
        aria-current={entry === step ? 'step' : undefined}
      >
        <span class="font-semibold">{index + 1}</span>{titles[entry]}
      </li>
    {/each}
  </ol>

  {#if step === 'who'}
    <form onsubmit={next}>
      <Card title={initial ? fill(_('Edit %s'), initial.name) : _('Who is answering?')} description={_('Name, gender and manner of the new character')}>
        <div class="space-y-5">
          <Field label={_('Name')} for="c-name" hint={fill(_('Up to %s characters'), MAX_NAME)}>
            <!-- svelte-ignore a11y_autofocus -->
            <input id="c-name" class={controlClass} bind:value={name} maxlength={MAX_NAME} required autofocus autocomplete="off" />
          </Field>
          <fieldset class="space-y-1.5">
            <legend class="text-sm font-medium">{_('Gender')}</legend>
            {#if initial?.genderUnknown && gender === undefined}
              <p class="text-xs text-amber-700 dark:text-amber-300">{_('This character came from an old preset, so its gender was never stated. Choose it once.')}</p>
            {/if}
            <div class="grid gap-3 sm:grid-cols-3">
              {#each genders as option (option.value)}
                <label
                  class={cn(
                    'flex cursor-pointer flex-col items-center gap-1 rounded-xl border bg-card p-4 text-center shadow-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring hover:bg-muted',
                    gender === option.value && 'border-primary bg-primary/5 ring-2 ring-primary/30',
                  )}
                >
                  <input type="radio" class="sr-only" name="gender" value={option.value} bind:group={gender} required />
                  <option.icon class="size-6" />
                  <span class="font-medium">{option.label}</span>
                  <span class="text-xs text-muted-foreground">{option.hint}</span>
                </label>
              {/each}
            </div>
          </fieldset>
          <Field label={_('Manner of speaking')} for="c-tone" hint={fill(_('Optional, one to three sentences (%1 of %2)'), tone.length, MAX_TONE)}>
            <textarea id="c-tone" class="{controlClass} min-h-20" bind:value={tone} maxlength={MAX_TONE}></textarea>
            <div class="flex flex-wrap gap-2 pt-1" role="group" aria-label={_('Suggestions')}>
              {#each suggestions as suggestion (suggestion)}
                <button
                  type="button"
                  class="rounded-full border bg-card px-3 py-1 text-xs hover:bg-muted"
                  onclick={() => (tone = (tone.trim() ? `${tone.trim()} ${suggestion}.` : `${suggestion}.`).slice(0, MAX_TONE))}
                >
                  {suggestion}
                </button>
              {/each}
            </div>
          </Field>
        </div>
      </Card>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onclick={onclose}>{_('Cancel')}</Button>
        <Button type="submit" disabled={!canNext}>{_('Next')}<ArrowRight class="size-4" /></Button>
      </div>
    </form>
  {:else if step === 'casting'}
    <Card
      title={_('Casting')}
      description={fill(_('German voices from every vendor. Each one reads your greeting as %s.'), name.trim())}
    >
      {#snippet actions()}
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" class="size-4 accent-primary" bind:checked={phone} />
          {_('Phone quality (8 kHz)')}
        </label>
      {/snippet}
      <VoiceBrowser
        {candidates}
        {loading}
        {gender}
        hide={['language']}
        selected={favourites}
        heard={plays}
        onpick={pick}
        onhear={(candidate) => play(specOf(candidate))}
        onstop={() => cache.stop()}
        actionLabel={favourites.length > 1 ? _('Compare') : _('Next')}
        actionDisabled={!canNext}
        onaction={() => next()}
      />
      <p class="mt-4 text-sm text-muted-foreground" aria-live="polite">
        {favourites.length > 1
          ? fill(_('Two favourites picked: %1 and %2. Next, hear them back to back.'), favourites[0]!.name, favourites[1]!.name)
          : favourites.length === 1
            ? fill(_('Picked: %s. Pick a second one to compare, or continue.'), favourites[0]!.name)
            : _('Pick one or two voices.')}
      </p>
    </Card>
    <div class="flex flex-wrap justify-between gap-2">
      <Button variant="outline" onclick={back}><ArrowLeft class="size-4" />{_('Back')}</Button>
    </div>
  {:else if step === 'compare'}
    <Card title={_('Compare')} description={_('The same sentence in both voices. Choose the one that fits.')}>
      {#snippet actions()}
        <Button size="sm" onclick={() => playPair(favourites[0], favourites[1])}><Play class="size-4" />{_('Play A, then B')}</Button>
      {/snippet}
      <ul class="grid gap-3 sm:grid-cols-2">
        {#each favourites as candidate, index (specKey(specOf(candidate)))}
          <CastCard
            {candidate}
            tag={index === 0 ? 'A' : 'B'}
            heard={plays[specKey(specOf(candidate))]}
            selected={chosen !== undefined && same(chosen, candidate)}
            selectLabel={chosen !== undefined && same(chosen, candidate) ? _('Chosen') : _('This one')}
            onplay={() => play(specOf(candidate))}
            onselect={() => (chosen = candidate)}
          />
        {/each}
      </ul>
    </Card>
    <div class="flex flex-wrap justify-between gap-2">
      <Button variant="outline" onclick={back}><ArrowLeft class="size-4" />{_('Back')}</Button>
      <Button onclick={() => next()} disabled={!canNext}>{_('Next')}<ArrowRight class="size-4" /></Button>
    </div>
  {:else if primary}
    <Card title={_('Done')} description={_('Check it, choose the voice that takes over when the first one fails, and save')}>
      <div class="space-y-5">
        <div class="flex items-center gap-3">
          <Avatar name={name} color={initial?.color} />
          <div class="min-w-0">
            <p class="font-medium break-words">{name.trim()}</p>
            <p class="text-sm break-words text-muted-foreground">
              {gender ? genderLabel(gender) : ''} · <ChoiceLine provider={primary.provider} model={primary.model} voice={primary.name} />
            </p>
            {#if tone.trim()}<p class="mt-1 text-sm text-muted-foreground italic">{tone.trim()}</p>{/if}
          </div>
        </div>
        <section class="space-y-3" aria-labelledby="fallback-title">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 id="fallback-title" class="text-sm font-medium">{_('Fallback voice')}</h3>
              <p class="text-xs text-muted-foreground">{_('Takes over when the first voice fails. Preselected: another vendor, a local voice if there is one.')}</p>
            </div>
            {#if fallbackCandidate}
              <Button size="sm" onclick={() => playPair(primary, fallbackCandidate)}><Play class="size-4" />{_('Play A, then B')}</Button>
            {/if}
          </div>
          <ul class="grid gap-3 sm:grid-cols-2">
            <CastCard candidate={primary} tag="A" heard={plays[specKey(specOf(primary))]} onplay={() => play(specOf(primary))} />
            {#if fallbackCandidate}
              <CastCard candidate={fallbackCandidate} tag="B" heard={plays[specKey(specOf(fallbackCandidate))]} onplay={() => play(specOf(fallbackCandidate))} />
            {:else}
              <li class="flex min-h-32 flex-col items-center justify-center gap-1 rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                <span class="inline-flex size-6 items-center justify-center rounded-full bg-muted text-xs">B</span>
                {_('No fallback voice')}
              </li>
            {/if}
          </ul>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onclick={() => (picking = !picking)} aria-expanded={picking}>
              {#if picking}<X class="size-4" />{_('Close the list')}{:else}<Plus class="size-4" />{fallbackCandidate ? _('Change the fallback voice') : _('Choose a fallback voice')}{/if}
            </Button>
            {#if fallbackCandidate}
              <Button variant="ghost" size="sm" onclick={() => (fallbackKey = '')}>{_('No fallback voice')}</Button>
            {/if}
          </div>
          {#if picking}
            <div class="space-y-3 rounded-xl border p-3">
              <div class="space-y-1">
                <label class="flex items-center gap-2 text-sm">
                  <input type="checkbox" class="size-4 accent-primary" bind:checked={otherLanguages} />
                  {_('Also voices of other languages')}
                </label>
                <p class="text-xs text-muted-foreground">{_('The vendor tags these for another language. They may speak German with an accent.')}</p>
              </div>
              <!-- The preset is read at mount; remounting applies the vendors that now have voices. -->
              {#key otherLanguages}
                <VoiceBrowser
                  candidates={fallbackPool}
                  {loading}
                  {gender}
                  hide={otherLanguages ? [] : ['language']}
                  preset={{ vendor: fallbackVendors }}
                  grouped
                  selected={fallbackCandidate ? [fallbackCandidate] : []}
                  heard={plays}
                  onpick={(candidate) => (fallbackKey = specKey(specOf(candidate)))}
                  onhear={(candidate) => play(specOf(candidate))}
                  onstop={() => cache.stop()}
                  actionLabel={_('Use this voice')}
                  onaction={() => (picking = false)}
                />
              {/key}
            </div>
          {/if}
        </section>
        <Field label={_('Assign to a venue')} for="c-assign" hint={_('Optional. Until then the venue speaks as the default character.')}>
          <select id="c-assign" class={controlClass} bind:value={assignFile}>
            <option value="">{_('Not now')}</option>
            {#each venues as venue (venue.file)}
              <option value={venue.file}>{venue.name ?? venue.id}</option>
            {/each}
          </select>
        </Field>
      </div>
    </Card>
    <div class="flex flex-wrap justify-between gap-2">
      <Button variant="outline" onclick={back}><ArrowLeft class="size-4" />{_('Back')}</Button>
      <Button onclick={save} disabled={busy}>{_('Save')}</Button>
    </div>
  {/if}
</div>

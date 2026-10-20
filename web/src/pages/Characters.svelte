<script lang="ts">
  import { Pencil, Play, Plus, Star, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { api, message } from '$lib/api';
  import { greetingWithName, loadGreeting, previewCache } from '$lib/casting';
  import { _, fill } from '$lib/i18n.svelte';
  import { app, reload } from '$lib/store.svelte';
  import type { Character, CharactersView } from '$lib/types';
  import { genderLabel } from '$lib/voices';
  import Avatar from '$lib/ui/Avatar.svelte';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import ChoiceLine from '$lib/ui/ChoiceLine.svelte';
  import Confirm from '$lib/ui/Confirm.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import { onDestroy } from 'svelte';
  import Wizard from './characters/Wizard.svelte';

  let wizard = $state<{ initial?: Character; seed?: import('$lib/types').VoiceSpec }>();
  let deleting = $state<Character>();
  let confirmOpen = $state(false);
  let playing = $state('');
  const cache = previewCache();
  onDestroy(() => cache.clear());

  // A voice picked in the catalog browser opens the wizard with it.
  $effect(() => {
    if (app.casting) {
      wizard = { seed: app.casting };
      app.casting = undefined;
    }
  });

  const view = $derived(app.characters);
  const characters = $derived(view?.characters ?? []);

  async function hear(character: Character): Promise<void> {
    playing = character.id;
    try {
      const venue = await loadGreeting();
      const text = greetingWithName(venue.greeting, venue.assistantName, character.name);
      const result = await cache.hear(character.voice, text, false);
      await cache.play(result.url);
    } catch (error) {
      toast.error(message(error));
    } finally {
      playing = '';
    }
  }

  async function makeDefault(character: Character): Promise<void> {
    try {
      await api<CharactersView>('PUT', '/api/characters/default', { id: character.id, revision: view?.revision });
      await reload();
    } catch (error) {
      toast.error(message(error));
    }
  }

  async function remove(): Promise<void> {
    const target = deleting;
    if (!target) return;
    try {
      await api('DELETE', `/api/characters/${encodeURIComponent(target.id)}`, { revision: view?.revision });
      await reload();
      toast.success(fill(_('%s deleted'), target.name));
    } catch (error) {
      toast.error(message(error));
    }
  }
</script>

{#if wizard}
  {#key wizard}
    <Wizard initial={wizard.initial} seed={wizard.seed} onclose={() => (wizard = undefined)} />
  {/key}
{:else}
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-lg font-semibold">{_('Characters')}</h1>
        <p class="text-sm text-muted-foreground">{_('Who answers the phone: a name, a voice and a manner')}</p>
      </div>
      <Button onclick={() => (wizard = {})}><Plus class="size-4" />{_('Cast a new character')}</Button>
    </div>
    {#if characters.length === 0}
      <Empty title={_('No characters yet')}>{_('Cast the first one; it becomes the default.')}</Empty>
    {:else}
      <ul class="grid gap-3 sm:grid-cols-2">
        {#each characters as character (character.id)}
          <li class="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
            <div class="flex items-start gap-3">
              <Avatar name={character.name} color={character.color} />
              <div class="min-w-0">
                <p class="flex flex-wrap items-center gap-2 font-medium">
                  <span class="break-words">{character.name}</span>
                  {#if view?.default === character.id}<Badge tone="success">{_('Default')}</Badge>{/if}
                </p>
                <p class="text-sm text-muted-foreground">
                  {character.genderUnknown ? _('Gender not stated') : genderLabel(character.gender)}
                </p>
              </div>
            </div>
            <dl class="space-y-1 text-sm">
              <div>
                <dt class="text-xs text-muted-foreground">{_('Voice')}</dt>
                <dd><ChoiceLine provider={character.voice.provider} model={character.voice.model} voice={character.voice.voice} /></dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{_('Fallback voice')}</dt>
                <dd>
                  {#if character.fallbackVoice}
                    <ChoiceLine provider={character.fallbackVoice.provider} model={character.fallbackVoice.model} voice={character.fallbackVoice.voice} />
                  {:else}{_('None')}{/if}
                </dd>
              </div>
            </dl>
            {#if character.tone}<p class="line-clamp-2 text-sm text-muted-foreground italic">{character.tone}</p>{/if}
            <p class="text-xs text-muted-foreground">
              {#if character.usedBy.length > 0}
                {fill(_('Used by: %s'), character.usedBy.map((venue) => venue.name ?? venue.id).join(', '))}
              {:else}{_('Not assigned to a venue')}{/if}
            </p>
            <div class="mt-auto flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={playing === character.id} onclick={() => hear(character)}>
                <Play class="size-4" />{_('Hear greeting')}
              </Button>
              <Button variant="outline" size="sm" onclick={() => (wizard = { initial: character })}>
                <Pencil class="size-4" />{_('Edit')}
              </Button>
              {#if view?.default !== character.id}
                <Button variant="outline" size="sm" onclick={() => makeDefault(character)}>
                  <Star class="size-4" />{_('Make default')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={fill(_('Delete %s'), character.name)}
                  disabled={character.usedBy.some((venue) => venue.explicit)}
                  onclick={() => {
                    deleting = character;
                    confirmOpen = true;
                  }}
                >
                  <Trash2 class="size-4" />
                </Button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<Confirm
  bind:open={confirmOpen}
  title={fill(_('Delete %s?'), deleting?.name ?? '')}
  description={_('The character is removed for good.')}
  confirmLabel={_('Delete')}
  onconfirm={remove}
/>

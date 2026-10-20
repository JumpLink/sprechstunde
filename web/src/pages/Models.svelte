<script lang="ts">
  import { Tabs } from 'bits-ui';
  import { _ } from '$lib/i18n.svelte';
  import { navigate } from '$lib/router.svelte';
  import { app } from '$lib/store.svelte';
  import type { VoiceSpec } from '$lib/types';
  import ModelList from './models/ModelList.svelte';
  import VoiceCatalog from './models/VoiceCatalog.svelte';

  let tab = $state('models');

  /** A voice picked in the catalog starts the casting wizard with it. */
  function cast(voice: VoiceSpec): void {
    app.casting = voice;
    navigate('/characters');
  }

  const triggerClass =
    'rounded-md px-4 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs';
</script>

<Tabs.Root bind:value={tab}>
  <Tabs.List class="mb-4 inline-flex rounded-lg bg-muted p-1" aria-label={_('Models')}>
    <Tabs.Trigger value="models" class={triggerClass}>{_('Models')}</Tabs.Trigger>
    <Tabs.Trigger value="voices" class={triggerClass}>{_('Voice catalog')}</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="models" class="space-y-4">
    <ModelList />
  </Tabs.Content>
  <Tabs.Content value="voices">
    <VoiceCatalog onsave={cast} />
  </Tabs.Content>
</Tabs.Root>

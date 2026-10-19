<script lang="ts">
  import { Tabs } from 'bits-ui';
  import { _ } from '$lib/i18n.svelte';
  import type { Preset } from '$lib/types';
  import Catalog from './voices/Catalog.svelte';
  import Presets from './voices/Presets.svelte';

  let tab = $state('presets');
  let draft = $state<Preset>();

  function saveAsPreset(preset: Preset): void {
    draft = preset;
    tab = 'presets';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const triggerClass =
    'rounded-md px-4 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs';
</script>

<Tabs.Root bind:value={tab}>
  <Tabs.List class="mb-4 inline-flex rounded-lg bg-muted p-1" aria-label={_('Voices')}>
    <Tabs.Trigger value="presets" class={triggerClass}>{_('Presets')}</Tabs.Trigger>
    <Tabs.Trigger value="catalog" class={triggerClass}>{_('Catalog')}</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="presets">
    <Presets {draft} ondraftclosed={() => (draft = undefined)} />
  </Tabs.Content>
  <Tabs.Content value="catalog">
    <Catalog onsave={saveAsPreset} />
  </Tabs.Content>
</Tabs.Root>

<script lang="ts">
  import { Pencil, Plus, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { api, message } from '$lib/api';
  import { _, fill } from '$lib/i18n.svelte';
  import { app, reload } from '$lib/store.svelte';
  import type { Preset, Settings } from '$lib/types';
  import { describeChoice } from '$lib/voices';
  import Badge from '$lib/ui/Badge.svelte';
  import ChoiceLine from '$lib/ui/ChoiceLine.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Confirm from '$lib/ui/Confirm.svelte';
  import Empty from '$lib/ui/Empty.svelte';
  import Field from '$lib/ui/Field.svelte';
  import { controlClass } from '$lib/utils';
  import PresetForm from './PresetForm.svelte';
  import Preview from './Preview.svelte';

  interface Props {
    /** Set by the catalog browser: a draft that opens the form. */
    draft?: Preset;
    ondraftclosed: () => void;
  }

  let { draft, ondraftclosed }: Props = $props();

  let form = $state<{ initial: Preset; editing?: string }>();
  let deleting = $state<Preset>();
  let confirmOpen = $state(false);

  const snapshot = $derived(app.state);
  const presets = $derived(snapshot?.settings.presets ?? []);

  $effect(() => {
    if (draft) form = { initial: draft };
  });

  const blank = (): Preset => ({ id: '', label: '', provider: snapshot?.providers[0] ?? 'mistral' });

  function close(): void {
    form = undefined;
    ondraftclosed();
  }

  let primary = $state('');
  let fallback = $state('');
  let savingPair = $state(false);

  $effect(() => {
    primary = snapshot?.settings.active.primary ?? '';
    fallback = snapshot?.settings.active.fallback ?? '';
  });

  async function saveActive(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    savingPair = true;
    try {
      await api<Settings>('PUT', '/api/active', { primary: primary || undefined, fallback: fallback || undefined });
      await reload();
      toast.success(_('Active voices saved'));
    } catch (error) {
      toast.error(message(error));
    } finally {
      savingPair = false;
    }
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    const target = deleting;
    try {
      await api<Settings>('DELETE', `/api/presets/${encodeURIComponent(target.id)}`);
      await reload();
      toast.success(fill(_('Deleted %s'), target.label));
    } catch (error) {
      toast.error(message(error));
    } finally {
      confirmOpen = false;
      deleting = undefined;
    }
  }
</script>

{#if snapshot}
  <div class="space-y-4">
    <Card title={_('Active voices')} description={_('The primary voice speaks; the fallback takes over when it fails')}>
      <form class="grid gap-4 sm:grid-cols-2" onsubmit={saveActive}>
        {#each [{ key: 'primary', label: _('Primary') }, { key: 'fallback', label: _('Fallback') }] as slot (slot.key)}
          {@const env = snapshot?.envVoice[slot.key === 'primary' ? 'primary' : 'fallback']}
          <Field label={slot.label} for="active-{slot.key}">
            {#if slot.key === 'primary'}
              <select id="active-primary" class={controlClass} bind:value={primary}>
                <option value="">{_('Environment')}</option>
                {#each presets as preset (preset.id)}<option value={preset.id}>{preset.label}</option>{/each}
              </select>
            {:else}
              <select id="active-fallback" class={controlClass} bind:value={fallback}>
                <option value="">{_('Environment')}</option>
                {#each presets as preset (preset.id)}<option value={preset.id}>{preset.label}</option>{/each}
              </select>
            {/if}
            <p class="text-xs text-muted-foreground">
              {#if env}{fill(_('Environment: %s'), describeChoice(env))}{:else}{_('Environment: not configured')}{/if}
            </p>
          </Field>
        {/each}
        {#if snapshot?.envVoice.error}
          <p class="text-sm text-destructive sm:col-span-2" role="alert">{snapshot?.envVoice.error}</p>
        {/if}
        <div class="flex justify-end sm:col-span-2">
          <Button type="submit" disabled={savingPair}>{_('Save')}</Button>
        </div>
      </form>
    </Card>

    {#if form}
      {#key form}
        <PresetForm initial={form.initial} editing={form.editing} onclose={close} />
      {/key}
    {/if}

    <Card title={_('Presets')} description={_('Saved voice settings you can switch between')}>
      {#snippet actions()}
        <Button size="sm" onclick={() => (form = { initial: blank() })}><Plus class="size-4" />{_('Add preset')}</Button>
      {/snippet}
      {#if presets.length === 0}
        <Empty title={_('No presets yet')}>{_('Add one here, or save a voice from the catalog.')}</Empty>
      {:else}
        <ul class="divide-y">
          {#each presets as preset (preset.id)}
            <li class="flex flex-wrap items-center justify-between gap-2 py-3">
              <div class="min-w-0">
                <p class="flex flex-wrap items-center gap-2 font-medium">
                  {preset.label}
                  {#if snapshot?.settings.active.primary === preset.id}<Badge tone="success">{_('Primary')}</Badge>{/if}
                  {#if snapshot?.settings.active.fallback === preset.id}<Badge>{_('Fallback')}</Badge>{/if}
                </p>
                <p class="text-sm break-words text-muted-foreground">
                  <code>{preset.id}</code> · <ChoiceLine provider={preset.provider} model={preset.model} voice={preset.voice} />
                </p>
              </div>
              <div class="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={fill(_('Edit %s'), preset.label)}
                  onclick={() => (form = { initial: preset, editing: preset.id })}
                >
                  <Pencil class="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={fill(_('Delete %s'), preset.label)}
                  onclick={() => {
                    deleting = preset;
                    confirmOpen = true;
                  }}
                >
                  <Trash2 class="size-4" />
                </Button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <Preview />
  </div>
{/if}

<Confirm
  bind:open={confirmOpen}
  title={_('Delete preset?')}
  description={fill(_('"%s" is removed. This cannot be undone.'), deleting?.label ?? '')}
  confirmLabel={_('Delete')}
  onconfirm={remove}
/>

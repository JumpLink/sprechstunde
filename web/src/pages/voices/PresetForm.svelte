<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { api, message } from '$lib/api';
  import { optional } from '$lib/format';
  import { _ } from '$lib/i18n.svelte';
  import { catalogOf, ensureCatalogs, modelOption } from '$lib/models.svelte';
  import { app, reload } from '$lib/store.svelte';
  import type { Preset, Provider, Settings } from '$lib/types';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Field from '$lib/ui/Field.svelte';
  import ModelInfo from '$lib/ui/ModelInfo.svelte';
  import { controlClass } from '$lib/utils';

  interface Props {
    initial: Preset;
    /** The id of the preset being edited; unset when adding. */
    editing?: string;
    onclose: () => void;
  }

  let { initial, editing, onclose }: Props = $props();

  // The form is keyed by its draft, so reading the initial value once is what is wanted.
  /* svelte-ignore state_referenced_locally */
  let id = $state(initial.id);
  /* svelte-ignore state_referenced_locally */
  let label = $state(initial.label);
  /* svelte-ignore state_referenced_locally */
  let provider = $state<Provider>(initial.provider);
  /* svelte-ignore state_referenced_locally */
  let model = $state(initial.model ?? '');
  /* svelte-ignore state_referenced_locally */
  let voice = $state(initial.voice ?? '');
  /* svelte-ignore state_referenced_locally */
  let refAudio = $state(initial.refAudio ?? '');
  /* svelte-ignore state_referenced_locally */
  let name = $state(initial.name ?? '');
  let busy = $state(false);

  const providers = $derived(app.state?.providers ?? []);
  $effect(() => ensureCatalogs([provider]));
  const noKey = $derived(app.state?.keys[provider] === false);

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    const preset: Preset = {
      id: id.trim(),
      label: label.trim(),
      provider,
      model: optional(model),
      voice: optional(voice),
      refAudio: optional(refAudio),
      name: optional(name),
    };
    try {
      await api<Settings>(editing ? 'PUT' : 'POST', editing ? `/api/presets/${encodeURIComponent(editing)}` : '/api/presets', preset);
      await reload();
      toast.success(_('Preset saved'));
      onclose();
    } catch (error) {
      toast.error(message(error));
    } finally {
      busy = false;
    }
  }
</script>

<Card title={editing ? _('Edit preset') : _('Add preset')}>
  <form class="grid gap-4 sm:grid-cols-2" onsubmit={save}>
    <Field label={_('ID')} for="preset-id" hint={_('Letters, digits, dot, dash and underscore')}>
      <input
        id="preset-id"
        class={controlClass}
        bind:value={id}
        required
        pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
        readonly={Boolean(editing)}
      />
    </Field>
    <Field label={_('Label')} for="preset-label">
      <input id="preset-label" class={controlClass} bind:value={label} required />
    </Field>
    <Field label={_('Provider')} for="preset-provider" hint={noKey ? _('No API key set for this provider') : undefined}>
      <select id="preset-provider" class={controlClass} bind:value={provider}>
        {#each providers as option (option)}<option value={option}>{option}</option>{/each}
      </select>
    </Field>
    <Field label={_('Model')} for="preset-model">
      <input id="preset-model" class={controlClass} list="preset-models" bind:value={model} placeholder={_("The vendor's default")} />
      <datalist id="preset-models">
        {#each catalogOf(provider)?.models ?? [] as option (option.id)}<option value={option.id}>{modelOption(option)}</option>{/each}
      </datalist>
    </Field>
    <div class="sm:col-span-2 empty:hidden"><ModelInfo target={provider} id={model.trim()} /></div>
    <Field label={_('Voice')} for="preset-voice">
      <input id="preset-voice" class={controlClass} bind:value={voice} />
    </Field>
    <Field label={_('Reference audio')} for="preset-ref" hint={_('File in the voices directory, Mistral only')}>
      <input id="preset-ref" class={controlClass} bind:value={refAudio} />
    </Field>
    <Field label={_('Assistant name')} for="preset-name">
      <input id="preset-name" class={controlClass} bind:value={name} />
    </Field>
    <div class="flex items-end justify-end gap-2 sm:col-span-2">
      <Button variant="outline" onclick={onclose}>{_('Cancel')}</Button>
      <Button type="submit" disabled={busy}>{_('Save')}</Button>
    </div>
  </form>
</Card>

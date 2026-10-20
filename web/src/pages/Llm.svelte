<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { api, message } from '$lib/api';
  import { optional } from '$lib/format';
  import { _ } from '$lib/i18n.svelte';
  import { catalogOf, DEFAULT_LLM, ensureCatalogs, modelOption } from '$lib/models.svelte';
  import { app, reload } from '$lib/store.svelte';
  import type { Settings } from '$lib/types';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Field from '$lib/ui/Field.svelte';
  import ModelInfo from '$lib/ui/ModelInfo.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { controlClass } from '$lib/utils';

  let model = $state('');
  let fallbackModel = $state('');
  let timeout = $state('');
  let busy = $state(false);
  const models = $derived(catalogOf('llm'));

  $effect(() => {
    const llm = app.state?.settings.llm;
    if (!llm) return;
    model = llm.model ?? '';
    fallbackModel = llm.fallbackModel ?? '';
    timeout = llm.attemptTimeoutS === undefined ? '' : String(llm.attemptTimeoutS);
  });

  $effect(() => ensureCatalogs(['llm']));

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true;
    try {
      await api<Settings>('PUT', '/api/llm', {
        model: optional(model),
        fallbackModel: optional(fallbackModel),
        attemptTimeoutS: timeout.trim() === '' ? undefined : Number(timeout),
      });
      await reload();
      toast.success(_('Language model saved'));
    } catch (error) {
      toast.error(message(error));
    } finally {
      busy = false;
    }
  }
</script>

{#if !app.state}
  <Skeleton class="h-64" />
{:else}
  <Card title={_('Language model')} description={_('The model answers; the fallback model is tried when it times out or fails')}>
    <form class="grid gap-4 sm:grid-cols-2" onsubmit={save}>
      <Field label={_('Model')} for="llm-model">
        <input id="llm-model" class={controlClass} list="llm-models" bind:value={model} placeholder={DEFAULT_LLM} />
      </Field>
      <Field label={_('Fallback model')} for="llm-fallback">
        <input id="llm-fallback" class={controlClass} list="llm-models" bind:value={fallbackModel} />
      </Field>
      <div class="grid gap-4 sm:col-span-2 sm:grid-cols-2">
        <ModelInfo target="llm" id={model.trim() || DEFAULT_LLM} />
        <ModelInfo target="llm" id={fallbackModel.trim()} />
      </div>
      <Field label={_('Attempt timeout (seconds)')} for="llm-timeout" hint={_('After this long without an answer the fallback model takes over')}>
        <input id="llm-timeout" class={controlClass} type="number" min="1" step="0.5" bind:value={timeout} />
      </Field>
      <datalist id="llm-models">
        {#each models?.models ?? [] as option (option.id)}<option value={option.id}>{modelOption(option)}</option>{/each}
      </datalist>
      <div class="flex items-end justify-end sm:col-span-2">
        <Button type="submit" disabled={busy}>{_('Save')}</Button>
      </div>
    </form>
    <p class="mt-4 text-xs text-muted-foreground" aria-live="polite">
      {#if !models}
        {_('Loading the model list…')}
      {:else if !models.available}
        {models.reason ?? _('The model list is not available; type a model name.')}
      {:else}
        {_('Suggestions come from the provider; any model name works.')}
      {/if}
    </p>
  </Card>
{/if}

<script lang="ts">
  import { Play } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { message, preview } from '$lib/api';
  import { _, fill } from '$lib/i18n.svelte';
  import { app } from '$lib/store.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Audio from '$lib/ui/Audio.svelte';
  import Card from '$lib/ui/Card.svelte';
  import { controlClass } from '$lib/utils';

  const ENVIRONMENT = '';

  let text = $state(app.state?.sampleText ?? '');
  let phone = $state(false);
  let selected = $state<string[]>([]);
  let running = $state(false);
  let results = $state<Array<{ key: string; label: string; url?: string; ttfaMs?: number; error?: string }>>([]);

  const options = $derived([
    ...(app.state?.envVoice.primary ? [{ id: ENVIRONMENT, label: _('Environment') }] : []),
    ...(app.state?.settings.presets ?? []).map((preset) => ({ id: preset.id, label: preset.label })),
  ]);

  async function run(): Promise<void> {
    if (selected.length === 0) {
      toast.error(_('Pick at least one voice'));
      return;
    }
    running = true;
    results = [];
    for (const id of selected) {
      const label = options.find((option) => option.id === id)?.label ?? id;
      try {
        const result = await preview({ preset: id }, text, phone);
        results = [...results, { key: id, label, ...result }];
      } catch (error) {
        results = [...results, { key: id, label, error: message(error) }];
      }
    }
    running = false;
  }
</script>

<Card title={_('Compare voices')} description={_('Speak one text with several presets and see how fast the first audio arrives')}>
  <div class="space-y-4">
    <fieldset class="flex flex-wrap gap-x-4 gap-y-2">
      <legend class="sr-only">{_('Voices to compare')}</legend>
      {#each options as option (option.id)}
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" class="size-4 accent-primary" value={option.id} bind:group={selected} />
          {option.label}
        </label>
      {/each}
    </fieldset>
    <textarea class={controlClass} rows="3" bind:value={text} aria-label={_('Text to speak')}></textarea>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" class="size-4 accent-primary" bind:checked={phone} />
        {_('Phone quality (8 kHz)')}
      </label>
      <Button onclick={run} disabled={running}><Play class="size-4" />{running ? _('Synthesizing…') : _('Play')}</Button>
    </div>
    {#if results.length > 0}
      <ul class="grid gap-3 sm:grid-cols-2">
        {#each results as result (result.key)}
          <li class="space-y-2 rounded-lg border p-3">
            <p class="font-medium">{result.label}</p>
            {#if result.error}
              <p class="text-sm text-destructive" role="alert">{result.error}</p>
            {:else if result.url}
              <p class="text-sm text-muted-foreground">{fill(_('First audio after %s ms'), result.ttfaMs ?? 0)}</p>
              <Audio src={result.url} />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Card>

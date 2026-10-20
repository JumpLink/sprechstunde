<script lang="ts">
  import { parseMarkdown, type Inline } from '$lib/markdown';

  let { text }: { text: string } = $props();
  const blocks = $derived(parseMarkdown(text));
</script>

{#snippet spans(parts: Inline[])}
  {#each parts as part}
    {#if part.href}
      <a href={part.href} target="_blank" rel="noopener noreferrer" class="text-primary underline">{part.text}</a>
    {:else if part.bold}
      <strong>{part.text}</strong>
    {:else if part.code}
      <code class="rounded bg-muted px-1 text-[0.85em]">{part.text}</code>
    {:else}
      {part.text}
    {/if}
  {/each}
{/snippet}

<div class="space-y-2 text-sm break-words">
  {#each blocks as block}
    {#if block.type === 'heading'}
      <p class="font-semibold {block.level <= 2 ? 'text-base' : ''}">{@render spans(block.inline)}</p>
    {:else if block.type === 'paragraph'}
      <p>{@render spans(block.inline)}</p>
    {:else if block.type === 'list'}
      <ul class="list-disc space-y-0.5 pl-5">
        {#each block.items as item}<li>{@render spans(item)}</li>{/each}
      </ul>
    {:else if block.type === 'code'}
      <pre class="overflow-x-auto rounded-md bg-muted p-2 text-xs">{block.text}</pre>
    {:else}
      <hr />
    {/if}
  {/each}
</div>

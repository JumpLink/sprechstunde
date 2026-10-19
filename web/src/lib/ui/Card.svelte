<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';

  interface Props {
    title?: string;
    description?: string;
    class?: string;
    actions?: Snippet;
    children: Snippet;
  }

  let { title, description, class: className, actions, children }: Props = $props();
</script>

<section class={cn('rounded-xl border bg-card p-4 shadow-xs sm:p-5', className)}>
  {#if title || actions}
    <header class="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        {#if title}<h2 class="text-base font-semibold">{title}</h2>{/if}
        {#if description}<p class="mt-0.5 text-sm text-muted-foreground">{description}</p>{/if}
      </div>
      {#if actions}<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>{/if}
    </header>
  {/if}
  {@render children()}
</section>

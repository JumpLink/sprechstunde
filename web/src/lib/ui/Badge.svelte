<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';

  interface Props {
    tone?: 'neutral' | 'success' | 'warning' | 'danger';
    class?: string;
    children: Snippet;
  }

  let { tone = 'neutral', class: className, children }: Props = $props();

  const tones = {
    neutral: 'bg-muted text-muted-foreground',
    success: 'bg-success/15 text-success',
    warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    danger: 'bg-destructive/15 text-destructive',
  };
</script>

<span class={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)}>
  {@render children()}
</span>

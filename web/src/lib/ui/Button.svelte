<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  interface Props extends HTMLButtonAttributes {
    variant?: 'default' | 'outline' | 'ghost' | 'destructive';
    size?: 'sm' | 'md' | 'icon';
    children: Snippet;
  }

  let { variant = 'default', size = 'md', class: className, children, ...rest }: Props = $props();

  const variants = {
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
    outline: 'border bg-card hover:bg-muted',
    ghost: 'hover:bg-muted',
    destructive: 'bg-destructive text-primary-foreground hover:bg-destructive/90',
  };
  const sizes = { sm: 'h-8 px-3 text-xs', md: 'h-9 px-4 text-sm', icon: 'size-9' };
</script>

<button
  type="button"
  class={cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  )}
  {...rest}
>
  {@render children()}
</button>

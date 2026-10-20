<script lang="ts">
  import { vendorOf } from '$lib/vendor';
  import { cn } from '$lib/utils';

  interface Props {
    provider: string;
    model?: string;
    /** Only the monogram, for tight places; the name stays readable to a screen reader. */
    mark?: boolean;
    class?: string;
  }

  let { provider, model, mark = false, class: className }: Props = $props();

  const vendor = $derived(vendorOf(provider, model));
</script>

<span
  class={cn(
    'inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--v)_14%,transparent)] py-0.5 pr-2 pl-0.5 align-middle text-xs font-medium text-[var(--v)]',
    mark && 'pr-0.5',
    className,
  )}
  style:--v={vendor.colour}
>
  <span
    aria-hidden="true"
    class="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--v)_24%,transparent)] text-[10px] font-semibold"
  >
    {vendor.mono}
  </span>
  {#if mark}<span class="sr-only">{vendor.name}</span>{:else}<span class="break-words">{vendor.name}</span>{/if}
</span>

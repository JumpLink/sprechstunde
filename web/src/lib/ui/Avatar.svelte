<script lang="ts">
  import { initials } from '$lib/voices';
  import { cn } from '$lib/utils';

  interface Props {
    name: string;
    color?: string;
    class?: string;
  }

  let { name, color, class: className }: Props = $props();
</script>

<span
  aria-hidden="true"
  class={cn('inline-flex size-12 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white', className)}
  style:background-color={color ?? '#64748b'}
>
  {initials(name)}
</span>

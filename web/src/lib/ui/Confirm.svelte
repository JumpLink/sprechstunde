<script lang="ts">
  import { AlertDialog } from 'bits-ui';
  import { _ } from '$lib/i18n.svelte';
  import Button from './Button.svelte';

  interface Props {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onconfirm: () => void;
  }

  let { open = $bindable(), title, description, confirmLabel, onconfirm }: Props = $props();
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
    <AlertDialog.Content
      class="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-5 shadow-lg"
    >
      <AlertDialog.Title class="text-base font-semibold">{title}</AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-sm text-muted-foreground">{description}</AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel>
          {#snippet child({ props })}
            <Button {...props} variant="outline">{_('Cancel')}</Button>
          {/snippet}
        </AlertDialog.Cancel>
        <AlertDialog.Action>
          {#snippet child({ props })}
            <Button {...props} variant="destructive" onclick={onconfirm}>{confirmLabel}</Button>
          {/snippet}
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

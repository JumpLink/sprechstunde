<script lang="ts">
  let { src }: { src: string } = $props();
</script>

<!-- svelte-ignore a11y_media_has_caption -->
<audio controls {src} class="h-9 w-full max-w-sm"></audio>

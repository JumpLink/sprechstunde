import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { initLanguage } from '$lib/i18n.svelte';
import { reload } from '$lib/store.svelte';
import { initTheme } from '$lib/theme.svelte';

initTheme();
await initLanguage();
void reload();

mount(App, { target: document.getElementById('app')! });

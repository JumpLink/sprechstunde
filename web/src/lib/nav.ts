import { AudioLines, BookOpen, Boxes, Brain, Gauge, PhoneCall } from '@lucide/svelte';
import type { Component } from 'svelte';
import { _ } from './i18n.svelte';

export interface NavItem {
  path: string;
  label: string;
  icon: Component;
}

/** A function, so the labels follow the language. */
export const navItems = (): NavItem[] => [
  { path: '/', label: _('Overview'), icon: Gauge },
  { path: '/voices', label: _('Voices'), icon: AudioLines },
  { path: '/llm', label: _('Language model'), icon: Brain },
  { path: '/models', label: _('Models'), icon: Boxes },
  { path: '/knowledge', label: _('Knowledge'), icon: BookOpen },
  { path: '/calls', label: _('Calls'), icon: PhoneCall },
];

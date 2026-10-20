import { BookOpen, Boxes, Brain, Gauge, PhoneCall, Users } from '@lucide/svelte';
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
  { path: '/characters', label: _('Characters'), icon: Users },
  { path: '/llm', label: _('Language model'), icon: Brain },
  { path: '/models', label: _('Models'), icon: Boxes },
  { path: '/knowledge', label: _('Knowledge'), icon: BookOpen },
  { path: '/calls', label: _('Calls'), icon: PhoneCall },
];

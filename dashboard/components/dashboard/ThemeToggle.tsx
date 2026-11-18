'use client';

import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

const THEME_CHANGE_EVENT = 'stuflo-theme-change';

function subscribe(onStoreChange: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
}

function currentThemeIsDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

function useThemeToggle() {
  const dark = useSyncExternalStore(subscribe, currentThemeIsDark, () => false);

  function toggleTheme() {
    const next = !dark;
    const root = document.documentElement;
    if (next) root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try {
      localStorage.setItem('stuflo-theme', next ? 'dark' : 'light');
    } catch {}
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  return { dark, toggleTheme };
}

export function ThemeToggleMenuItem({ onToggle }: { onToggle?: () => void }) {
  const { dark, toggleTheme } = useThemeToggle();

  return (
    <button
      type="button"
      className="sf-menu-item"
      onClick={() => {
        toggleTheme();
        onToggle?.();
      }}
    >
      {dark ? <Sun size={16} strokeWidth={1.85} /> : <Moon size={16} strokeWidth={1.85} />}
      {dark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}

export function ThemeToggleSettingsButton() {
  const { dark, toggleTheme } = useThemeToggle();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-base font-medium text-fg1 transition-colors hover:bg-surface-tint"
    >
      {dark ? (
        <Sun className="h-4 w-4" strokeWidth={1.85} />
      ) : (
        <Moon className="h-4 w-4" strokeWidth={1.85} />
      )}
      {dark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}

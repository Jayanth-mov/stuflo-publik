import type { Config } from 'tailwindcss';

const config: Config = {
  // Dark mode is driven by <html data-theme="dark"> (matches the design-system tokens).
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand maroon — replaces the old purple `primary` scale.
        primary: {
          DEFAULT: '#A91D38',
          50: '#FCF2F5',
          100: '#F7E2E8',
          200: '#ECBCC8',
          300: '#DB8298',
          400: '#C94F69',
          500: '#A91D38',
          600: '#8A1730',
          700: '#6E1126',
          800: '#4A0C1A',
          900: '#340810',
        },
        maroon: {
          50: '#FCF2F5', 100: '#F7E2E8', 200: '#ECBCC8', 300: '#DB8298',
          400: '#C94F69', 500: '#BE2B49', 600: '#A91D38', 700: '#8A1730',
          800: '#6E1126', 900: '#4A0C1A', 950: '#340810',
        },
        // Design-system surface/text tokens (dark-aware via CSS vars).
        paper: 'var(--paper)',
        'paper-sunk': 'var(--paper-sunk)',
        surface: 'var(--surface)',
        'surface-tint': 'var(--surface-tint)',
        fg1: 'var(--fg1)',
        fg2: 'var(--fg2)',
        fg3: 'var(--fg3)',
        line: 'var(--border)',
        // Earthy semantics (dark-aware) — for page content. Danger is burnt-orange, never red.
        success: { 100: 'var(--success-100)', 600: 'var(--success-600)' },
        warning: { 100: 'var(--warning-100)', 600: 'var(--warning-600)' },
        danger: { 100: 'var(--danger-100)', 600: 'var(--danger-600)' },
        info: { 100: 'var(--info-100)', 600: 'var(--info-600)' },
      },
      fontFamily: {
        sans: ['var(--font-ui)'],
        serif: ['var(--font-serif)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        base: ['var(--font-body-size)', { lineHeight: '1.5' }],
      },
    },
  },
  plugins: [],
};

export default config;

import type { Config } from 'tailwindcss';

/**
 * Claymorphism palette.
 *
 * Every surface shares the clay base colour and is separated purely by a
 * two-directional shadow (light top-left, dark bottom-right) instead of a
 * border. Keep this in mind when picking colours: a "flat" fill with no clay
 * shadow reads as a hole rather than a raised block.
 */
const primary = {
  25: '#f7f3fc',
  50: '#f0e9fa',
  100: '#e2d5f5',
  200: '#c8b0ec',
  300: '#ad88e0',
  400: '#9a6ed6',
  500: '#8452c9',
  600: '#6b38ab',
  700: '#552a8b',
  800: '#412070',
  900: '#2f1757',
};

const accent = {
  50: '#fdfaec',
  100: '#faf4cc',
  200: '#f4eaa2',
  300: '#ebdd72',
  400: '#ddcb4b',
  500: '#c9b52f',
  600: '#a8951f',
};

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary,
        secondary: { DEFAULT: '#9a6ed6', ...primary },
        accent: { DEFAULT: '#ebdd72', ...accent },
        // The single colour every raised surface is painted with.
        clay: {
          DEFAULT: '#e7eaf3',
          deep: '#dfe3ee',
          dark: '#d5dae8',
        },
        canvas: '#e7eaf3',
        surface: '#e7eaf3',
        ink: {
          DEFAULT: '#33304d',
          muted: '#565377',
          // 11px metadata still has to clear 4.5:1 on the clay canvas (#e7eaf3),
          // so "faint" is a lightness step, not a low-contrast grey.
          faint: '#63607e',
        },
      },
      borderRadius: {
        '4xl': '2rem',
        '3xl': '1.5rem',
        '2xl': '1.25rem',
        xl: '1rem',
        lg: '0.875rem',
        md: '0.75rem',
        sm: '0.625rem',
      },
      boxShadow: {
        // Raised: light highlight up-left, soft shade down-right.
        clay: '9px 9px 20px rgba(163,177,198,0.55), -9px -9px 20px rgba(255,255,255,0.75)',
        'clay-sm': '5px 5px 11px rgba(163,177,198,0.5), -5px -5px 11px rgba(255,255,255,0.7)',
        'clay-xs': '3px 3px 7px rgba(163,177,198,0.45), -3px -3px 7px rgba(255,255,255,0.65)',
        // Pressed: the same pair, turned inward.
        'clay-inset': 'inset 5px 5px 10px rgba(163,177,198,0.55), inset -5px -5px 10px rgba(255,255,255,0.7)',
        'clay-inset-sm': 'inset 3px 3px 7px rgba(163,177,198,0.5), inset -3px -3px 7px rgba(255,255,255,0.65)',
        // Deep shadow pairs only — used for overlays that must float.
        pop: '14px 14px 34px rgba(139,152,178,0.5), -10px -10px 26px rgba(255,255,255,0.6)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.99)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.92)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
        'pop-in': 'pop-in 0.16s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
};

export default config;

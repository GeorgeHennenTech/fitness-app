/** @type {import('tailwindcss').Config} */
// The app's look is driven from here: the `stone` ramp is remapped to the iOS
// dark system grays, so the hundreds of existing `stone-*` classes in App.jsx
// pick up the iOS palette without being rewritten. Type sizes and corner radii
// are likewise shifted to iOS values (17px body, 10–16px corners).
const SYSTEM_FONT = ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Helvetica Neue"', 'system-ui', 'sans-serif'];

export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: SYSTEM_FONT,
        rounded: ['ui-rounded', '"SF Pro Rounded"', ...SYSTEM_FONT],
      },
      colors: {
        stone: {
          50: '#FFFFFF',
          100: '#F2F2F7', // label
          200: '#E5E5EA',
          300: '#D1D1D6',
          400: '#AEAEB2',
          500: '#8E8E93', // secondary label
          600: '#636366', // tertiary label
          700: '#3A3A3C', // elevated fill
          800: '#2C2C2E', // fill / separator
          900: '#1C1C1E', // card (secondary grouped background)
          950: '#000000', // page
        },
        emerald: { 300: '#5EE07F', 400: '#30D158', 500: '#28B14C' }, // system green
        rose: { 300: '#FF6B62', 400: '#FF453A', 500: '#E0352B' }, // system red
        sky: { 300: '#64D2FF', 400: '#0A84FF', 500: '#0071E3' }, // system blue
      },
      fontSize: {
        xs: ['13px', { lineHeight: '18px' }],
        sm: ['15px', { lineHeight: '20px' }],
        base: ['17px', { lineHeight: '22px' }],
        lg: ['20px', { lineHeight: '25px' }],
        xl: ['22px', { lineHeight: '28px' }],
        '2xl': ['28px', { lineHeight: '34px' }],
        '3xl': ['34px', { lineHeight: '41px' }],
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        md: '12px',
        lg: '16px',
        xl: '22px',
        '2xl': '28px',
        '3xl': '34px',
      },
      letterSpacing: {
        wide: '0.01em',
        wider: '0.03em',
        widest: '0.05em',
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        navy: {
          900: '#0A1628',
          800: '#0D1F3C',
          700: '#1A2F52',
        },
        danger: '#C0392B',
        predicted: '#E67E22',
        route: '#1ABC9C',
        citizen: '#F39C12',
        safe: '#27AE60',
      },
    },
  },
  plugins: [],
};

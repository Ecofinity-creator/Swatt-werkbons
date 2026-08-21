/**
 * Bevestigde Swatt-huisstijl: zwarte achtergrond met goudgeel als accentkleur
 * voor de werknemer-UI. `swatt-gold` (#F0B90B) is de werkende waarde — te
 * vervangen zodra Swatt de exacte officiële hex-/Pantone-waarde bevestigt
 * (1 plek om aan te passen).
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'swatt-black': '#0a0a0a',
        'swatt-gold': '#f0b90b',
        'swatt-gold-dark': '#c9970a',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

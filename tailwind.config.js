import colors from 'tailwindcss/colors';
const inkHues=["slate","gray","stone","neutral","red","orange","amber","yellow","lime","green","emerald","teal","cyan","sky","blue","indigo","violet","purple","fuchsia","pink","rose"];
const semanticHues = {
  teal:'accent', orange:'accent', cyan:'info', sky:'info', blue:'info', indigo:'info',
  violet:'violet', purple:'violet', fuchsia:'violet', pink:'danger', rose:'danger', red:'danger',
  amber:'warn', yellow:'warn', lime:'ok', green:'ok', emerald:'ok',
};
const channels = hex => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)).join(' ');
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      textColor: {
        zinc: Object.fromEntries([50,100,200,300,400,500,600,700,800,900,950].map(shade => [shade,
          `rgb(var(--ink-zinc-${shade}, var(--zinc-${shade})) / <alpha-value>)`])),
        ...Object.fromEntries(inkHues.map(hue => [hue, Object.fromEntries(
        [50,100,200,300,400,500,600,700,800,900,950].map(shade => [shade,
          `rgb(var(--ink-${hue}, ${channels(colors[hue][shade])}) / <alpha-value>)`]),
      )])),
      },
      colors: {
        zinc: Object.fromEntries([50,100,200,300,400,500,600,700,800,900,950].map(shade => [shade, `rgb(var(--zinc-${shade}) / <alpha-value>)`])),
        // Redesign: every Tailwind hue collapses onto the semantic palette so bg-/border-/ring-
        // utilities agree with the text colours above and with the CSS tokens in index.css.
        // teal/cyan-ish brand → copper accent · sky/blue/indigo → info · violet/purple → AI ·
        // red/rose/pink → danger · amber/yellow → caution · green/emerald/lime → ok.
        ...Object.fromEntries(Object.entries(semanticHues).map(([hue, token]) => [hue,
          Object.fromEntries([50,100,200,300,400,500,600,700,800,900,950].map(shade => [shade, `rgb(var(--${token}-rgb) / <alpha-value>)`]))])),
      },
    },
  },
  plugins: [],
}

const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const autoprefixer = require('autoprefixer');
const fs = require('node:fs');

const css = fs.readFileSync('src/styles/legacy/index.css', 'utf8');
postcss([tailwindcss({ config: './tailwind.legacy.config.js' }), autoprefixer])
  .process(css, { from: 'src/styles/legacy/index.css' })
  .then((result) => {
    fs.writeFileSync('/tmp/legacy.css', result.css);
    console.log('built /tmp/legacy.css', result.css.length, 'bytes');
  })
  .catch((err) => { console.error(err); process.exit(1); });

const fs = require('fs');

// Tailwind reads watched content files while rebuilding CSS. On Windows a
// delete emits change before unlink, so the read can lose the race and throw
// ENOENT. Vite then shows that as a CSS overlay. A missing content file has
// no classes to contribute. Other missing-file reads still throw.
const readFile = fs.promises.readFile.bind(fs.promises);
fs.promises.readFile = function readTailwindContent(path, options) {
  const stack = new Error().stack || '';
  const tailwindContentRead = stack.includes('tailwindcss');
  return readFile(path, options).catch((error) => {
    if (
      tailwindContentRead &&
      error &&
      error.code === 'ENOENT' &&
      typeof path === 'string' &&
      /[/\\]src[/\\].*\.(?:tsx?|jsx?|html|vue|svelte|mdx?)$/i.test(path)
    ) {
      return '';
    }
    throw error;
  });
};

module.exports = {
  plugins: {
    tailwindcss: { config: './tailwind.legacy.config.js' },
    autoprefixer: {},
  },
};

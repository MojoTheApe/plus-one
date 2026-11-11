import fs from 'node:fs/promises';
// Resolve the two explicit browser assets to their original files for Node.
// Only import specifiers change; the tested renderer is the shipped source.
let source = await fs.readFile(new URL('../web/occupiers/absorption.js', import.meta.url), 'utf8');
source = source.replace("'./art.js'", JSON.stringify(new URL('../web/occupiers/art.js', import.meta.url).href))
  .replace("'./absorption-core.js'", JSON.stringify(new URL('../src/occupiers/absorption-core.js', import.meta.url).href));
export const { AbsorptionView } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

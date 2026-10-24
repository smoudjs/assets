// The sandbox as JavaScript: the same actions as assets.json, called one by one.
// Run: npm run sandbox:js

import { copy, formatReport, image, json, xml } from '../dist/index.js';

const source = 'tests/assets';
const destination = 'sandbox/compiled';

async function main() {
  const results = [
    await json({ source, destination }),
    await xml({ source, destination }),
    await image({ source, destination, format: 'webp', quality: 80 }),
    await copy({ source: { include: `${source}/spine`, exclude: ['*.json', '*.png'] }, destination: `${destination}/spine` })
  ];
  for (const result of results) console.log(formatReport(result));
}

await main();

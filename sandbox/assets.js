// The sandbox as JavaScript: the same actions as assets.json, called one by one through the public API.
// Run: npm run sandbox:js

import {
  atlas,
  audio,
  audiosprite,
  bitmapfont,
  formatReport,
  gltf,
  image,
  json,
  meshopt,
  spine,
  xml
} from '../dist/index.js';

const source = 'tests/assets';
const destination = 'sandbox/compiled-js';

async function main() {
  // no destination: the rasterized icons stay in memory and go straight into the atlas, like "#icons" in assets.json
  const icons = await image.process({ source: `${source}/images/ui/icons`, format: 'png', density: 144 });

  const results = [
    // the Spine skeleton .json is left to the spine action below
    await json.process({ source: { include: source, exclude: [`${source}/spine`] }, destination }),
    await xml.process({ source, destination }),
    await atlas.process({ source: `${source}/sprites`, destination, extrude: 1 }),
    await atlas.process({
      source: `${source}/tiles`,
      destination: `${destination}/atlases`,
      trim: false,
      extrude: 2,
      powerOfTwo: true
    }),
    icons,
    await atlas.process({ source: icons.outputs, destination, padding: 4 }),
    await audio.process({
      source: { include: `${source}/audio/music`, when: { duration: '>1' } },
      destination: `${destination}/audio/music`,
      format: 'ogg',
      quality: 70
    }),
    await audiosprite.process({
      source: `${source}/audio/sfx`,
      destination: `${destination}/audio`,
      channels: 1,
      quality: 60
    }),
    await audiosprite.process({
      source: `${source}/audio/sfx`,
      destination: { folder: `${destination}/audio`, filename: '[name]-phaser[ext]' },
      format: 'ogg',
      data: 'phaser'
    }),
    await gltf.process({ source: `${source}/models/crate`, destination: `${destination}/models/crate`, format: 'glb' }),
    await gltf.process({
      source: `${source}/models/crate.glb`,
      destination: `${destination}/models/extracted`,
      textures: { extract: true, format: 'webp' }
    }),
    await gltf.process({
      source: `${source}/models/sphere.glb`,
      destination: { folder: `${destination}/models/lods`, filename: '[name]_lod0' }
    }),
    await gltf.process({
      source: `${source}/models/sphere.glb`,
      destination: { folder: `${destination}/models/lods`, filename: '[name]_lod1' },
      simplify: { ratio: 0.25 }
    }),
    await meshopt.process({
      source: (await gltf.process({ source: `${source}/models/crate.glb` })).outputs,
      destination: `${destination}/models/compressed`
    }),
    await spine.process({
      source: `${source}/spine`,
      destination: `${destination}/spine`,
      format: 'webp',
      animations: { exclude: ['debug/*'] }
    }),
    await bitmapfont.process({
      source: `${source}/fonts/NotoSans-Regular.ttf`,
      destination: `${destination}/fonts`,
      characters: 'Play Again!',
      size: 48,
      outline: { width: 3 },
      shadow: { x: 2, y: 3 }
    }),
    await bitmapfont.process({
      source: `${source}/fonts/NotoSansCFF-Regular.otf`,
      destination: { folder: `${destination}/fonts`, filename: 'score[ext]' },
      characters: '0123456789',
      size: 64,
      color: '#ffd400',
      outline: { width: 4, color: '#7a3b00' },
      format: 'webp',
      data: 'text'
    }),
    // a .fnt in memory brings its page along, like "#bitmap" in assets.json
    await bitmapfont.process({
      source: (
        await bitmapfont.process({
          source: `${source}/fonts/NotoSans-Regular.ttf`,
          characters: 'Play Again!0123456789'
        })
      ).outputs,
      destination: `${destination}/fonts/digits`,
      characters: '0123456789'
    }),
    // "#rest" exists only in a build; here the folders handled above are excluded by hand. The crate's texture
    // belongs to its .gltf and the Spine page to its .atlas, so models and spine are left out too
    await image.process({
      source: {
        include: source,
        exclude: [`${source}/sprites`, `${source}/tiles`, `${source}/images/ui/icons`, `${source}/models`, `${source}/spine`]
      },
      destination
    })
  ];
  console.log(formatReport(results, { verbose: true }));
}

await main();

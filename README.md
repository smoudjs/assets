# @smoud/assets

[![npm version](https://img.shields.io/npm/v/@smoud/assets.svg)](https://www.npmjs.com/package/@smoud/assets)
[![npm downloads](https://img.shields.io/npm/dw/@smoud/assets.svg)](https://www.npmjs.com/package/@smoud/assets)
[![license](https://img.shields.io/npm/l/@smoud/assets.svg)](https://github.com/smoudjs/assets/blob/main/LICENSE)

**One config. One command. All your game assets optimized.**

`@smoud/assets` takes a folder of source assets and a small `assets.json`, and writes an optimized output folder: images resized, converted and compressed, sprites packed into texture atlases, data files minified, everything else copied. Built for HTML5 games, WebGL and playable ads. Engine-agnostic: the output is plain files that PixiJS, Phaser, Three.js, Cocos or your own loader can read.

Every action is `source → process → destination`. Written in JSON or called from JavaScript, it is the same thing.

## Features

- 🖼️ **Images**: resize, trim, convert and compress with [Sharp](https://sharp.pixelplumbing.com) (png, jpeg, webp, avif, gif, svg). Try several formats and keep the smallest. Never ship a file that got bigger.
- 🧩 **Texture atlases**: MaxRects packing, trimming, extrusion, multipage, TexturePacker-compatible JSON. No extra dependency.
- 📄 **Data files**: json and xml minified.
- 🎯 **Explicit selection**: folders, globs, `#rest`, size and dimension filters. Nothing happens by accident.
- 🔗 **Chaining**: virtual `#folders` pass results from one action to the next, for example rasterize svg icons, then pack them.
- 🧱 **Presets**: reusable sets of actions and defaults, built in or your own JSON.
- 🛡️ **Safe builds**: results are staged and committed at once. A failed build leaves the previous output untouched.
- 📦 **One dependency** (Sharp), Node 20+, ESM and CommonJS, a CLI and a programmatic API.

## Installation

```sh
npm install --save-dev @smoud/assets
```

## Quick Start

1. Put your source assets in `assets/`:

   ```
   assets/
   ├─ sprites/
   │  ├─ hero/idle_01.png
   │  └─ coin/coin_01.png
   ├─ ui/
   │  ├─ logo.png
   │  └─ icons/star.svg
   ├─ backgrounds/sky.jpg
   └─ data/levels.json
   ```

2. Create `assets.json` next to `package.json`:

   ```json
   {
     "actions": [
       { "action": "atlas", "source": "sprites" },
       { "action": "image", "source": "ui", "format": "webp", "quality": 80 },
       { "action": "image", "source": "#rest" },
       { "action": "json" },
       { "action": "copy", "source": "#rest" }
     ]
   }
   ```

3. Run the build:

   ```sh
   npx smoud-assets build
   ```

4. Use the result from `assets/compiled/`:

   ```
   assets/compiled/
   ├─ sprites.png
   ├─ sprites.json
   ├─ ui/
   │  └─ logo.webp
   ├─ backgrounds/sky.jpg
   └─ data/levels.json
   ```

The report tells you what happened to every file:

```
smoud-assets v0.0.1

 #1  atlas, source "sprites"        4 files    88.1 KB → 41.6 KB  -53%
 #2  image, source "ui"             1 file     12.4 KB → 4.1 KB   -67%
 #3  image, source "#rest"          1 file    310.2 KB → 198.7 KB  -36%
 #4  json                           1 file      2.1 KB → 1.4 KB   -33%
 #5  copy, source "#rest"           1 file      1.0 KB → 1.0 KB   ±0%

Total                               8 files   413.8 KB → 246.8 KB  -40%
1 file not selected by any action

warning: action 2 (image, source "ui"): ui/icons/star.svg: svg and other vector sources need a raster "format"; skipped

Done in 412 ms  → assets/compiled
```

Add `--verbose` for one line per file.

## Guide

### Config file

`assets.json` lives in the project root. Folders in it are relative to the file.

```json
{
  "source": "assets",
  "destination": "assets/compiled",
  "exclude": ["**/*.psd", "raw"],
  "defaults": {
    "image": { "quality": 80 }
  },
  "actions": ["image", "copy"],
  "clean": true
}
```

| Key           | Description                                                                                                             | Default           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `source`      | Base folder with the source assets. Always a folder, never a pattern.                                                   | `assets`          |
| `destination` | Base output folder. Always a folder. Must not be the source, contain it, or be the project root.                        | `assets/compiled` |
| `exclude`     | Pattern or list of patterns that no action can select. The destination folder, dot files and `node_modules` are always skipped. | none              |
| `defaults`    | Starting options per action type, e.g. `{ "image": { "quality": 80 } }`. Options written on an action win.             | none              |
| `actions`     | The list of actions, run top to bottom. Omitted: the built-in `default` preset.                                         | preset `default`  |
| `clean`       | Remove files from the destination that this build did not produce.                                                     | `true`            |

The config can also be JavaScript (`assets.js`, `.mjs` or `.cjs`) exporting the same object:

```js
import { defineConfig } from '@smoud/assets';

export default defineConfig({
  actions: [{ action: 'image', source: 'ui', format: 'webp' }, { action: 'copy', source: '#rest' }]
});
```

Run it with `npx smoud-assets build --config assets.js`.

### Actions

An action is one line of the pipeline: which files, what to do with them, where to put them.

```json
{ "action": "image", "source": "ui", "destination": "interface", "format": "webp", "quality": 80 }
```

| Key           | Description                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `action`      | The action type: `image`, `atlas`, `json`, `xml`, `copy`.                                         |
| `source`      | What to select. Omitted: every file under the base source folder that the type can handle.       |
| `destination` | Where results go. Omitted: mirror the source tree.                                               |
| anything else | Options of the action type, flat on the object. See the [Actions reference](#actions-reference). |

A plain string is an action type with default settings and no `source`: `"image"` equals `{ "action": "image" }`.

Unknown keys produce a warning with a suggestion (`unknown option "qualty", did you mean "quality"?`); wrong values are errors.

#### Order matters

Actions run top to bottom. Each action selects its files on its own, so the same source file can go through two actions, for example full size and a half-size copy. Two actions writing the same output path is an error, and nothing is written.

### Source

`source` says which files an action takes. Patterns are relative to the base source folder.

| Form                             | Meaning                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `"ui"`                           | A folder: everything under it.                                                                              |
| `"ui/logo.png"`                  | A single file.                                                                                              |
| `"ui/**/*.png"`                  | A glob ([picomatch](https://github.com/micromatch/picomatch) syntax).                                       |
| `"*.json"`                       | A pattern without a slash matches by file name at any depth, like `.gitignore`.                             |
| `["ui", "hud/**/*.png"]`         | Several patterns.                                                                                           |
| `"#rest"`                        | Every file the actions above have not taken.                                                                |
| `"#icons"`, `"#icons/small/**"`  | A virtual folder produced by an action above, or part of it. See [Chaining](#chaining-with-virtual-folders). |
| `{ "include", "exclude", "when" }` | The long form: patterns to include, patterns to leave out, and a filter on file facts.                    |

Every action only takes files its type can handle: `image` never selects a `.json`, `json` never selects a `.png`. `copy` takes anything.

```json
{
  "action": "image",
  "source": {
    "include": ["ui", "hud"],
    "exclude": ["*.psd", "ui/raw"],
    "when": { "alpha": false, "size": ">200kb" }
  },
  "format": "jpeg"
}
```

#### `when` filters

| Fact       | Values                                                 | Example                      |
| ---------- | ------------------------------------------------------ | ---------------------------- |
| `size`     | File size with unit: `b`, `kb`, `mb`, `gb`.            | `">200kb"`, `["<2mb", ">10kb"]` |
| `width`    | Image width in pixels.                                 | `">=1024"`                   |
| `height`   | Image height in pixels.                                | `"<512"`                     |
| `alpha`    | `true` or `false`: has a transparent channel.          | `false`                      |
| `animated` | `true` or `false`: has more than one frame.            | `true`                       |

Comparisons: `>`, `>=`, `<`, `<=`, `!=`, `=` or a bare number for equality. A list means every bound must hold. `width`, `height`, `alpha` and `animated` are read from the file by the action type (`image` does this); `size` is always known.

#### `#rest`

`#rest` is the remainder: whatever the actions above it have not taken. Put it last, or let two `#rest` actions share the leftovers in order:

```json
{
  "actions": [
    { "action": "atlas", "source": "sprites" },
    { "action": "image", "source": { "include": "#rest", "when": { "size": ">200kb" } }, "quality": 70 },
    { "action": "image", "source": "#rest" },
    { "action": "copy", "source": "#rest" }
  ]
}
```

Here big images are compressed harder, the other images get default settings, and every non-image file is copied. A file that no action takes is listed in the report as "not selected".

### Destination

`destination` says where the results of an action go, relative to the base destination folder.

| Form                                       | Meaning                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| omitted                                    | Mirror the source tree: `ui/buttons/play.png` stays `ui/buttons/play.png`.                      |
| `"interface"`                              | A folder. The path below the pattern's folder is kept: `ui/buttons/play.png` → `interface/buttons/play.png`. |
| `"#icons"`, `"#icons/small"`               | A virtual folder, kept in memory for a later action. Nothing is written.                        |
| `{ "folder": "ui", "filename": "[name].[hash:8][ext]" }` | A folder plus a filename template.                                                 |
| `["ui", "#ui"]`                            | Several destinations: the results are written to each.                                          |

Filename templates know `[name]`, `[ext]` (with the dot), `[hash]` (8 characters of the content hash) and `[hash:n]`. The default is `[name][ext]`. Group outputs such as an atlas land at the root of the destination, or in the given folder.

### Chaining with virtual folders

A `#name` destination keeps results in memory instead of writing them. An action below can read them as its source. This is how one action's output becomes another's input:

```json
{
  "actions": [
    { "action": "image", "source": "ui/icons", "format": "png", "density": 144, "destination": "#icons" },
    { "action": "atlas", "source": "#icons", "padding": 4 }
  ]
}
```

The svg icons are rasterized at 144 dpi, then packed into `icons.png` + `icons.json`, named after the virtual folder. A virtual folder must be produced above the action that reads it; one that nothing reads is a warning.

### Defaults

`defaults` sets starting options per action type for the whole config. An action's own options override them.

```json
{
  "defaults": {
    "image": { "quality": 80, "png": { "palette": true } },
    "atlas": { "extrude": 1 }
  },
  "actions": [
    { "action": "image", "source": "hud", "quality": 90 },
    { "action": "image", "source": "#rest" }
  ]
}
```

### Presets

A preset is a config file with `defaults` and `actions`, nothing else. Use one instead of writing the actions yourself, or as a building block inside your own list:

```json
{
  "actions": [
    { "preset": "default" },
    { "preset": "./presets/retina.json", "source": "hud", "destination": "hud", "defaults": { "image": { "quality": 70 } } }
  ]
}
```

| Key           | Description                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `preset`      | A built-in name, a relative path to a JSON or JS file, or the name of an installed package.                      |
| `source`      | Limits the preset to these files. Inside the preset, paths are relative to this folder.                          |
| `destination` | Prefix for everything the preset writes, a folder or a virtual folder.                                           |
| `defaults`    | Overrides the preset's own `defaults` for this use only.                                                         |

A preset entry takes no other options. When `actions` is omitted entirely, the built-in `default` preset runs. From the command line, `--preset <name>` runs a preset instead of the config file:

```sh
npx smoud-assets build --preset default --source raw --destination public/assets
```

### How a build runs

1. **Select**: every action picks its files from the base source folder, top to bottom.
2. **Process**: each action type turns input files into output files, in memory.
3. **Stage**: outputs are written to `<destination>/.staging`. Two actions producing the same path stop the build here.
4. **Commit**: on success the staged files move into place and, with `clean` on, files from earlier builds that no action produced are removed. On any error the staging folder is deleted and the previous output stays exactly as it was.

Warnings (an action that selected no files, an unknown option, a virtual folder nobody reads) do not stop the build unless `--strict` is given. `--dry-run` goes through all four steps without writing anything.

### Commands

```sh
npx smoud-assets build [options]
```

`build` is the default command, so `npx smoud-assets` alone works too.

| Option                | Description                                                              | Default           |
| --------------------- | ------------------------------------------------------------------------ | ----------------- |
| `--config <file>`     | Config file (`.json`, `.js`, `.mjs`, `.cjs`).                            | `assets.json`     |
| `--source <dir>`      | Base source folder, relative to the working directory.                   | from the config   |
| `--destination <dir>` | Base destination folder, relative to the working directory.              | from the config   |
| `--preset <name>`     | Run a preset instead of the config file.                                 |                   |
| `--strict`            | Warnings count as failure.                                               | off               |
| `--verbose`           | One line per file in the report, and every warning instead of the first ten. | off           |
| `--dry-run`           | Process everything, write nothing.                                       | off               |
| `-h, --help`          | Show help.                                                               |                   |
| `-v, --version`       | Show the version.                                                        |                   |

Exit code `0` means success, `1` a failed build, `2` a usage error. Colours follow `NO_COLOR` and `FORCE_COLOR`.

## Actions reference

### `image`

Accepts `png`, `jpg`, `jpeg`, `webp`, `gif`, `avif`, `tif`, `tiff`, `svg`. One Sharp pipeline per file, always in this order: trim → resize → flatten → encode.

```json
{ "action": "image", "source": "ui", "resize": { "scale": 0.5 }, "format": ["webp", "png"], "quality": 80 }
```

| Option        | Description                                                                                                                                   | Default         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `resize`      | Object, see below. Omitted: no resize.                                                                                                        | none            |
| `trim`        | `true`, or `{ "threshold": n }`: remove borders of the same colour as the top-left pixel, within the colour distance `threshold`.             | `false`         |
| `flatten`     | Background colour (`"#ffffff"`) painted under transparent pixels. jpeg output always flattens; without a colour onto black, with a warning.   | none            |
| `format`      | `png`, `jpeg`, `webp`, `avif`, `gif`, or a list of them: every candidate is encoded and the smallest wins. Omitted: keep the source format.   | source format   |
| `quality`     | 1–100, for lossy encoders and png palette quantization.                                                                                       | `85`            |
| `lossless`    | Lossless encoding where the format supports it (png, webp, avif).                                                                             | `false`         |
| `keepSmaller` | When the file is only re-encoded (no resize, trim or flatten, same format) and the result is bigger, emit the original bytes instead.         | `true`          |
| `metadata`    | Keep EXIF and ICC metadata. Orientation is always applied to the pixels.                                                                      | `false`         |
| `animated`    | Keep gif and webp animations. `false` takes the first frame.                                                                                  | `true`          |
| `density`     | DPI used to rasterize svg sources. 72 gives the svg's own size, 144 doubles it.                                                               | `72`            |
| `png`         | `{ "palette": true, "colors": 256, "dither": 1, "effort": 7 }`: palette quantization (like pngquant), palette size, dithering 0–1, effort 1–10. |                 |
| `jpeg`        | `{ "progressive": false, "mozjpeg": true, "chromaSubsampling": "4:2:0" }`. Subsampling: `4:2:0` or `4:4:4`.                                   |                 |
| `webp`        | `{ "alphaQuality": 100, "nearLossless": false, "smartSubsample": false, "effort": 4 }`. Effort 0–6.                                           |                 |
| `avif`        | `{ "chromaSubsampling": "4:4:4", "effort": 4 }`. Effort 0–9.                                                                                  |                 |
| `gif`         | `{ "colors": 256, "dither": 1, "effort": 7 }`.                                                                                                |                 |

`resize` options:

| Option    | Description                                                                                                   | Default                                     |
| --------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `width`   | Target width in px.                                                                                           |                                             |
| `height`  | Target height in px.                                                                                          |                                             |
| `scale`   | Multiply both dimensions: `0.5` halves the image. Wins over `width` and `height`.                            |                                             |
| `fit`     | How to fit `width` and `height`: `cover`, `contain`, `fill`, `inside`, `outside`.                            | `cover` with both given, otherwise `inside` |
| `upscale` | Allow enlarging. With `scale` above 1 enlarging is on unless set to `false`.                                  | `false`                                     |
| `kernel`  | Resampling kernel: `nearest` (pixel art), `cubic`, `mitchell`, `lanczos2`, `lanczos3`.                        | Sharp's default (`lanczos3`)                |

Notes:

- The output extension follows the format: `jpeg` writes `.jpg`.
- With a format list, `jpeg` is skipped for images with alpha unless `flatten` is set.
- svg sources need a raster `format`; otherwise they are skipped with a warning.
- An animated source converted to a format that cannot hold animation (png, jpeg, avif) keeps its first frame.

### `atlas`

Accepts `png`, `jpg`, `jpeg`, `webp`, `gif` (first frame), `avif`, `tif`, `tiff`. Packs all selected files into one or more pages and writes a JSON per page in the TexturePacker "JSON hash" format, which PixiJS, Phaser, Babylon.js, PlayCanvas and most other runtimes load directly.

```json
{ "action": "atlas", "source": "sprites", "maxWidth": 2048, "maxHeight": 2048, "padding": 2, "extrude": 1 }
```

| Option       | Description                                                                                                                | Default              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `name`       | Atlas name, used for the files: `name.png`, `name.json`.                                                                   | the selected folder  |
| `maxWidth`   | Widest page in px. Sprites that do not fit go to a second page.                                                            | `2048`               |
| `maxHeight`  | Tallest page in px.                                                                                                        | `2048`               |
| `padding`    | Empty px between sprites and to the page edge.                                                                             | `2`                  |
| `extrude`    | Repeat the edge pixels of every sprite this many px outwards, against bleeding when textures are scaled or filtered.        | `0`                  |
| `trim`       | Cut transparent borders. Frames remember the original size and offset, so sprites keep their pivot.                         | `true`               |
| `powerOfTwo` | Round page sizes up to a power of two.                                                                                     | `false`              |
| `format`     | Page format: `png`, `jpeg`, `webp`, `avif`.                                                                                | `png`                |
| `quality`    | 1–100, for jpeg, webp and avif pages. png pages are lossless.                                                              | `85`                 |

Output for `"source": "sprites"` is `sprites.png` + `sprites.json` at the destination root (or in the given `destination` folder). Frame names are the paths below the selected folder without extension: `hero/idle_01`, `coin/coin_01`.

```json
{
  "frames": {
    "hero/idle_01": {
      "frame": { "x": 2, "y": 2, "w": 55, "h": 55 },
      "rotated": false,
      "trimmed": true,
      "spriteSourceSize": { "x": 5, "y": 5, "w": 55, "h": 55 },
      "sourceSize": { "w": 64, "h": 64 }
    }
  },
  "meta": { "image": "sprites.png", "format": "RGBA8888", "size": { "w": 128, "h": 64 }, "scale": "1" }
}
```

When the sprites do not fit one page, the pages are numbered, `sprites_1.png` + `sprites_1.json`, `sprites_2.png` + `sprites_2.json`, each JSON lists the others under `meta.related_multi_packs`, and the report warns about it. Pages are shrunk to their content, frames are never rotated, and the same input always produces identical bytes. A `filename` template with `[hash]` gives the page and its JSON the same hash. Frames are pixel copies of the sources; a frame cut back out of the page equals the trimmed sprite exactly.

To pack svg icons, rasterize them first through a virtual folder, see [Chaining](#chaining-with-virtual-folders).

### `json`

Accepts `json`. Parses and re-serializes without whitespace. An invalid file fails the build. No options.

### `xml`

Accepts `xml`. Removes whitespace between tags and around the document. Text inside elements and CDATA sections are left exactly as written.

| Option     | Description     | Default |
| ---------- | --------------- | ------- |
| `comments` | Keep comments.  | `false` |

### `copy`

Accepts every file. Copies it unchanged. No options.

## API

```js
import { build, formatReport, defineConfig, image, atlas, json, xml, copy, version } from '@smoud/assets';
```

CommonJS works the same way with `require('@smoud/assets')`. Types are included.

### `build(options?)`

Runs a whole config and returns a `BuildResult`. Never throws for problems inside the build; those end up in `result.errors`. It does throw for a broken setup: a missing source folder, an unreadable config file, a destination that would overwrite the source.

```js
const result = await build({ config: 'assets.json', strict: true });
console.log(formatReport(result, { verbose: true }));
if (!result.ok) process.exit(1);
```

| Option        | Description                                                                                             | Default                         |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `config`      | A config object (the same shape as the JSON) or a path to a config file.                                | `assets.json` in `cwd`, if present |
| `cwd`         | Folder that relative paths resolve from.                                                                | `process.cwd()`                 |
| `source`      | Override the base source folder, like `--source`.                                                       |                                 |
| `destination` | Override the base destination folder, like `--destination`.                                             |                                 |
| `dryRun`      | Process everything, write nothing.                                                                      | `false`                         |
| `strict`      | Warnings make `result.ok` false.                                                                        | `false`                         |
| `concurrency` | Files processed at the same time inside one action.                                                     | CPU count minus one             |
| `types`       | Extra action types, see [Custom action types](#custom-action-types).                                    |                                 |

`BuildResult`:

| Field         | Description                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `ok`          | No errors, and no warnings when `strict`.                                                           |
| `dryRun`      | Whether anything was written.                                                                       |
| `source`      | Absolute base source folder.                                                                        |
| `destination` | Absolute base destination folder, `null` for an in-memory standalone call.                          |
| `actions`     | One entry per action: `index`, `label`, `type`, `selected`, `files`, `bytesIn`, `bytesOut`, `duration`. Each file result has `source`, `outputs`, `bytesIn`, `bytesOut`, `keptOriginal`. |
| `unselected`  | Source files no action took.                                                                        |
| `warnings`    | Messages that did not stop the build.                                                               |
| `errors`      | Messages that did. Nothing is written when this is not empty.                                       |
| `outputs`     | Result files of an in-memory standalone call: `{ path, data, meta }`.                               |
| `virtual`     | Every virtual folder the build produced, by name.                                                   |
| `duration`    | Milliseconds.                                                                                       |

### `formatReport(result, options?)`

The terminal report the CLI prints, as a string. Options: `verbose` (one line per file) and `version` (shown in the first line).

### `defineConfig(config)`

Returns the config unchanged. Gives JavaScript config files autocomplete and type checking.

### `image()`, `atlas()`, `json()`, `xml()`, `copy()`

One action on its own, without a config. The argument is the same object as one JSON action, minus `action`. `source` is required and relative to the working directory; absolute paths work too.

```js
// write to a folder: results land at its root, the tree below the pattern's folder is kept
await image({ source: 'assets/ui', destination: 'public/ui', format: 'webp', quality: 80 });
await atlas({ source: 'assets/sprites', destination: 'public', extrude: 1 });

// no destination: results stay in memory
const { outputs } = await copy({ source: 'assets/data' });
for (const file of outputs) console.log(file.path, file.data.length);
```

Standalone calls never delete other files in their destination folder, so several of them can share one.

### Custom action types

An action type is an object with a name, the extensions it accepts, an option table and a `process` function that turns files into files. It never touches the disk; finding, filtering and writing belong to the engine.

```js
import { build } from '@smoud/assets';

const upper = {
  name: 'upper',
  version: '1',
  accepts: ['txt'],
  options: {
    suffix: { kind: 'string', description: 'Appended to the file name', default: '' }
  },
  async process(files, options, context) {
    return files.map((file) => ({
      ...file,
      path: file.path.replace(/\.txt$/, `${options.suffix}.txt`),
      data: Buffer.from(file.data.toString().toUpperCase())
    }));
  }
};

await build({
  config: { actions: [{ action: 'upper', source: 'texts', suffix: '-loud' }] },
  types: { upper }
});
```

`process` receives `AssetFile` objects (`path` relative to the selected folder, `data`, `meta`) and a context with `warn(message)`, `fail(file, message)`, `concurrency`, `folder` (the selected folder's name) and `filename(file)` (the name an output gets on disk). Return the input object spread into the output to keep the link between them; outputs without that link are group outputs, like atlas pages, and land at the destination root. An optional `probe(file)` fills `width`, `height`, `alpha` and `animated` so that `when` filters work for your type.

Option kinds for the table: `boolean`, `number` (with `min`, `max`), `string`, `enum` (with `values`), `object` (with `properties`), `list` (with `items`), `oneOf` (with `oneOf` alternatives). Each descriptor takes a `description` and a `default`.

## Issues

Found a bug or missing something? [Open an issue](https://github.com/smoudjs/assets/issues).

## License

[MIT](LICENSE)

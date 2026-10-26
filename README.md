# @smoud/assets

[![npm version](https://img.shields.io/npm/v/@smoud/assets.svg)](https://www.npmjs.com/package/@smoud/assets)
[![npm downloads](https://img.shields.io/npm/dw/@smoud/assets.svg)](https://www.npmjs.com/package/@smoud/assets)
[![license](https://img.shields.io/npm/l/@smoud/assets.svg)](https://github.com/smoudjs/assets/blob/main/LICENSE)

**One config. One command. All your game assets optimized.**

`@smoud/assets` turns a folder of source assets into an optimized output folder. Images are resized, converted and compressed, sprites are packed into texture atlases, data files are minified, and everything else is copied. It is built for HTML5 games, WebGL and playable ads. The output is plain files that PixiJS, Phaser, Three.js, Cocos or your own loader can read.

Use it two ways:

- **A JSON config** and one command, for the whole project.
- **A JavaScript API**, for one action at a time, or for the raw functions behind them.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [The config file](#the-config-file)
  - [Presets](#presets)
- [Command line](#command-line)
- [Action reference](#action-reference): image, atlas, json, xml, copy
- [JavaScript API](#javascript-api)
  - [Your own actions](#your-own-actions)

## Features

- 🖼️ **Images**: resize, trim, convert and compress with [Sharp](https://sharp.pixelplumbing.com). Try several formats and keep the smallest. A file never gets bigger.
- 🧩 **Texture atlases**: MaxRects packing, trimming, extrusion, several pages, TexturePacker-compatible JSON.
- 📄 **Data files**: JSON and XML minified.
- 🎯 **Explicit selection**: folders, globs, `#rest`, filters on size and image facts.
- 🔗 **Chaining**: virtual `#folders` pass results from one action to the next, for example rasterize svg icons, then pack them.
- 🛡️ **Safe builds**: a failed build leaves the previous output untouched.
- 🧰 **Toolkit**: every action and its raw function is available from code, and you can register your own.

## Quick start

Install:

```sh
npm install --save-dev @smoud/assets
```

Put your source assets in `assets/`:

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

Create `assets.json` next to `package.json`:

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

Run the build:

```sh
npx smoud-assets build
```

The result is in `assets/compiled/`:

```
assets/compiled/
├─ sprites.png
├─ sprites.json
├─ ui/logo.webp
├─ backgrounds/sky.jpg
└─ data/levels.json
```

## The config file

`assets.json` lives in the project root. Folders in it are relative to the file.

```json
{
  "preset": "playable",
  "source": "assets",
  "destination": "assets/compiled",
  "ignore": ["**/*.psd", "raw"],
  "defaults": {
    "image": { "quality": 80 }
  },
  "actions": [
    { "action": "atlas", "source": "sprites" }
  ],
  "clean": true
}
```

| Key           | What it does                                                                      | Default                               |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
| `preset`      | A base config yours extends, see [Presets](#presets).                             | `default` when there are no `actions` |
| `source`      | Folder with your source assets.                                                   | `assets`                              |
| `destination` | Output folder. Must not be the source folder, contain it, or be the project root. | `assets/compiled`                     |
| `ignore`      | Files the build never sees. Dot files and `node_modules` are always ignored.      | none                                  |
| `defaults`    | Starting options per action, see [Defaults](#defaults).                           | none                                  |
| `actions`     | The list of actions, run top to bottom.                                           | none                                  |
| `clean`       | Remove files from the destination that this build did not produce.                | `true`                                |
| `cache`       | Reuse earlier results for unchanged files.                                        | `false`, `true` for `watch`           |

`source` and `destination` are always folders, never patterns. The command line flags `--source` and `--destination` override them.

With `cache` on, results are kept in `node_modules/.cache/smoud-assets` and reused as long as the file, the options and the action stay the same. Entries older than 30 days are removed, and when the cache passes 1 GB the oldest go until half is left.

### Actions

Each entry in `actions` is one step: which files, what to do, where to put the result.

```json
{ "action": "image", "source": "ui", "destination": "interface", "format": "webp", "quality": 80 }
```

| Key           | What it does                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| `action`      | The action name: `image`, `atlas`, `json`, `xml`, `copy`, or one you registered. |
| `source`      | Which files. Omitted: every file the action can handle.                          |
| `destination` | Where the results go. Omitted: each result lands where its source was.           |
| anything else | Options of the action, see [Action reference](#action-reference).                |

A plain string is an action with default settings: `"image"` equals `{ "action": "image" }`.

Actions run top to bottom, and each one selects its files on its own. The same file can go through two actions, for example once at full size and once at half size. Two actions writing the same output path is an error.

A misspelled key is a warning with a hint, `unknown option "qualty", did you mean "quality"?`. A wrong value is an error.

### Source

`source` says which files an action takes. Patterns are relative to the source folder.

| Form                               | Selects                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `"ui"`                             | Everything in the folder `ui`.                                          |
| `"ui/logo.png"`                    | One file.                                                               |
| `"ui/**/*.png"`                    | A glob, in [picomatch](https://github.com/micromatch/picomatch) syntax. |
| `"*.json"`                         | A pattern without a slash matches the file name at any depth.           |
| `["ui", "hud/**/*.png"]`           | Several patterns.                                                       |
| `"#rest"`                          | Every file the actions above have not taken.                            |
| `"#icons"`                         | A virtual folder, see [Virtual folders](#virtual-folders).              |
| `{ "include", "exclude", "when" }` | The long form, with patterns to leave out and a filter.                 |

An action only takes files it can handle. `image` never selects a `.json`, and `copy` takes anything.

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

**`when`** filters on facts about a file. `size` is known for every file. Other facts come from the action that selects: `image` knows `width`, `height`, `alpha` and `animated`.

| Fact       | Example                         | Meaning                                |
| ---------- | ------------------------------- | -------------------------------------- |
| `size`     | `">200kb"`, `["<2mb", ">10kb"]` | File size, with `b`, `kb`, `mb`, `gb`. |
| `width`    | `">=1024"`                      | Width in pixels.                       |
| `height`   | `"<512"`                        | Height in pixels.                      |
| `alpha`    | `false`                         | Has transparency.                      |
| `animated` | `true`                          | Has more than one frame.               |

Comparisons are `>`, `>=`, `<`, `<=`, `!=`, `=`, or a bare number for equality. In a list, every bound must hold. A fact the action cannot read excludes the file, with a warning.

**`#rest`** takes what is left. Several `#rest` actions share the leftovers in order:

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

Big images are compressed harder, other images get the default settings, and everything else is copied. A file no action takes is listed in the report as not selected.

### Destination

`destination` says where results go, relative to the destination folder.

| Form                                                          | Result for the source `ui/buttons/play.png`, selected by `"ui"`             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| omitted                                                       | `ui/buttons/play.png`, where it was.                                        |
| `"interface"`                                                 | `interface/buttons/play.png`. The folder replaces `ui`.                     |
| `"#buttons"`                                                  | Kept in memory for a later action, see [Virtual folders](#virtual-folders). |
| `{ "folder": "interface", "filename": "[name].[hash][ext]" }` | `interface/buttons/play.1a2b3c4d.png`.                                      |

Filename templates know `[name]`, `[ext]` with the dot, `[hash]` for 8 characters of the content hash, and `[hash:n]` for n characters. The default is `[name][ext]`.

Results that stand for many files, like an atlas page, land at the root of the destination folder, or in the folder you give.

### Virtual folders

A destination starting with `#` keeps the results in memory instead of writing them. An action further down reads them back with the same name as its source:

```json
{
  "actions": [
    { "action": "image", "source": "ui/icons", "format": "png", "density": 144, "destination": "#icons" },
    { "action": "atlas", "source": "#icons", "padding": 4 }
  ]
}
```

The svg icons are rasterized at 144 dpi, then packed into `icons.png` and `icons.json`, named after the virtual folder. A virtual folder must be produced above the action that reads it. A virtual folder nothing reads is a warning.

In the report, an action that writes to a virtual folder shows its size change dimmed, followed by `→ #icons`. Those bytes never reach disk, so the total leaves them out.

### Defaults

`defaults` sets starting options per action for the whole config. Options written on an action win.

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

Every key in `defaults` must be an action name. An unknown name is an error.

### Presets

A preset is a base config yours extends. It is a JSON file with only `defaults` and `actions`:

```json
{
  "preset": "playable",
  "defaults": {
    "image": { "quality": 60 }
  },
  "actions": [
    { "action": "atlas", "source": "sprites" }
  ]
}
```

The rules:

1. **`defaults`** are merged, and yours win key by key. In the example the preset's atlas quality applies to your atlas, and your image quality of 60 replaces the preset's.
2. **`actions`:** yours run first. The preset's actions then only see the files yours did not take. Above, the atlas takes `sprites`, and the preset handles everything else.
3. **No `preset` and no `actions`:** the built-in `default` preset runs.

`preset` takes a built-in name, a path to a JSON file, or the name of an installed package. On the command line, `--preset` sets it and wins over the config's own.

**Built-in presets:**

| Preset         | What it does                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`      | Compresses images in their own format, minifies json and xml, copies everything else, svg included.                                                                                            |
| `playable`     | For playable ads. Images are shrunk to fit 2048×2048, opaque png becomes jpeg, quality 70, or 50 for files over 400 KB. Atlases default to quality 70. Then json, xml and copy like `default`. |
| `playable-max` | Like `playable`, with stronger compression: every png becomes webp, quality 60, or 45 for files over 400 KB. Atlas pages default to webp at quality 60.                                        |

### How a build runs

1. Every action selects its files, top to bottom.
2. Every action processes its files in memory.
3. Results are written to `<destination>/.staging`.
4. When nothing failed, the staged files move into the destination. With `clean` on, files no action produced are removed.

If anything fails, the staging folder is deleted and the destination stays exactly as it was. Warnings do not stop a build unless you pass `--strict`. With `--dry-run` nothing is written to the destination. The cache, when on, is still filled.

## Command line

```sh
npx smoud-assets build [options]   # build once
npx smoud-assets watch [options]   # build, then rebuild on every change
npx smoud-assets init [options]    # write a starter assets.json
```

`watch` follows the source folder, the config and a preset file.

| Option                | What it does                                                   |
| --------------------- | -------------------------------------------------------------- |
| `--config <file>`     | Config file. Without it, `assets.json` is used when it exists. |
| `--source <dir>`      | Source folder. Wins over the config.                           |
| `--destination <dir>` | Destination folder. Wins over the config.                      |
| `--preset <name>`     | Preset the config extends.                                     |
| `--strict`            | Warnings count as failure.                                     |
| `--verbose`           | One line per file, and every warning instead of the first ten. |
| `--dry-run`           | Process everything, write nothing.                             |
| `--[no-]cache`        | Use the cache. Off for `build`, on for `watch`.                |
| `-h, --help`          | Show help.                                                     |
| `-v, --version`       | Show the version.                                              |

```sh
npx smoud-assets build --preset default --source raw --destination public/assets
```

The exit code is `0` on success, `1` for a failed build, and `2` for a wrong command. Colours follow `NO_COLOR` and `FORCE_COLOR`.

## Action reference

Each action has the same options in `assets.json` and in code. In code, each action also has a raw function that works on bytes, see [Raw functions](#raw-functions).

### image

Resizes, trims, converts and compresses images. Takes `png`, `jpg`, `jpeg`, `webp`, `gif`, `avif`, `tif`, `tiff`, `svg`. Steps always run in this order: size limit, trim, resize, flatten, encode.

```json
{ "action": "image", "source": "ui", "resize": { "scale": 0.5 }, "format": ["webp", "png"], "quality": 80 }
```

| Option        | What it does                                                                                                           | Default       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| `format`      | `png`, `jpeg`, `webp`, `avif`, `gif`, or a list. With a list every format is tried and the smallest wins.              | source format |
| `quality`     | 1 to 100, for every format. A format's own `quality` wins over it.                                                     | `80`          |
| `lossless`    | Lossless encoding where the format allows it.                                                                          | `false`       |
| `maxWidth`    | Shrink images wider than this, keeping the aspect ratio. Narrower images are untouched.                                | none          |
| `maxHeight`   | Shrink images taller than this, keeping the aspect ratio. Shorter images are untouched.                                | none          |
| `resize`      | Resize every image, see the table below.                                                                               | none          |
| `trim`        | `true`, or `{ "threshold": n }`: cut borders of the same colour.                                                       | `false`       |
| `flatten`     | Background colour under transparent pixels, like `"#ffffff"`.                                                          | none          |
| `keepSmaller` | When only re-encoding, keep the original if the new file is bigger.                                                    | `true`        |
| `metadata`    | Keep EXIF and ICC data. Orientation is always applied.                                                                 | `false`       |
| `animated`    | Keep gif and webp animation. `false` keeps the first frame.                                                            | `true`        |
| `density`     | DPI for svg sources. 72 is the svg's own size, 144 doubles it.                                                         | `72`          |
| `png`         | `{ "palette": true, "colors": 256, "dither": 1, "effort": 7 }`                                                         |               |
| `jpeg`        | `{ "quality", "progressive": false, "mozjpeg": true, "chromaSubsampling": "4:2:0" }`                                   |               |
| `webp`        | `{ "quality", "preset": "default", "alphaQuality": 100, "nearLossless": false, "smartSubsample": false, "effort": 6 }` |               |
| `avif`        | `{ "quality": 50, "chromaSubsampling": "4:4:4", "effort": 4 }`                                                         |               |
| `gif`         | `{ "colors": 256, "dither": 1, "effort": 7, "interFrameMaxError": 0 }`                                                 |               |

`resize`:

| Option     | What it does                                                                                                                                          | Default                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `width`    | Target width in pixels.                                                                                                                               |                                        |
| `height`   | Target height in pixels.                                                                                                                              |                                        |
| `scale`    | Multiply both sides, `0.5` halves the image. Wins over `width` and `height`.                                                                          |                                        |
| `fit`      | `cover`, `contain`, `fill`, `inside`, `outside`.                                                                                                      | `cover` with both sides, else `inside` |
| `upscale`  | Allow enlarging. A `scale` above 1 enlarges unless this is `false`.                                                                                   | `false`                                |
| `kernel`   | `nearest` for pixel art, `cubic`, `mitchell`, `lanczos2`, `lanczos3`.                                                                                 | `lanczos3`                             |
| `position` | Part of the image `cover` and `contain` keep: `center`, `top`, `right`, `bottom`, `left`, `left top` and the other corners, `entropy` or `attention`. | `center`                               |

Good to know:

- avif has its own `quality` of 50, because avif reaches the same look at lower numbers. The top-level `quality` does not change it. Set `"avif": { "quality": 60 }` instead.
- The extension follows the format. `jpeg` writes `.jpg`.
- jpeg cannot hold transparency. Without `flatten` it is painted on black, with a warning. In a format list, jpeg is skipped for transparent images.
- svg sources need a raster `format`, otherwise they are skipped with a warning.
- An animation converted to png, jpeg or avif keeps its first frame.

### atlas

Packs images into one or more pages, with a JSON per page in the TexturePacker "JSON hash" format. PixiJS, Phaser, Babylon.js, PlayCanvas and most other engines load it directly. Takes `png`, `jpg`, `jpeg`, `webp`, `gif` (first frame), `avif`, `tif`, `tiff`.

```json
{ "action": "atlas", "source": "sprites", "padding": 2, "extrude": 1 }
```

| Option       | What it does                                                          | Default             |
| ------------ | --------------------------------------------------------------------- | ------------------- |
| `name`       | Name of the files: `name.png` and `name.json`.                        | the selected folder |
| `maxWidth`   | Widest page in pixels. What does not fit goes to the next page.       | `2048`              |
| `maxHeight`  | Tallest page in pixels.                                               | `2048`              |
| `padding`    | Empty pixels between sprites and to the page edge.                    | `2`                 |
| `extrude`    | Repeat each sprite's edge pixels this far outwards, against bleeding. | `0`                 |
| `trim`       | Cut transparent borders. Frames keep their original size and offset.  | `true`              |
| `powerOfTwo` | Round page sizes up to a power of two.                                | `false`             |
| `format`     | Page format: `png`, `jpeg`, `webp`, `avif`.                           | `png`               |
| `quality`    | 1 to 100. For png pages, setting it switches to palette compression.  | not set             |

`"source": "sprites"` writes `sprites.png` and `sprites.json`. Frame names are the paths inside the selected folder without the extension, like `hero/idle_01`:

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

Good to know:

- When sprites do not fit one page, pages are numbered: `sprites_1.png`, `sprites_2.png`. Each JSON lists the others under `meta.related_multi_packs`.
- With a `[hash]` filename template, a page and its JSON get the same hash.
- png pages are lossless unless you set `quality`. With `quality` they are reduced to at most 256 colours, which makes them much smaller.
- Without `quality`, jpeg and webp pages use 80 and avif pages 50, like the `image` action.
- The same input always gives identical bytes. Frames are never rotated.
- On a lossless png page, a frame cut back out equals the trimmed sprite pixel for pixel.

### json

Minifies JSON files. An invalid file is an error. No options.

### xml

Minifies XML files: whitespace between tags is removed. Text and CDATA sections stay exactly as written.

| Option     | What it does   | Default |
| ---------- | -------------- | ------- |
| `comments` | Keep comments. | `false` |

### copy

Copies files unchanged. Takes every file. No options.

## JavaScript API

```js
import { actions, image, atlas, json, xml, copy, build, selectFiles, writeFiles, formatReport } from '@smoud/assets';
```

CommonJS works the same with `require('@smoud/assets')`.

### Run an action

Every action has a `process` function. It takes a `source`, an optional `destination` and the action's options, the same ones as in `assets.json`:

```js
await image.process({ source: 'assets/ui', destination: 'public/ui', format: 'webp', quality: 80 });
await atlas.process({ source: 'assets/sprites', destination: 'public', extrude: 1 });
```

- **`source`** is a folder, file, glob or long-form object, relative to the working directory. Absolute paths work too. It can also be a list of files you already have in memory.
- **`destination`** is a folder, or `{ folder, filename }` for a filename template. Results keep their path inside the selected folder: `assets/ui/buttons/play.png` becomes `public/ui/buttons/play.webp`.
- **Without a destination** nothing is written, and the files come back on the result.

Chain actions by passing one result's files to the next:

```js
const icons = await image.process({ source: 'assets/icons', format: 'png', density: 144 });
await atlas.process({ source: icons.outputs, destination: 'public', padding: 4 });
```

`#rest` and `#virtual` folders exist only inside a build. In code, a variable holding the files does the same job.

`process` never deletes other files in its destination, so several calls can share one folder. When an action reports an error, nothing is written. An unknown option throws.

Every action is also in the `actions` registry, by name:

```js
await actions.image.process({ source: 'assets/ui', format: 'webp' });
```

### Raw functions

Each action has a raw function that works on bytes, with the same options as the action. No files, no folders.

```js
const webp = await image.optimizeImage(pngBuffer, { format: 'webp', quality: 80 });
const meta = await image.readImageMeta(pngBuffer);
const packed = await atlas.packAtlas(
  [
    { name: 'hero', data: heroPng },
    { name: 'coin', data: coinPng }
  ],
  { padding: 2 }
);
const small = json.minifyJson(jsonBuffer);
const tight = xml.minifyXml(xmlBuffer, { comments: false });
```

| Function                             | Returns                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `image.optimizeImage(data, options)` | `{ data, format, width, height, alpha, animated, keptOriginal, warnings }`, or `null` for an svg without a `format`.       |
| `image.readImageMeta(data)`          | `{ format, width, height, alpha, animated }`                                                                               |
| `atlas.packAtlas(sprites, options)`  | `{ pages, warnings, errors }`. Each page is `{ image, width, height, frames }`. `errors` lists sprites that were left out. |
| `json.minifyJson(data)`              | A buffer. Throws on invalid JSON.                                                                                          |
| `xml.minifyXml(data, options)`       | A buffer.                                                                                                                  |

### Find and write files

`selectFiles` finds files with the `source` syntax and reads them. `writeFiles` writes them with the `destination` syntax.

```js
const { files, warnings } = await selectFiles(
  { include: 'assets/ui', when: { width: '>512' } },
  { probe: image.readImageMeta }
);
for (const file of files) file.data = (await image.optimizeImage(file.data, { quality: 70 })).data;
await writeFiles(files, { folder: 'public/ui', filename: '[name].[hash][ext]' });
```

| `selectFiles` option | What it does                                                                           |
| -------------------- | -------------------------------------------------------------------------------------- |
| `root`               | Folder the patterns are relative to. Default: the working directory.                   |
| `accepts`            | Keep only these extensions, like `['png', 'jpg']`.                                     |
| `exclude`            | Patterns that never match.                                                             |
| `probe`              | A function that reads facts from a file's bytes, for `when` filters other than `size`. |

`selectFiles` knows nothing about images. Pass a probe, like `image.readImageMeta`, to filter on `width` or `alpha`.

Each file is `{ path, data, meta }`, where `path` is relative to the selected folder and `meta.size` is the size in bytes.

### build

Runs a config, the same as the command line.

```js
const result = await build({ config: 'assets.json', strict: true });
console.log(formatReport(result));
if (!result.ok) process.exit(1);
```

| Option        | What it does                                         | Default                     |
| ------------- | ---------------------------------------------------- | --------------------------- |
| `config`      | A path to a config file, or the config as an object. | `assets.json`, if it exists |
| `preset`      | Preset the config extends, like `--preset`.          | from the config             |
| `source`      | Source folder, like `--source`.                      | from the config             |
| `destination` | Destination folder, like `--destination`.            | from the config             |
| `dryRun`      | Process everything, write nothing.                   | `false`                     |
| `strict`      | Warnings make `result.ok` false.                     | `false`                     |

Problems inside the build land in `result.errors`. `build` throws only for a broken setup, like a missing source folder or a destination that would overwrite the source.

### formatReport

Turns results into the report the command line prints. Pass one action result, a list of them, or a build result.

```js
const results = [
  await json.process({ source: 'assets/data', destination: 'public' }),
  await copy.process({ source: 'assets/fonts', destination: 'public/fonts' })
];
console.log(formatReport(results, { verbose: true }));
```

`verbose` adds one line per file and shows every warning.

### Results

`process` returns an action result:

| Field         | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `ok`          | No errors.                                                                           |
| `action`      | The action name.                                                                     |
| `label`       | Short description, like `image, source "ui"`.                                        |
| `selected`    | How many files the action received.                                                  |
| `fromCache`   | How many of them came from the cache.                                                |
| `files`       | One row per source file: `source`, `outputs`, `bytesIn`, `bytesOut`, `keptOriginal`. |
| `outputs`     | The produced files, in memory.                                                       |
| `destination` | The folder written to, or `null` when nothing was written.                           |
| `bytesIn`     | Bytes in.                                                                            |
| `bytesOut`    | Bytes out.                                                                           |
| `warnings`    | Messages that did not stop the action.                                               |
| `errors`      | Messages that did.                                                                   |
| `duration`    | Milliseconds.                                                                        |

`build` returns a build result:

| Field         | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `ok`          | No errors, and no warnings when `strict`.                 |
| `dryRun`      | Whether this was a dry run.                               |
| `source`      | Absolute source folder.                                   |
| `destination` | Absolute destination folder.                              |
| `actions`     | One action result per action.                             |
| `unselected`  | Source files no action took.                              |
| `warnings`    | Messages that did not stop the build.                     |
| `errors`      | Messages that did. Nothing is written when there are any. |
| `duration`    | Milliseconds.                                             |

### Your own actions

An action is a plain object. You write `transform`: it gets all the selected files and the options, and returns the outputs. Register the action once, and it works in code and in `assets.json`:

```js
import { actions } from '@smoud/assets';

const upper = actions.register({
  name: 'upper',
  version: 1,
  cache: true,
  accepts: ['txt'],
  options: {
    suffix: { kind: 'string', description: 'Added to the file name', default: '' }
  },

  // a raw function: bytes in, bytes out, usable on its own as upper.toUpper(buffer)
  toUpper(data) {
    return Buffer.from(data.toString().toUpperCase());
  },

  async transform(files, { suffix }) {
    return files.map((file) => ({
      ...file,
      path: file.path.replace(/\.txt$/, `${suffix}.txt`),
      data: upper.toUpper(file.data)
    }));
  }
});

await upper.process({ source: 'texts', destination: 'public/texts', suffix: '-loud' });
```

```json
{ "actions": [{ "action": "upper", "source": "texts", "suffix": "-loud" }] }
```

`register` adds `process` around your `transform`. It selects the files with `accepts` and `probe`, checks the options and fills their defaults, writes the outputs, and builds the result for the report.

`cache: true` lets the cache keep each file's result. Use `cache: 'together'` when every output depends on all the files, like an atlas. Caching needs a `version`: raise it whenever you change what the action produces, or old results keep coming back. Without `cache`, the action always runs.

**What `transform` gets and returns:**

- **`files`**: every selected file, `{ path, data, meta }`. One file in, one out is the usual case, but an atlas takes many and returns two.
- **`options`**: checked, with every default filled in.
- **`context`**: two values that most actions never need. They exist for actions that combine files, like atlas.
  - `folderName` is the name of the folder the files were selected from, like `sprites` for `"source": "sprites"`. It is empty when the files come from several folders. Use it to name a combined output. The atlas names its page `sprites.png` this way.
  - `filenameTemplate` is the destination's filename template, like `[name].[hash][ext]`. Pass it to `destinationPath(file, filenameTemplate)` to know an output's final name before it is written. The atlas JSON uses this to point at its page image.
- **It returns** a list of output files, or `{ outputs, warnings, errors }` to report problems. A throw fails the action.

Spread the input file into each output, `{ ...file, data }`, so the report links them. An output without that link stands for all inputs, like an atlas page.

**Helpers for `transform`:**

| Helper                                 | What it does                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transformFiles(files, transformFile)` | Runs `transformFile` on every file, several at a time. A broken file becomes an error that names it, and the rest go on. Returns `{ outputs, errors }`, which `transform` can return as it is. |
| `resolveOptions(table, input)`         | Checks options against a table and fills the defaults. Useful in raw functions.                                                                                                                |

**Writing `process` yourself.** An action that defines `process` instead of `transform` is used exactly as written, for example when it needs its own file selection. Use `selectFiles` to find files, and `finishAction` to write the outputs and build a result the report and `build` understand.

Option kinds are `boolean`, `number` with `min` and `max`, `string`, `enum` with `values`, `object` with `properties`, `list` with `items`, and `oneOf` with alternatives. Each takes a `description` and an optional `default`.

## Issues

Found a bug or missing something? [Open an issue](https://github.com/smoudjs/assets/issues).

## License

[MIT](LICENSE)

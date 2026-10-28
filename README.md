# @smoud/assets

[![npm version](https://img.shields.io/npm/v/@smoud/assets.svg)](https://www.npmjs.com/package/@smoud/assets)
[![npm downloads](https://img.shields.io/npm/dw/@smoud/assets.svg)](https://www.npmjs.com/package/@smoud/assets)
[![license](https://img.shields.io/npm/l/@smoud/assets.svg)](https://github.com/smoudjs/assets/blob/main/LICENSE)

**Optimize every game asset with one command.**

Images, sounds, 3D models, Spine and data files, each compressed with the right tool. Names and formats stay and no file ever grows, so your game code does not change.

```sh
npm install --save-dev @smoud/assets
npx smoud-assets build --source assets --destination assets
```

Every file in `assets/` is replaced by its optimized version, so keep the originals in git.

Making a playable ad? Add `--preset playable` or `--preset playable-max` to convert formats, downmix sounds and shrink textures. This saves up to a third of the asset size, see [typical results](#typical-results).

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [The config file](#the-config-file)
  - [Presets](#presets)
- [Command line](#command-line)
  - [Examples](#examples)
- [Action reference](#action-reference)
  - [image](#image)
  - [atlas](#atlas)
  - [audio](#audio)
  - [audiosprite](#audiosprite)
  - [gltf](#gltf)
  - [meshopt](#meshopt)
  - [spine](#spine)
  - [json](#json)
  - [xml](#xml)
  - [copy](#copy)
- [JavaScript API](#javascript-api)
  - [Your own actions](#your-own-actions)

## Features

- 🛡️ **Safe by default**: models keep their nodes, names and UVs, and a failed build leaves the previous output untouched.
- ⚡ **One command**: works on any `assets/` folder as it is, ffmpeg included. Results are cached, so rebuilds skip unchanged files.
- 📱 **Playable presets**: `playable` and `playable-max` convert formats, downmix sounds and shrink models for the smallest ad.
- 🖼️ **Images**: [Sharp](https://sharp.pixelplumbing.com) with palette png, mozjpeg, webp and avif. Try several formats and keep the smallest.
- 🧩 **Texture atlases**: MaxRects packing, trimming, extrusion, TexturePacker-compatible JSON.
- 🔊 **Audio**: mp3, ogg, opus or m4a, mono downmix, bitrate by quality, never above the source. Audio sprites for Howler, Phaser and PixiJS Sound.
- 🧊 **3D models**: [glTF Transform](https://gltf-transform.dev) and meshoptimizer: dedup, weld, prune, simplify, quantize, texture extraction, meshopt compression.
- 🦴 **Spine**: pages compressed, converted and scaled with the `.atlas` rewritten, skeleton numbers rounded, animations filtered.
- 📄 **Data files**: JSON and XML minified.
- 🎯 **Selection and chaining**: globs, `#rest`, filters on size, image, sound and model facts, virtual `#folders` between actions.
- 🧰 **Toolkit**: a JSON config or the JavaScript API, every action's raw function, your own actions. Output is plain files for PixiJS, Phaser, Three.js, Cocos or your own loader.

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

The result is in `assets/optimized/`:

```
assets/optimized/
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
  "destination": "assets/optimized",
  "ignore": ["**/*.psd", "raw"],
  "defaults": {
    "image": { "quality": 80 }
  },
  "actions": [{ "action": "atlas", "source": "sprites" }],
  "clean": true
}
```

| Key           | What it does                                                                 | Default                               |
| ------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| `preset`      | A base config yours extends, see [Presets](#presets).                        | `default` when there are no `actions` |
| `source`      | Folder with your source assets.                                              | `assets`                              |
| `destination` | Output folder. Must not contain the source folder or be the project root.    | `assets/optimized`                    |
| `ignore`      | Files the build never sees. Dot files and `node_modules` are always ignored. | none                                  |
| `defaults`    | Starting options per action, see [Defaults](#defaults).                      | none                                  |
| `actions`     | The list of actions, run top to bottom.                                      | none                                  |
| `clean`       | Remove files from the destination that this build did not produce.           | `true`                                |
| `cache`       | Reuse earlier results for unchanged files.                                   | `true`                                |

`source` and `destination` are always folders, never patterns. The command line flags `--source` and `--destination` override them.

A `destination` equal to `source` rewrites the files in place. With `clean`, files no action takes would be deleted, so the build fails instead. Commit your assets first. `watch` does not run in place.

With `cache` on, results are kept in `node_modules/.cache/smoud-assets` and reused as long as the file, the options and the action stay the same. Entries older than 30 days are removed, and when the cache passes 1 GB the oldest go until half is left.

### Actions

Each entry in `actions` is one step: which files, what to do, where to put the result.

```json
{ "action": "image", "source": "ui", "destination": "interface", "format": "webp", "quality": 80 }
```

| Key           | What it does                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `action`      | The action name: `image`, `atlas`, `audio`, `audiosprite`, `gltf`, `meshopt`, `spine`, `json`, `xml`, `copy`, or one you registered. |
| `source`      | Which files. Omitted: every file the action can handle.                                                                              |
| `destination` | Where the results go. Omitted: each result lands where its source was.                                                               |
| anything else | Options of the action, see [Action reference](#action-reference).                                                                    |

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

**`when`** filters on facts about a file. `size` is known for every file. Other facts come from the action that selects: `image` knows `width`, `height`, `alpha` and `animated`, `audio` knows `duration`, `channels`, `sampleRate` and `bitrate`, and `gltf` and `meshopt` know `triangles`, `vertices`, `textures` and `animations`.

| Fact         | Example                         | Meaning                                |
| ------------ | ------------------------------- | -------------------------------------- |
| `size`       | `">200kb"`, `["<2mb", ">10kb"]` | File size, with `b`, `kb`, `mb`, `gb`. |
| `width`      | `">=1024"`                      | Width in pixels.                       |
| `height`     | `"<512"`                        | Height in pixels.                      |
| `alpha`      | `false`                         | Has transparency.                      |
| `animated`   | `true`                          | Has more than one frame.               |
| `duration`   | `">10"`                         | Length of a sound in seconds.          |
| `channels`   | `"1"`                           | 1 for mono, 2 for stereo.              |
| `sampleRate` | `">=44100"`                     | Sample rate of a sound in Hz.          |
| `bitrate`    | `">128"`                        | Bitrate of a sound in kbps.            |
| `triangles`  | `">50000"`                      | Triangles in a model.                  |
| `vertices`   | `">10000"`                      | Vertices in a model.                   |
| `textures`   | `"0"`                           | Textures in a model.                   |
| `animations` | `">0"`                          | Animations in a model.                 |

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
  "actions": [{ "action": "atlas", "source": "sprites" }]
}
```

The rules:

1. **`defaults`** are merged, and yours win key by key. In the example the preset's atlas quality applies to your atlas, and your image quality of 60 replaces the preset's.
2. **`actions`:** yours run first. The preset's actions then only see the files yours did not take. Above, the atlas takes `sprites`, and the preset handles everything else.
3. **No `preset` and no `actions`:** the built-in `default` preset runs.

`preset` takes a built-in name, a path to a JSON file, or the name of an installed package. On the command line, `--preset` sets it and wins over the config's own.

**Built-in presets:**

| Preset         | What it does                                                                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`      | Optimizes models and Spine, compresses images and sounds in their own format, minifies json and xml, copies everything else, svg included.                                                                                                                                   |
| `playable`     | For playable ads. Images are shrunk to fit 2048×2048, opaque png becomes jpeg, quality 70, or 50 for files over 400 KB. Atlases and Spine pages use quality 70. Sounds become mono mp3 at 96 kbps. Models extract their textures. Then json, xml and copy like `default`.    |
| `playable-max` | Like `playable`, with stronger compression: every png becomes webp, quality 60, or 45 for files over 300 KB. Atlas and Spine pages: webp, quality 60. Sounds become mono mp3 at 64 kbps. Models drop normals, textures become webp, models over 50,000 triangles are halved. |

#### Typical results

Approximate savings of each preset per genre, based on benchmarks of shipped playable ads. They count images, sounds, models and Spine files; fonts and code are copied as they are.

| Game                     | Assets | `default` | `playable` | `playable-max` |
| ------------------------ | ------ | --------- | ---------- | -------------- |
| 2D match-3 with Spine    | 2 MB   | -12%      | -16%       | -35%           |
| 2D merge                 | 3 MB   | -10%      | -18%       | -32%           |
| 2D hidden objects        | 5 MB   | -14%      | -20%       | -38%           |
| 2D slots                 | 4 MB   | -10%      | -15%       | -30%           |
| 3D idle tycoon           | 6 MB   | -12%      | -16%       | -22%           |
| 3D farm builder          | 3 MB   | -8%       | -17%       | -34%           |
| 3D runner                | 4 MB   | -9%       | -14%       | -25%           |
| 3D restaurant management | 4 MB   | -11%      | -15%       | -18%           |

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
| `--no-config`         | Ignore any config file.                                        |
| `--source <dir>`      | Source folder. Wins over the config.                           |
| `--destination <dir>` | Destination folder. Wins over the config.                      |
| `--preset <name>`     | Preset the config extends.                                     |
| `--strict`            | Warnings count as failure.                                     |
| `--verbose`           | One line per file, and every warning instead of the first ten. |
| `--dry-run`           | Process everything, write nothing.                             |
| `--[no-]cache`        | Use the cache or not. Wins over the config.                    |
| `-h, --help`          | Show help.                                                     |
| `-v, --version`       | Show the version.                                              |

The exit code is `0` on success, `1` for a failed build, and `2` for a wrong command. Colours follow `NO_COLOR` and `FORCE_COLOR`.

### Examples

Default optimization, no config needed. Takes `assets/` and writes to `assets/optimized/`. Every file keeps its name and format:

```sh
npx smoud-assets build
```

A playable ad. Takes `assets/` and writes to `assets/optimized/` with the [playable preset](#presets). Or `{ "preset": "playable" }` in `assets.json`:

```sh
npx smoud-assets build --preset playable
```

Rewrite the files in `assets/` with their optimized versions, no copy. Commit your assets first. `--no-config` keeps the command the same even when an `assets.json` is added later:

```sh
npx smoud-assets build --no-config --destination assets
```

Takes `assets/` and writes to `../dist/`, outside the project. Or `{ "destination": "../dist" }` in `assets.json`:

```sh
npx smoud-assets build --destination ../dist
```

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
- The extension follows the format. `jpeg` writes `.jpg`. A wrong extension, like a png named `.jpg`, is fixed with a warning.
- jpeg cannot hold transparency. Without `flatten` it is painted on black, with a warning. In a format list, jpeg is skipped for transparent images.
- svg sources need a raster `format`, otherwise they are skipped with a warning.
- An animation converted to png, jpeg or avif keeps its first frame.

### atlas

Packs images into one or more pages, with a data file per page. By default it is TexturePacker JSON, which PixiJS, Phaser, Babylon.js, PlayCanvas and most other engines load directly. Takes `png`, `jpg`, `jpeg`, `webp`, `gif` (first frame), `avif`, `tif`, `tiff`.

```json
{ "action": "atlas", "source": "sprites", "padding": 2, "extrude": 1 }
```

| Option       | What it does                                                          | Default     |
| ------------ | --------------------------------------------------------------------- | ----------- |
| `maxWidth`   | Widest page in pixels. What does not fit goes to the next page.       | `2048`      |
| `maxHeight`  | Tallest page in pixels.                                               | `2048`      |
| `padding`    | Empty pixels between sprites and to the page edge.                    | `2`         |
| `extrude`    | Repeat each sprite's edge pixels this far outwards, against bleeding. | `0`         |
| `trim`       | Cut transparent borders. Frames keep their original size and offset.  | `true`      |
| `scale`      | Shrink every sprite before packing, 0 to 1. The frames follow.        | `1`         |
| `extensions` | Keep file extensions in frame names, like `hero/idle_01.png`.         | `false`     |
| `powerOfTwo` | Round page sizes up to a power of two.                                | `false`     |
| `format`     | Page format: `png`, `jpeg`, `webp`, `avif`.                           | `png`       |
| `quality`    | 1 to 100. For png pages, setting it switches to palette compression.  | not set     |
| `data`       | Layout of the data file, see the table below.                         | `json-hash` |

`data` layouts:

| Value        | What it writes                                                                         |
| ------------ | -------------------------------------------------------------------------------------- |
| `json-hash`  | TexturePacker JSON hash, shown below. PixiJS, Phaser, Babylon.js, PlayCanvas.          |
| `json-array` | TexturePacker JSON array: the frames as a list, each with a `filename`. Phaser, Cocos. |
| `json`       | Your own loader: `[{ name, x, y, width, height }]`                                     |
| `css`        | HTML elements: one class per frame with `background`, `width` and `height`.            |

`"source": "sprites"` writes `sprites.png` and `sprites.json`. `"destination": { "filename": "world" }` names them `world.png` and `world.json`. Frame names are the paths inside the selected folder without the extension, like `hero/idle_01`:

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

- When sprites do not fit one page, pages are numbered: `sprites_1.png`, `sprites_2.png`. Each TexturePacker JSON lists the others under `meta.related_multi_packs`.
- `scale` is written to `meta.scale`. PixiJS reads it and shows the sprites at their original size.
- With `css`, a frame name becomes a class: `hero/idle_01` is `.hero_idle_01`.
- With a `[hash]` filename template, a page and its data file get the same hash.
- png pages are lossless unless you set `quality`. With `quality` they are reduced to at most 256 colours, which makes them much smaller.
- Without `quality`, jpeg and webp pages use 80 and avif pages 50, like the `image` action.
- The same input always gives identical bytes. Frames are never rotated.
- On a lossless png page, a frame cut back out equals the trimmed sprite pixel for pixel.

### audio

Converts, downmixes, resamples and compresses sounds. Takes `mp3`, `ogg`, `oga`, `opus`, `m4a`, `aac`, `wav`, `flac`, `webm`.

```json
{ "action": "audio", "source": "sfx", "format": "mp3", "bitrate": 64, "channels": 1 }
```

| Option        | What it does                                                                | Default       |
| ------------- | --------------------------------------------------------------------------- | ------------- |
| `format`      | `mp3`, `ogg`, `opus`, `m4a`, `wav`, `flac`.                                 | source format |
| `quality`     | 1 to 100 for mp3, ogg, opus and m4a. Sounds about the same in every format. | `80`          |
| `bitrate`     | 8 to 320 kbps, for mp3, ogg, opus and m4a. Wins over `quality`.             | none          |
| `channels`    | `1` for mono, `2` for stereo.                                               | source        |
| `sampleRate`  | `8000` to `48000` Hz, standard rates. opus always uses 48000.               | source        |
| `keepSmaller` | Keep the original when encoding would not make it smaller.                  | `true`        |

Good to know:

- Channels, sample rate and bitrate never go up. With the same format and nothing to reduce, the original bytes are kept.
- `quality` 80 gives 128 kbps for stereo mp3. Mono gets half, and ogg, m4a and opus get less for the same sound.
- mp3 plays everywhere. ogg and opus are smaller, but older Safari cannot play them.
- `"when": { "duration": ">10" }` separates music from sound effects.
- Runs on ffmpeg through [@smoud/ffmpeg](https://www.npmjs.com/package/@smoud/ffmpeg). Set `FFMPEG_PATH` to use your own.

### audiosprite

Joins many sounds into one file with silence between them, plus a JSON that tells the player where each sound is. Takes the same files as `audio`.

```json
{ "action": "audiosprite", "source": "sfx", "channels": 1, "quality": 60 }
```

`"source": "sfx"` writes `sfx.mp3` and `sfx.json`. `"destination": { "filename": "effects" }` names them `effects.mp3` and `effects.json`:

```json
{ "src": ["sfx.mp3"], "sprite": { "click": [0, 200], "coin": [450, 100], "ui/close": [800, 350] } }
```

| Option       | What it does                                                          | Default         |
| ------------ | --------------------------------------------------------------------- | --------------- |
| `format`     | `mp3`, `ogg`, `opus`, `m4a`, `wav`.                                   | `mp3`           |
| `quality`    | 1 to 100, as in [audio](#audio).                                      | `80`            |
| `bitrate`    | 8 to 320 kbps. Wins over `quality`.                                   | none            |
| `channels`   | `1` or `2`. Never more than the sounds have.                          | from the sounds |
| `sampleRate` | As in [audio](#audio). Never above the sounds.                        | from the sounds |
| `gap`        | Seconds of silence between sounds, so one never bleeds into the next. | `0.25`          |
| `data`       | Layout of the JSON, see the table below.                              | `howler`        |

`data` layouts:

| Value     | What it writes                                                                                  | Times in |
| --------- | ----------------------------------------------------------------------------------------------- | -------- |
| `howler`  | Howler 2: `{ src: [file], sprite: { name: [start, duration] } }`                                | ms       |
| `howler1` | Howler 1: `{ urls: [file], sprite: { name: [start, duration] } }`                               | ms       |
| `phaser`  | Phaser 3 `load.audioSprite`: `{ resources: [file], spritemap: { name: { start, end, loop } } }` | seconds  |
| `pixi`    | PixiJS Sound `sound.add`: `{ url: file, sprites: { name: { start, end } } }`                    | seconds  |
| `json`    | Your own loader: `[{ name, start, duration }]`                                                  | ms       |

Good to know:

- Sound names are the paths inside the folder without the extension, like `ui/close`.
- Channels and sample rate come from the sounds, never higher.
- Looping is set in the game, not in the JSON.

### gltf

Optimizes glTF models, `.glb` and `.gltf`. Everything it writes loads in any engine without a decoder.

```json
{ "action": "gltf", "source": "models", "normals": false, "textures": { "extract": true } }
```

| Option                   | What it does                                                            | Default       |
| ------------------------ | ----------------------------------------------------------------------- | ------------- |
| `format`                 | `glb`, `gltf` (separate files) or `gltf-embedded`.                      | as the source |
| `quantize`               | Smaller vertex data, `KHR_mesh_quantization`. See below.                | `false`       |
| `simplify`               | Fewer triangles, see below.                                             | none          |
| `textures`               | Re-encode or extract textures, see below.                               | as they are   |
| `normals`                | `false` removes them; shading turns flat unless the game computes them. | `true`        |
| `tangents`               | `false` removes them.                                                   | `true`        |
| `uvs`                    | `false` removes them, and the textures with them.                       | `true`        |
| `vertexColors`           | `false` removes them.                                                   | `true`        |
| `materials`              | `false` removes them, and the textures with them.                       | `true`        |
| `animations`             | `false` removes them.                                                   | `true`        |
| `removeUnusedAttributes` | Remove vertex attributes no material uses, like UVs without a texture.  | `false`       |
| `keepSmaller`            | Keep the original when cleanup alone would not make it smaller.         | `true`        |

`simplify`:

- `ratio`: share of triangles to keep, 0 to 1. Simplify runs only with it.
- `error`: the most the shape may change, as a share of the model size. Default `0.01`; simplifying stops there.
- `method`: `collapse` keeps the shape and UV seams. `sloppy` is coarser, for far LODs, and needs a higher `error`, like `0.1`.

`textures`:

- `format`, `quality`, `maxWidth`, `maxHeight`: re-encode through the image action. Without them, textures stay as they are.
- `extract: true`: textures are written next to the model, like `crate_wood_baseColor.png` (model, material, slot), and removed from it. UVs stay, so the game can put them back.

LODs are one action per level:

```json
{ "action": "gltf", "source": "hero", "destination": { "filename": "[name]_lod0" } },
{ "action": "gltf", "source": "hero", "destination": { "filename": "[name]_lod1" }, "simplify": { "ratio": 0.25 } }
```

Extracted textures can go on to another action through a virtual folder:

```json
{ "action": "gltf", "source": "models", "textures": { "extract": true }, "destination": "#models" },
{ "action": "image", "source": "#models", "format": "webp", "destination": "models" },
{ "action": "copy", "source": { "include": "#models", "exclude": "*.png" }, "destination": "models" }
```

Good to know:

- A `.gltf` brings its `.bin` and textures, and no later action takes them. Put `gltf` before your image actions.
- Cleanup always runs: unused parts go, identical geometry is shared and vertices are welded. Names, nodes, empty nodes and vertex attributes stay, so game code finds what it expects. When that alone does not make a model smaller, the original is kept.
- `quantize` adds a scale and offset to the nodes. Code that reuses `mesh.geometry` without its node, like `InstancedMesh` or merged geometry, sees the model shrunk and moved.
- `removeUnusedAttributes` judges by the materials in the file: the UVs of a model the game textures at runtime look unused and go. UVs of extracted textures always stay.
- Extracted textures fit an atlas only when they do not repeat; the game maps the UVs onto the frame.
- Reads meshopt-compressed models too, and always writes them uncompressed. For compression, see [meshopt](#meshopt).

### meshopt

Compresses glTF models, `.glb` and `.gltf`, with `EXT_meshopt_compression`. The game needs meshoptimizer's decoder to load them.

```json
{ "action": "gltf", "source": "models", "destination": "#models" },
{ "action": "meshopt", "source": "#models", "destination": "models" }
```

| Option  | What it does                                                        | Default |
| ------- | ------------------------------------------------------------------- | ------- |
| `level` | `medium`, or `high`, which also packs normals and tangents tighter. | `high`  |

In three.js:

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
```

Works on any glTF model. Run `gltf` before it to also clean up, simplify or re-encode textures, as in the example above.

### spine

Optimizes Spine exports. Takes `.atlas` files. The pages an atlas names and the skeleton with its name, `hero.json` or `hero.skel`, come with it, and no later action takes them.

```json
{ "action": "spine", "source": "spine", "format": "webp", "quality": 70, "animations": { "exclude": ["debug/*"] } }
```

| Option       | What it does                                                                                | Default       |
| ------------ | ------------------------------------------------------------------------------------------- | ------------- |
| `format`     | Page format: `png`, `jpeg`, `webp`, `avif`. The `.atlas` is rewritten to match.             | as the source |
| `quality`    | 1 to 100. For png pages, setting it switches to palette compression.                        | not set       |
| `scale`      | Shrink pages, 0 to 1. Every coordinate in the `.atlas` scales with them.                    | `1`           |
| `maxWidth`   | Shrink pages wider than this. Their coordinates in the `.atlas` follow.                     | none          |
| `maxHeight`  | Shrink pages taller than this. Their coordinates in the `.atlas` follow.                    | none          |
| `precision`  | Decimals kept for numbers in the skeleton `.json`.                                          | `3`           |
| `animations` | `{ "include": [...] }` or `{ "exclude": [...] }`: names or patterns, like `run*`. Not both. | all kept      |

Good to know:

- A binary `.skel` is kept as it is. `animations` and `precision` work on a `.json` skeleton.
- jpeg cannot hold transparency, so a page with it keeps its format, with a warning.
- Put `spine` before your image and json actions.

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
import {
  actions,
  image,
  atlas,
  audio,
  audiosprite,
  gltf,
  meshopt,
  spine,
  json,
  xml,
  copy,
  build,
  selectFiles,
  writeFiles,
  formatReport
} from '@smoud/assets';
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
- **`onProgress`** is called as the action moves through its files, with the same events as in [build](#build).

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
const mp3 = await audio.encodeAudio(wavBuffer, { format: 'mp3', bitrate: 96 });
const sprite = await audiosprite.packAudioSprite(
  [
    { name: 'click', data: clickWav },
    { name: 'coin', data: coinWav }
  ],
  { gap: 0.5 }
);
const model = await gltf.optimizeGltf({ data: glbBuffer }, { simplify: { ratio: 0.5 } });
const compressed = await meshopt.compressGltf({ data: model.data });
const hero = await spine.optimizeSpine(
  { atlas: atlasText, files: { 'hero.png': heroPng, 'hero.json': heroJson } },
  { format: 'webp', scale: 0.5 }
);
const small = json.minifyJson(jsonBuffer);
const tight = xml.minifyXml(xmlBuffer, { comments: false });
```

| Function                                       | Returns                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.optimizeImage(data, options)`           | `{ data, format, width, height, alpha, animated, keptOriginal, warnings }`, or `null` for an svg without a `format`.                            |
| `image.readImageMeta(data)`                    | `{ format, width, height, alpha, animated }`                                                                                                    |
| `audio.encodeAudio(data, options)`             | `{ data, format, duration, channels, sampleRate, bitrate, keptOriginal }`, or `null` for a codec with no matching format and no `format` given. |
| `audio.readAudioMeta(data)`                    | `{ format, duration, channels, sampleRate, bitrate }`                                                                                           |
| `atlas.packAtlas(sprites, options)`            | `{ pages, warnings, errors }`. Each page is `{ image, width, height, frames }`. `errors` lists sprites that were left out.                      |
| `audiosprite.packAudioSprite(sounds, options)` | `{ data, format, duration, channels, sampleRate, bitrate, sounds }`. Each sound is `{ name, start, duration }`, in ms.                          |
| `gltf.optimizeGltf(model, options)`            | `{ data, format, files, triangles, vertices, textures, animations }`. `files` are the `.bin` and textures the model refers to, by name.         |
| `gltf.readGltfMeta(data)`                      | `{ format, triangles, vertices, textures, animations }`                                                                                         |
| `meshopt.compressGltf(model, options)`         | As `gltf.optimizeGltf`, with the model compressed.                                                                                              |
| `spine.optimizeSpine(input, options)`          | `{ atlas, files, warnings }`. `files` are the pages and skeleton, by the names the `.atlas` refers to.                                          |
| `json.minifyJson(data)`                        | A buffer. Throws on invalid JSON.                                                                                                               |
| `xml.minifyXml(data, options)`                 | A buffer.                                                                                                                                       |

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

| `selectFiles` option | What it does                                                                   |
| -------------------- | ------------------------------------------------------------------------------ |
| `root`               | Folder the patterns are relative to. Default: the working directory.           |
| `accepts`            | Keep only these extensions, like `['png', 'jpg']`.                             |
| `exclude`            | Patterns that never match.                                                     |
| `probe`              | A function that reads facts from a file, for `when` filters other than `size`. |

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
| `cache`       | Reuse earlier results, like `--cache`.               | from the config             |
| `onProgress`  | Called as each action moves through its files.       | none                        |

`onProgress` receives `{ label, index, actions, done, total, file }`: the action's label and its place among all `actions`, how many of its `total` files are `done`, and the `file` that just started.

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

A file that points to other files, like a `.gltf` to its `.bin`, needs `findCompanions(file)`: return those paths, relative to the file. They are read into `file.companions`, and no later action takes them.

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

Each option has a `kind` (`boolean`, `number`, `string`, `enum`, `object`, `list` or `oneOf`), a `description` and an optional `default`. Values that don't fit the kind are errors.

## Issues

Found a bug or missing something? [Open an issue](https://github.com/smoudjs/assets/issues).

## License

[MIT](LICENSE)

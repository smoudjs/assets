import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { audiosprite } from '../dist/index.js';
import { ASSETS, run, scratchAssets } from './helpers.mjs';

const SFX = ['click', 'coin', 'hit', 'jump', 'laser'];
const json = async (build, file) => JSON.parse((await build.read(file)).toString());

/** Root mean square of a wav's 16-bit samples between two times in ms, all channels together. */
function loudness(wav, channels, sampleRate, fromMs, toMs) {
  const sampleAt = (ms) => 44 + Math.floor((ms / 1000) * sampleRate) * channels * 2;
  let sum = 0;
  let count = 0;
  for (let offset = sampleAt(fromMs); offset < Math.min(sampleAt(toMs), wav.length - 1); offset += 2) {
    sum += wav.readInt16LE(offset) ** 2;
    count++;
  }
  return Math.sqrt(sum / count);
}

describe('audiosprite: output', () => {
  it('joins the sounds sorted by name, and the timings point at them with silence between', async () => {
    const build = await run({ actions: [{ action: 'audiosprite', source: 'audio/sfx', format: 'wav' }] });
    assert.equal(build.result.ok, true, build.result.errors.join('\n'));
    assert.deepEqual(await build.outputs(), ['sfx.json', 'sfx.wav']);
    const { src, sprite } = await json(build, 'sfx.json');
    assert.deepEqual(src, ['sfx.wav']);
    assert.deepEqual(Object.keys(sprite), SFX);

    const [output] = build.result.actions[0].outputs;
    const { channels, sampleRate } = output.meta;
    const wav = await build.read('sfx.wav');
    const sounds = Object.values(sprite);
    for (const [index, [start, duration]] of sounds.entries()) {
      assert.ok(loudness(wav, channels, sampleRate, start + 10, start + duration - 10) > 1000, `${SFX[index]} is there`);
      const next = sounds[index + 1];
      if (next) assert.equal(loudness(wav, channels, sampleRate, start + duration + 20, next[0] - 20), 0, 'gap is silent');
    }
  });

  it('writes every json layout', async () => {
    const source = ['audio/sfx/click.wav', 'audio/sfx/coin.wav'];
    const layouts = {};
    for (const layout of ['howler', 'howler1', 'phaser', 'pixi', 'raw']) {
      const build = await run({ actions: [{ action: 'audiosprite', source, format: 'wav', json: layout }] });
      layouts[layout] = await json(build, 'sfx.json');
    }
    assert.deepEqual(layouts.howler, { src: ['sfx.wav'], sprite: { click: [0, 200], coin: [450, 100] } });
    assert.deepEqual(layouts.howler1, { urls: ['sfx.wav'], sprite: { click: [0, 200], coin: [450, 100] } });
    assert.deepEqual(layouts.phaser, {
      resources: ['sfx.wav'],
      spritemap: { click: { start: 0, end: 0.2, loop: false }, coin: { start: 0.45, end: 0.55, loop: false } }
    });
    assert.deepEqual(layouts.pixi, {
      url: 'sfx.wav',
      sprites: { click: { start: 0, end: 0.2 }, coin: { start: 0.45, end: 0.55 } }
    });
    assert.deepEqual(layouts.raw, {
      file: 'sfx.wav',
      sounds: { click: { start: 0, duration: 0.2 }, coin: { start: 0.45, duration: 0.1 } }
    });
  });

  it('a filename template renames both files, with one shared [hash], and the JSON points at the renamed sound', async () => {
    const build = await run({
      actions: [
        { action: 'audiosprite', source: 'audio/sfx', destination: { folder: 'audio', filename: 'effects.[hash][ext]' } }
      ]
    });
    const files = await build.outputs();
    assert.equal(files.length, 2);
    const [jsonFile, mp3File] = files;
    assert.match(mp3File, /^audio\/effects\.[0-9a-f]{8}\.mp3$/);
    assert.equal(jsonFile, mp3File.replace(/\.mp3$/, '.json'));
    assert.deepEqual((await json(build, jsonFile)).src, [path.posix.basename(mp3File)]);
  });
});

describe('audiosprite: settings', () => {
  // click.wav is mono 22050, coin.wav stereo 44100
  const source = ['audio/sfx/click.wav', 'audio/sfx/coin.wav'];

  it('takes the most channels and the highest sample rate of the sounds, never more', async () => {
    const build = await run({
      actions: [{ action: 'audiosprite', source, format: 'wav', channels: 2, sampleRate: 48000 }]
    });
    const { channels, sampleRate } = build.result.actions[0].outputs[0].meta;
    assert.deepEqual([channels, sampleRate], [2, 44100]);
  });

  it('channels, sampleRate and gap are applied', async () => {
    const build = await run({
      actions: [{ action: 'audiosprite', source, format: 'wav', channels: 1, sampleRate: 22050, gap: 0.5 }]
    });
    const { channels, sampleRate } = build.result.actions[0].outputs[0].meta;
    assert.deepEqual([channels, sampleRate], [1, 22050]);
    assert.deepEqual((await json(build, 'sfx.json')).sprite, { click: [0, 200], coin: [700, 100] });
  });

  it('the same sounds give the same bytes, and a second build comes from the cache', async () => {
    const sounds = await Promise.all(
      ['click.wav', 'jump.m4a'].map(async (file) => ({
        name: file,
        data: await readFile(path.join(ASSETS, 'audio/sfx', file))
      }))
    );
    const first = await audiosprite.packAudioSprite(sounds, { format: 'ogg' });
    const second = await audiosprite.packAudioSprite(sounds, { format: 'ogg' });
    assert.ok(first.data.equals(second.data));

    const config = { actions: [{ action: 'audiosprite', source: 'audio/sfx', format: 'opus', gap: 0.2 }] };
    await run(config);
    const [action] = (await run(config)).result.actions;
    assert.equal(action.fromCache, action.selected);
  });
});

describe('audiosprite: failures', () => {
  it('a corrupt sound fails the build, named, and nothing is written', async () => {
    const assets = await scratchAssets();
    await assets.write('audio/sfx/broken.mp3', 'this is not an mp3');
    const { result, outputs } = await run({ source: assets.dir, actions: [{ action: 'audiosprite', source: 'audio/sfx' }] });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('broken') && e.includes('not an audio file')),
      result.errors.join('\n')
    );
    assert.deepEqual(await outputs(), []);
  });

  it('two sounds with the same name fail the build', async () => {
    const assets = await scratchAssets();
    await assets.write('audio/sfx/click.mp3', await readFile(path.join(ASSETS, 'audio/music/intro.mp3')));
    const { result } = await run({ source: assets.dir, actions: [{ action: 'audiosprite', source: 'audio/sfx' }] });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('two sounds are named "click"')),
      result.errors.join('\n')
    );
  });

  // ffmpeg is looked up once per process, so a broken FFMPEG_PATH needs a process of its own
  it('a broken FFMPEG_PATH fails with its own message, not under a sound name', async () => {
    const dist = new URL('../dist/index.js', import.meta.url).href;
    const script = `const { audiosprite } = await import(${JSON.stringify(dist)});
      await audiosprite.packAudioSprite([{ name: 'click', data: Buffer.from('x') }])
        .catch((error) => console.log(error.message));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, FFMPEG_PATH: path.join(ASSETS, 'no-such-ffmpeg') }
    });
    assert.match(stdout, /^FFMPEG_PATH/);
  });
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { audio } from '../dist/index.js';
import { ASSETS, run, scratchAssets } from './helpers.mjs';

const facts = async (buffer) => {
  const { format, channels, sampleRate } = await audio.readAudioMeta(buffer);
  return { format, channels, sampleRate };
};
const sources = (result) => result.actions[0].files.map((file) => file.source).sort();

describe('audio: probe and when', () => {
  it('readAudioMeta reads format, duration, channels, sample rate and bitrate', async () => {
    const meta = await audio.readAudioMeta(await readFile(path.join(ASSETS, 'audio/music/intro.mp3')));
    assert.deepEqual(
      { ...meta, duration: undefined },
      {
        format: 'mp3',
        duration: undefined,
        channels: 2,
        sampleRate: 44100,
        bitrate: 64
      }
    );
    assert.ok(Math.abs(meta.duration - 2) < 0.1, `duration ${meta.duration}`);
  });

  it('when.duration selects by length', async () => {
    const { result } = await run({ actions: [{ action: 'audio', source: { include: 'audio', when: { duration: '>1' } } }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(sources(result), ['audio/music/intro.mp3', 'audio/music/theme.ogg']);
  });
});

describe('audio: encode', () => {
  it('converts every source codec to mp3 and changes the extension', async () => {
    const { result, outputs, read } = await run({
      actions: [{ action: 'audio', source: 'audio', format: 'mp3', bitrate: 64 }]
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const files = await outputs();
    assert.deepEqual(files, [
      'audio/music/intro.mp3',
      'audio/music/theme.mp3',
      'audio/sfx/click.mp3',
      'audio/sfx/coin.mp3',
      'audio/sfx/hit.mp3',
      'audio/sfx/jump.mp3',
      'audio/sfx/laser.mp3'
    ]);
    for (const file of files) assert.equal((await facts(await read(file))).format, 'mp3', file);
  });

  it('encodes ogg, opus and m4a; opus always plays at 48000', async () => {
    for (const [format, sampleRate] of [
      ['ogg', 44100],
      ['opus', 48000],
      ['m4a', 44100]
    ]) {
      const { outputs, read } = await run({ actions: [{ action: 'audio', source: 'audio/sfx/hit.flac', format }] });
      assert.deepEqual(await outputs(), [`audio/sfx/hit.${format}`]);
      assert.deepEqual(await facts(await read(`audio/sfx/hit.${format}`)), { format, channels: 1, sampleRate });
    }
  });

  it('without a format every file keeps its own, and with nothing to reduce its original bytes', async () => {
    const { result, outputs } = await run({ actions: [{ action: 'audio', source: 'audio/sfx' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(await outputs(), sources(result));
    const kept = Object.fromEntries(result.actions[0].files.map((file) => [file.source, file.keptOriginal]));
    // quality 80 asks about 51 kbps of mono m4a, less than jump.m4a's 64; opus asks 38, more than laser.opus's 32
    assert.deepEqual(kept, {
      'audio/sfx/click.wav': true,
      'audio/sfx/coin.wav': true,
      'audio/sfx/hit.flac': true,
      'audio/sfx/jump.m4a': false,
      'audio/sfx/laser.opus': true
    });
  });

  it('quality picks the bitrate, and bitrate wins over it', async () => {
    const data = await readFile(path.join(ASSETS, 'audio/music/intro.mp3'));
    const low = await audio.encodeAudio(data, { format: 'ogg', quality: 20 });
    const high = await audio.encodeAudio(data, { format: 'ogg', quality: 60 });
    assert.ok(low.data.length < high.data.length, `${low.data.length} vs ${high.data.length}`);
    const fixedLow = await audio.encodeAudio(data, { format: 'ogg', quality: 10, bitrate: 48 });
    const fixedHigh = await audio.encodeAudio(data, { format: 'ogg', quality: 100, bitrate: 48 });
    assert.ok(fixedLow.data.equals(fixedHigh.data), 'with a bitrate, quality changes nothing');
  });

  it('channels and sampleRate downmix and resample', async () => {
    const { result, read } = await run({
      actions: [{ action: 'audio', source: 'audio/sfx/coin.wav', channels: 1, sampleRate: 22050 }]
    });
    assert.deepEqual(await facts(await read('audio/sfx/coin.wav')), { format: 'wav', channels: 1, sampleRate: 22050 });
    const [coin] = result.actions[0].files;
    assert.ok(coin.bytesOut < coin.bytesIn / 3, `${coin.bytesIn} → ${coin.bytesOut}`);
  });
});

describe('audio: never raise', () => {
  it('a mono 22050 source stays mono 22050 when stereo 44100 is asked for', async () => {
    const { read } = await run({
      actions: [{ action: 'audio', source: 'audio/sfx/click.wav', format: 'mp3', channels: 2, sampleRate: 44100 }]
    });
    assert.deepEqual(await facts(await read('audio/sfx/click.mp3')), { format: 'mp3', channels: 1, sampleRate: 22050 });
  });

  it('a 64k mp3 asked for 128k keeps its original bytes; without keepSmaller it is re-encoded at 64k', async () => {
    const kept = await run({ actions: [{ action: 'audio', source: 'audio/music/intro.mp3', bitrate: 128 }] });
    const [intro] = kept.result.actions[0].files;
    assert.equal(intro.keptOriginal, true);
    assert.equal(intro.bytesOut, intro.bytesIn);

    const encoded = await run({
      actions: [{ action: 'audio', source: 'audio/music/intro.mp3', bitrate: 128, keepSmaller: false }]
    });
    const [output] = encoded.result.actions[0].outputs;
    assert.equal(output.keptOriginal, false);
    assert.ok(output.meta.bitrate <= 70, `bitrate ${output.meta.bitrate}`);
  });
});

describe('audio: cache and failures', () => {
  it('a second build takes every file from the cache, byte for byte', async () => {
    const config = { actions: [{ action: 'audio', source: 'audio/sfx', format: 'ogg', bitrate: 48 }] };
    const first = await run(config);
    const second = await run(config);
    assert.equal(first.result.ok, true, first.result.errors.join('\n'));
    const [action] = second.result.actions;
    assert.equal(action.fromCache, action.selected);
    for (const file of await first.outputs()) {
      assert.ok((await first.read(file)).equals(await second.read(file)), `${file} differs`);
    }
  });

  it('a corrupt file fails the build and nothing is written', async () => {
    const assets = await scratchAssets();
    await assets.write('audio/sfx/broken.mp3', 'this is not an mp3');
    const { result, outputs } = await run({ source: assets.dir, actions: [{ action: 'audio', source: 'audio/sfx' }] });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('broken.mp3') && e.includes('not an audio file')),
      result.errors.join('\n')
    );
    assert.deepEqual(await outputs(), []);
  });

  it('a mistyped option suggests the right name', async () => {
    const data = await readFile(path.join(ASSETS, 'audio/sfx/click.wav'));
    await assert.rejects(audio.encodeAudio(data, { bitrat: 64 }), /did you mean "bitrate"/);
  });

  // ffmpeg is looked up once per process, so a broken FFMPEG_PATH needs a process of its own
  it('a broken FFMPEG_PATH fails with its own message, not as an unreadable file', async () => {
    const dist = new URL('../dist/index.js', import.meta.url).href;
    const script = `const { audio } = await import(${JSON.stringify(dist)});
      await audio.readAudioMeta(Buffer.from('x')).catch((error) => console.log(error.message));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, FFMPEG_PATH: path.join(ASSETS, 'no-such-ffmpeg') }
    });
    assert.match(stdout, /FFMPEG_PATH/);
    assert.doesNotMatch(stdout, /not an audio file/);
  });
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runFfmpeg } from '@smoud/ffmpeg';
import { video } from '../dist/index.js';
import { tempDir } from './helpers.mjs';

/** A short clip made with ffmpeg's test sources. */
async function clip(args, name) {
  const file = path.join(await tempDir(), name);
  await runFfmpeg(['-loglevel', 'error', ...args, '-y', file]);
  return readFile(file);
}

describe('video', () => {
  it('shrinks size and frame rate, never above the source, and can drop the sound', async () => {
    const data = await clip(
      [
        ...['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=60:d=1', '-f', 'lavfi', '-i', 'sine=d=1'],
        ...['-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']
      ],
      'clip.mp4'
    );
    const shrunk = await video.encodeVideo(data, { maxWidth: 320, fps: 30, audio: false });
    assert.deepEqual([shrunk.format, shrunk.width, shrunk.height, shrunk.fps, shrunk.audio], ['mp4', 320, 180, 30, false]);
    assert.ok(shrunk.data.length < data.length);

    const capped = await video.encodeVideo(data, { maxWidth: 4000, fps: 120 });
    assert.deepEqual([capped.width, capped.fps, capped.audio], [640, 60, true]);
  });

  it('keeps transparency in webm, webp and gif, and warns that mp4 loses it', async () => {
    const data = await clip(
      [
        ...['-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x64:r=10:d=1,format=rgba'],
        ...['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
      ],
      'fx.mov'
    );
    for (const format of ['webm', 'webp', 'gif']) {
      const encoded = await video.encodeVideo(data, { format });
      assert.deepEqual([encoded.format, encoded.alpha, encoded.warnings], [format, true, []], format);
    }
    const mp4 = await video.encodeVideo(data, {});
    assert.equal(mp4.alpha, false);
    assert.match(mp4.warnings.join('\n'), /mp4 cannot hold transparency/);
  });
});

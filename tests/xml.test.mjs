import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { run, scratchAssets } from './helpers.mjs';

const SOURCE = `<?xml version="1.0"?>
<!-- game settings -->
<game>
  <title>Test  Game</title>
  <script><![CDATA[
    if (a < b) { run(); }
  ]]></script>
  <fps>60</fps>   <!-- target -->
</game>
`;

describe('xml', () => {
  it('removes whitespace between tags and comments, keeps text and CDATA', async () => {
    const assets = await scratchAssets();
    await assets.write('data/config.xml', SOURCE);
    const { result, read } = await run({ source: assets.dir, actions: [{ action: 'xml', source: 'data' }] });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(
      (await read('data/config.xml')).toString(),
      '<?xml version="1.0"?><game><title>Test  Game</title><script><![CDATA[\n    if (a < b) { run(); }\n  ]]></script><fps>60</fps></game>'
    );
  });

  it('keeps comments when asked', async () => {
    const assets = await scratchAssets();
    await assets.write('data/config.xml', SOURCE);
    const { read } = await run({ source: assets.dir, actions: [{ action: 'xml', source: 'data', comments: true }] });
    const text = (await read('data/config.xml')).toString();
    assert.ok(text.includes('<!-- game settings -->'));
    assert.ok(text.includes('<fps>60</fps><!-- target -->'));
  });
});

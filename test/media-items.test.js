import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identifyMediaItems, assertSameMediaItems } from '../src/media-items.js';

test('original item identity rejects changed, reordered, missing, duplicate and legacy children', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-identities-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [index, bytes] of ['first', 'second', 'first'].entries()) {
    const filePath = path.join(root, String(index)); await fs.writeFile(filePath, bytes);
    files.push({ filePath, mediaKind: 'image' });
  }
  const source = { provider: 'tiktok-api', resolved: { id: '123' } };
  const original = await identifyMediaItems(files, source);
  assert.equal(original[0].sourceItemId, original[2].sourceItemId, 'legitimate repeated identical images are allowed');
  assertSameMediaItems(original, original, source.provider);
  for (const candidate of [original.slice(0, 2), [original[1], original[0], original[2]],
    original.map((item, i) => i === 2 ? { ...item, mediaKind: 'video' } : item),
    original.map((item, i) => i === 2 ? { ...item, sourceItemId: 'native:changed' } : item)]) {
    assert.throws(() => assertSameMediaItems(original, candidate, source.provider), { code: 'MEDIA_SOURCE_MISMATCH' });
  }
  assert.throws(() => assertSameMediaItems([{ mediaKind: 'image' }], original, source.provider), { code: 'MEDIA_SOURCE_UNVERIFIED' });
  await assert.rejects(identifyMediaItems([{ sourceItemId: 'native:1' }, { sourceItemId: 'native:1' }], source), { code: 'MEDIA_SOURCE_UNVERIFIED' });
  await fs.writeFile(files[1].filePath, 'changed bytes'); delete files[1].sourceItemId;
  const changed = await identifyMediaItems(files, source);
  assert.throws(() => assertSameMediaItems(original, changed, source.provider), { code: 'MEDIA_SOURCE_MISMATCH' });
});

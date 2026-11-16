import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./fuzz.mjs', import.meta.url));

test('rejects invalid fuzz options before loading the competition kit', () => {
  const invalidOptions = [
    ['--n'],
    ['--n', 'nope'],
    ['--n', '0'],
    ['--n', '1.5'],
    ['--seed', '0'],
    ['--seed', '4294967296'],
  ];

  for (const [option, ...value] of invalidOptions) {
    const result = spawnSync(process.execPath, [script, 'unused-kit', option, ...value], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.startsWith(`${option} must be an integer`), result.stderr);
  }
});

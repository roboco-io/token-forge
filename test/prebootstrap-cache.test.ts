import { spawnSync } from 'child_process';
import * as path from 'path';
test('cache restores only compatible hash-verified files and rejects links/traversal', () => {
  const r = spawnSync('python3', [path.join(__dirname, 'prebootstrap_cache_test.py')], { encoding: 'utf8' });
  expect(r.stderr).toContain('Ran 5 tests');
  expect(r.status).toBe(0);
});

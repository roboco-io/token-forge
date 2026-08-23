import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveState, loadState } from '../cli/state';

test('상태 저장·로드 왕복', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-state-'));
  expect(loadState(dir)).toBeNull();
  saveState({ model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' }, dir);
  expect(loadState(dir)).toEqual({ model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' });
});

test('구버전 상태 파일(3필드)도 로드되고 새 필드는 undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-state-'));
  fs.writeFileSync(path.join(dir, 'state.json'),
    JSON.stringify({ model: 'm', profile: 'p', region: 'r' }));
  const s = loadState(dir)!;
  expect(s.standbyRegions).toBeUndefined();
  expect(s.lastUsed).toBeUndefined();
});

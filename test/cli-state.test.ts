import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveState, loadState, clearState, removeRegionFromState } from '../cli/state';

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

test('removeRegionFromState: standbyRegions·lastUsed에서 제거', () => {
  const s = { model: 'm', profile: 'p', region: 'r1',
    standbyRegions: ['r1', 'r2'], lastUsed: { r1: 't1', r2: 't2' } };
  const out = removeRegionFromState(s, 'r2');
  expect(out.standbyRegions).toEqual(['r1']);
  expect(out.lastUsed).toEqual({ r1: 't1' });
  expect(s.standbyRegions).toEqual(['r1', 'r2']); // 원본 불변
});

test('clearState: 파일 삭제, 없어도 오류 없음', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-state-'));
  saveState({ model: 'm', profile: 'p', region: 'r' }, dir);
  clearState(dir);
  expect(loadState(dir)).toBeNull();
  clearState(dir); // 두 번째 호출도 안전
});

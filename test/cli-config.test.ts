import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../cli/config';

describe('config', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfcfg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('파일 없으면 기본값 (standby=race, k=2)', () => {
    const c = loadConfig(dir);
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(c.standby).toBe('race');
    expect(c.k).toBe(2);
    expect(c.scoreTieThreshold).toBe(1);
    expect(c.rttTieThresholdMs).toBe(30);
  });

  test('부분 파일은 기본값과 병합', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ standby: 'single' }));
    const c = loadConfig(dir);
    expect(c.standby).toBe('single');
    expect(c.k).toBe(2); // 기본값 유지
  });

  test('save 후 load 왕복', () => {
    saveConfig({ ...DEFAULT_CONFIG, k: 3 }, dir);
    expect(loadConfig(dir).k).toBe(3);
  });
});

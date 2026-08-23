import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TfConfig {
  standby: 'race' | 'single' | 'lazy';
  k: number;                 // 레이스 후보 수 (1-4, 스펙: 기본 2)
  feedUrl: string;           // 공개 배치점수 피드. 프라이버시 모드는 자가 수집기 URL로 교체
  scoreTieThreshold: number; // 48h 평균 점수 동치 임계값 (스펙 기본 1)
  rttTieThresholdMs: number; // RTT 동치 임계값 (스펙 기본 30ms)
}

export const DEFAULT_CONFIG: TfConfig = {
  standby: 'race',
  k: 2,
  feedUrl: 'https://d16jdvzof4zpo7.cloudfront.net/data.json',
  scoreTieThreshold: 1,
  rttTieThresholdMs: 30,
};

const DEFAULT_DIR = path.join(os.homedir(), '.token-forge');

export function loadConfig(dir: string = DEFAULT_DIR): TfConfig {
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function saveConfig(c: TfConfig, dir: string = DEFAULT_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c, null, 2));
}

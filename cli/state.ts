import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TfState {
  model: string;
  profile: string;
  region: string;
  standbyRegions?: string[];
  lastUsed?: Record<string, string>;
}

const DEFAULT_DIR = path.join(os.homedir(), '.token-forge');

export function saveState(s: TfState, dir: string = DEFAULT_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2));
}

export function loadState(dir: string = DEFAULT_DIR): TfState | null {
  const file = path.join(dir, 'state.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TfState;
}

export function clearState(dir: string = DEFAULT_DIR): void {
  fs.rmSync(path.join(dir, 'state.json'), { force: true });
}

/** 순수 함수 — purge된 리전의 흔적을 상태에서 제거 */
export function removeRegionFromState(s: TfState, region: string): TfState {
  const lastUsed = { ...(s.lastUsed ?? {}) };
  delete lastUsed[region];
  return { ...s, standbyRegions: (s.standbyRegions ?? []).filter((r) => r !== region), lastUsed };
}

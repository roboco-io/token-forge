import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TfState { model: string; profile: string; region: string }

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

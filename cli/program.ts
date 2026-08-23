import { Command } from 'commander';
import * as path from 'path';
import * as pkg from '../package.json';
import { listModels } from './catalog';
import { AwsApi } from './aws';
import { loadState } from './state';
import { runStatus } from './commands/status';

const MODELS_DIR = path.join(__dirname, '..', 'models');

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('tf')
    .description('token-forge — 내 AWS 계정 안의 프라이빗 바이브 코딩 LLM')
    .version(pkg.version);

  const model = program.command('model').description('모델 카탈로그');
  model.command('list').description('사용 가능한 모델·프로파일 나열').action(() => {
    for (const m of listModels(MODELS_DIR)) {
      console.log(`${m.model}  (profiles: ${m.profiles.join(', ')})`);
    }
  });

  /** 상태 파일 필수 로드 — 없으면 사용법 안내 후 종료 */
  function requireState() {
    const s = loadState();
    if (!s) { console.error('기록된 대상이 없습니다. 먼저 tf up <model>을 실행하세요.'); process.exit(1); }
    return s;
  }

  /** 엔드포인트 프로브 — API 키 없이 상태 코드만 (401도 "떠 있음"의 신호) */
  async function probe(url: string): Promise<number> {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.status; }
    catch { return 0; }
  }

  program.command('status').description('현재 스택·인스턴스·엔드포인트 상태').action(async () => {
    const state = requireState();
    const lines = await runStatus({ api: new AwsApi(state.region), state, probe });
    lines.forEach((l) => console.log(l));
  });

  return program;
}

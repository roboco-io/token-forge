import { Command } from 'commander';
import * as path from 'path';
import { spawn } from 'child_process';
import * as pkg from '../package.json';
import { listModels, defaultProfile } from './catalog';
import { AwsApi } from './aws';
import { loadState, saveState } from './state';
import { runStatus } from './commands/status';
import { runUp } from './commands/up';
import { runDown } from './commands/down';

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

  program.command('up <model>')
    .description('스팟 LLM 기동 (스택·시딩 자동 준비)')
    .option('--profile <p>', '모델 프로파일 (기본: yaml 첫 프로파일)')
    .option('--region <r>', 'AWS 리전', 'ap-northeast-2')
    .action(async (model: string, o: { profile?: string; region: string }) => {
      const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
      await runUp({ model, profile, region: o.region }, {
        api: new AwsApi(o.region), exec: execInherit, probeAuth,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        saveState, log: (m) => console.log(m), timeoutMs: 30 * 60 * 1000,
      });
    });

  program.command('down')
    .description('GPU 정지 (--purge: 스택·가중치 캐시까지 완전 삭제)')
    .option('--purge', '완전 삭제', false)
    .action(async (o: { purge: boolean }) => {
      const state = requireState();
      console.log(await runDown(state, o.purge, { api: new AwsApi(state.region), exec: execInherit }));
    });

  return program;
}

function execInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 1));
  });
}

async function probeAuth(url: string, key: string): Promise<number> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    return r.status;
  } catch { return 0; }
}

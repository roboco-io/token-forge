import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import * as pkg from '../package.json';
import { listModels, defaultProfile } from './catalog';
import { AwsApi } from './aws';
import { loadState, saveState } from './state';
import { runStatus } from './commands/status';
import { runUp, runUpAuto, ensureStackReady, waitReady } from './commands/up';
import { runDown } from './commands/down';
import { renderClaudeEnv } from './commands/connect';
import { loadModelProfile } from '../lib/model-profile';
import { stackNameFor } from '../lib/naming';
import { loadConfig, saveConfig } from './config';
import { runPlacement } from './commands/placement';
import { fetchFeed } from './placement/feed';
import { getRtt, tcpConnector } from './placement/latency';
import { gatherCandidates } from './placement/engine';
import { runRace } from './commands/race';

const MODELS_DIR = path.join(__dirname, '..', 'models');

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('tkf')
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
    if (!s) { console.error('기록된 대상이 없습니다. 먼저 tkf up <model>을 실행하세요.'); process.exit(1); }
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
    .description('스팟 LLM 기동 — 리전 생략 시 배치 엔진이 자동 선정 + 병렬 레이스')
    .option('--profile <p>', '모델 프로파일 (기본: yaml 첫 프로파일)')
    .option('--region <r>', 'AWS 리전 (지정 시 해당 리전만 사용)')
    .action(async (model: string, o: { profile?: string; region?: string }) => {
      const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
      if (o.region) { // 기존 단일 리전 경로 (동작 불변)
        await runUp({ model, profile, region: o.region }, {
          api: new AwsApi(o.region), exec: execInherit, probeAuth,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          saveState, log: (m) => console.log(m), timeoutMs: 30 * 60 * 1000,
        });
        return;
      }
      const cfg = loadConfig();
      const rp = loadModelProfile(MODELS_DIR, model, profile);
      const types = rp.instanceType.split(',');
      const stackName = stackNameFor(model, profile);
      const tfDir = path.join(os.homedir(), '.token-forge');
      const mkUpDeps = (region: string) => ({
        api: new AwsApi(region), exec: execInherit, probeAuth,
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        saveState, log: (m: string) => console.log(m), timeoutMs: 30 * 60 * 1000,
      });
      const r = await runUpAuto({ model, profile }, {
        config: cfg,
        gather: () => gatherCandidates({ types, stackName, weightsRepo: rp.weightsRepo }, {
          config: cfg, fetchFeed: (u) => fetchFeed(u), apiFor: (rg) => new AwsApi(rg),
          getRtt: (rg) => getRtt(rg, { connect: tcpConnector, dir: tfDir, now: () => new Date() }),
          now: () => new Date(),
        }),
        ensure: (eo) => ensureStackReady(eo, mkUpDeps(eo.region)),
        asgNameFor: (region, sn) => new AwsApi(region).getAsgName(sn),
        race: (entrants) => runRace(entrants, {
          apiFor: (rg) => new AwsApi(rg), probe,
          sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
          log: (m) => console.log(m), timeoutMs: 30 * 60 * 1000,
        }),
        wait: (a) => waitReady({ stackName: a.stackName, outputs: a.outputs }, mkUpDeps(a.region)),
        saveState, loadState, log: (m) => console.log(m), now: () => new Date(),
      });
      console.log(`완료 — ${r.region} / ${r.endpoint}`);
    });

  program.command('down')
    .description('GPU 정지 (--purge: 스택·가중치 캐시까지 완전 삭제)')
    .option('--purge', '완전 삭제', false)
    .action(async (o: { purge: boolean }) => {
      const state = requireState();
      console.log(await runDown(state, o.purge, { api: new AwsApi(state.region), exec: execInherit }));
    });

  program.command('connect <client>')
    .description('클라이언트 연결 설정 생성 (지원: claude)')
    .option('--print', '파일 기록 없이 stdout으로만 출력', false)
    .action(async (client: string, o: { print: boolean }) => {
      if (client !== 'claude') { console.error(`미지원 클라이언트: ${client} (지원: claude)`); process.exit(1); }
      const state = requireState();
      const api = new AwsApi(state.region);
      const outputs = await api.getStackOutputs(stackNameFor(state.model, state.profile));
      if (!outputs) { console.error('스택 없음 — 먼저 tkf up을 실행하세요.'); process.exit(1); }
      const key = await api.getSecret(outputs.ApiKeySecretArn);
      const served = loadModelProfile(MODELS_DIR, state.model, state.profile).weightsRepo;
      const env = renderClaudeEnv(outputs.EndpointUrl, key, served);
      if (o.print) { console.log(env); return; }
      const file = path.join(os.homedir(), '.token-forge', 'env.sh');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, env, { mode: 0o600 }); // API 키 포함 — 소유자만 읽기
      fs.chmodSync(file, 0o600); // 기존 파일도 0600으로 보장
      console.log(`기록됨: ${file}`);
      console.log(`적용:   source ${file} && claude`);
    });

  const config = program.command('config').description('CLI 설정 (~/.token-forge/config.json)');
  config.command('get [key]').description('설정 조회').action((key?: string) => {
    const c = loadConfig();
    if (!key) { console.log(JSON.stringify(c, null, 2)); return; }
    if (!(key in c)) { console.error(`알 수 없는 키: ${key}`); process.exit(1); }
    console.log(String(c[key as keyof typeof c]));
  });
  config.command('set <key> <value>').description('설정 변경').action((key: string, value: string) => {
    const c = loadConfig();
    if (key === 'standby') {
      if (!['race', 'single', 'lazy'].includes(value)) { console.error('standby는 race|single|lazy'); process.exit(1); }
      c.standby = value as typeof c.standby;
    } else if (key === 'k') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 4) { console.error('k는 1-4 정수'); process.exit(1); }
      c.k = n;
    } else if (key === 'feedUrl') { c.feedUrl = value; }
    else if (key === 'scoreTieThreshold' || key === 'rttTieThresholdMs') {
      const n = Number(value);
      if (!(n >= 0)) { console.error(`${key}는 0 이상 숫자`); process.exit(1); }
      c[key] = n;
    } else { console.error(`알 수 없는 키: ${key}`); process.exit(1); }
    saveConfig(c);
    console.log(`설정됨: ${key}=${value}`);
  });

  program.command('placement <model>')
    .description('리전 추천 표시 (배치점수·레이턴시·가격·쿼터 종합)')
    .option('--profile <p>', '모델 프로파일 (기본: yaml 첫 프로파일)')
    .action(async (model: string, o: { profile?: string }) => {
      const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
      const rp = loadModelProfile(MODELS_DIR, model, profile);
      const cfg = loadConfig();
      const lines = await runPlacement(
        { types: rp.instanceType.split(','), stackName: stackNameFor(model, profile), weightsRepo: rp.weightsRepo, k: cfg.k },
        {
          config: cfg, fetchFeed: (u) => fetchFeed(u), apiFor: (r) => new AwsApi(r),
          getRtt: (r) => getRtt(r, { connect: tcpConnector, dir: path.join(os.homedir(), '.token-forge'), now: () => new Date() }),
          now: () => new Date(),
          thresholds: { score: cfg.scoreTieThreshold, rttMs: cfg.rttTieThresholdMs },
        });
      lines.forEach((l) => console.log(l));
    });

  return program;
}

function execInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    p.on('close', (code) => resolve(code ?? 1));
    p.on('error', (e) => reject(e));
  });
}

async function probeAuth(url: string, key: string): Promise<number> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    return r.status;
  } catch { return 0; }
}

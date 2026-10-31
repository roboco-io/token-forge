import { bootReport, formatBootReport } from './commands/boot-report';
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import * as pkg from '../package.json';
import { listModels, defaultProfile } from './catalog';
import { AwsApi } from './aws';
import { loadState, saveState, clearState, removeRegionFromState } from './state';
import { runStatus } from './commands/status';
import { runUp, runUpAuto, ensureStackReady, waitReady } from './commands/up';
import { runSeed, mkSeedEnsure, SeedChoice } from './commands/seed';
import { runDown } from './commands/down';
import { renderClaudeEnv } from './commands/connect';
import { runRotateKey } from './commands/rotate';
import { loadModelProfile } from '../lib/model-profile';
import { stackNameFor } from '../lib/naming';
import { loadConfig, saveConfig } from './config';
import { runPlacement } from './commands/placement';
import { fetchFeed } from './placement/feed';
import { getRtt, tcpConnector } from './placement/latency';
import { gatherCandidates } from './placement/engine';
import { runRace } from './commands/race';
import { runBatch, JobHandle } from './commands/run';
import { acquireLock, lockHolder } from './lock';
import { resolveUsagePolicy, describePolicy } from '../lib/usage-mode';
import checkbox from '@inquirer/checkbox';

const MODELS_DIR = path.join(__dirname, '..', 'models');
const TF_DIR = path.join(os.homedir(), '.token-forge');

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('tkf')
    .description('token-forge — 내 AWS 계정 안의 프라이빗 바이브 코딩 LLM')
    .version(pkg.version);

  program.command('boot-report').description('저장한 부팅 이벤트의 로컬 시간·근사 비용 보고')
    .requiredOption('--file <path>', '호스트 JSONL 또는 CloudWatch filter-log-events JSON')
    .option('--hourly-price <usd>', '명시적 시간당 USD 단가')
    .option('--launch-time <iso>', '한 boot ID의 EC2 LaunchTime (시간대 포함)')
    .option('--json', '구조화된 보고서')
    .action((o: { file: string; hourlyPrice?: string; launchTime?: string; json?: boolean }) => {
      const report = bootReport(fs.readFileSync(o.file, 'utf8'), o);
      console.log(o.json ? JSON.stringify(report, null, 2) : formatBootReport(report));
    });

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
    .option('--usage-mode <m>', '사용 모드 interactive|online (기본 interactive, batch는 tkf run)')
    .option('--idle-minutes <n>', 'interactive 유휴 종료 분 (5분 배수 5-1440, 0=비활성, 기본 30)')
    .action(async (model: string, o: { profile?: string; region?: string; usageMode?: string; idleMinutes?: string }) => {
      const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
      // CLI 경로는 항상 minCapacity=0으로 배포 — online의 min=1은 READY 후 적용
      const policy = resolveUsagePolicy({ usageMode: o.usageMode, idleMinutes: o.idleMinutes, minCapacity: 0 });
      if (policy.mode === 'batch') {
        console.error('batch 모드는 tkf run <model> --region <r> -- <command> [args...]로 실행합니다'); process.exit(1);
      }
      console.log(`사용 모드: ${describePolicy(policy)}`);
      if (o.region) { // 단일 리전 경로
        await runUp({ model, profile, region: o.region, policy }, {
          api: new AwsApi(o.region), exec: execInherit, probeAuth,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          saveState, log: (m) => console.log(m), timeoutMs: 30 * 60 * 1000,
          batchLockHolder: (key) => lockHolder(TF_DIR, key),
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
        batchLockHolder: (key: string) => lockHolder(TF_DIR, key),
      });
      const r = await runUpAuto({ model, profile, policy }, {
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
        wait: (a) => waitReady({ stackName: a.stackName, outputs: a.outputs, policy: a.policy }, mkUpDeps(a.region)),
        saveState, loadState, log: (m) => console.log(m), now: () => new Date(),
      });
      console.log(`완료 — ${r.region} / ${r.endpoint}`);
    });

  program.command('run <model>')
    .description('batch 작업 실행 — GPU 기동 → 명령 실행 → 성공·실패·취소·시간 제한 후 GPU 0 (사용: tkf run <model> --region <r> -- <command> [args...])')
    .argument('<command...>', '실행할 명령과 인자 (-- 뒤에 배열 그대로 전달, 셸 미사용)')
    .requiredOption('--region <r>', 'AWS 리전 (batch는 단일 리전 전용)')
    .option('--profile <p>', '모델 프로파일 (기본: yaml 첫 프로파일)')
    .option('--idle-minutes <n>', '하트비트 유실 시 백스톱 정지 분 (5분 배수 5-1440, 기본 30)')
    .option('--boot-timeout <min>', '스팟 확보·부팅 대기 상한(분)', '30')
    .option('--timeout <min>', '작업 실행 상한(분, 0=무제한)', '120')
    .action(async (model: string, command: string[], o: { region: string; profile?: string; idleMinutes?: string; bootTimeout: string; timeout: string }) => {
      const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
      const policy = resolveUsagePolicy({ usageMode: 'batch', idleMinutes: o.idleMinutes, minCapacity: 0 });
      const bootMin = parseMinutes('--boot-timeout', o.bootTimeout, 1);
      const jobMin = parseMinutes('--timeout', o.timeout, 0);
      const r = await runBatch({ model, profile, region: o.region, policy, command,
        bootTimeoutMs: bootMin * 60000, jobTimeoutMs: jobMin * 60000, killGraceMs: 10000 }, {
        api: new AwsApi(o.region), exec: execInherit, probeAuth, probe,
        sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
        saveState, loadState, log: (m) => console.log(m),
        acquireLock: (key) => acquireLock(TF_DIR, key),
        spawnJob,
        onSignal: (fn) => {
          const sigs: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
          sigs.forEach((s) => process.on(s, fn));
          return () => sigs.forEach((s) => process.off(s, fn));
        },
        every: (ms, fn) => { const t = setInterval(fn, ms); fn(); return () => clearInterval(t); },
        after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
      });
      (r.exitCode === 0 ? console.log : console.error)(r.message);
      process.exitCode = r.exitCode;
    });

  program.command('seed <model>')
    .description('가중치 S3 선시딩만 수행 (GPU 0대, up과 분리) — 리전 생략 시 배치 엔진 추천 + 체크박스 다중 선택')
    .option('--profile <p>', '모델 프로파일 (기본: yaml 첫 프로파일)')
    .option('--region <r>', 'AWS 리전 (지정 시 해당 리전만 즉시 시딩)')
    .action(async (model: string, o: { profile?: string; region?: string }) => {
      const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
      const cfg = loadConfig();
      const rp = loadModelProfile(MODELS_DIR, model, profile);
      const types = rp.instanceType.split(',');
      const stackName = stackNameFor(model, profile);
      const tfDir = path.join(os.homedir(), '.token-forge');
      const mkUpDeps = (region: string) => ({
        api: new AwsApi(region), exec: execInherit, probeAuth,
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        saveState, log: (m: string) => console.log(m), timeoutMs: 30 * 60 * 1000,
        batchLockHolder: (key: string) => lockHolder(TF_DIR, key),
      });
      const regions = await runSeed({ model, profile, region: o.region }, {
        gather: () => gatherCandidates({ types, stackName, weightsRepo: rp.weightsRepo }, {
          config: cfg, fetchFeed: (u) => fetchFeed(u), apiFor: (rg) => new AwsApi(rg),
          getRtt: (rg) => getRtt(rg, { connect: tcpConnector, dir: tfDir, now: () => new Date() }),
          now: () => new Date(),
        }),
        thresholds: { score: cfg.scoreTieThreshold, rttMs: cfg.rttTieThresholdMs },
        k: cfg.k,
        ensure: mkSeedEnsure(model, profile, mkUpDeps),
        select: async (choices: SeedChoice[]) => {
          if (!process.stdout.isTTY) {
            console.error('비-TTY 환경입니다 — --region <r>을 지정하세요');
            process.exit(1);
          }
          return checkbox({
            message: '시딩할 리전 선택 (스페이스 토글, 엔터 확정)',
            choices: choices.map((c) => ({ name: c.label, value: c.region, checked: c.checked })),
          });
        },
        log: (m) => console.log(m),
      });
      if (regions.length > 0) console.log(`시딩 완료: ${regions.join(', ')}`);
    });

  program.command('down')
    .description('GPU 정지 (--purge: 스택·가중치 캐시까지 완전 삭제, --region: 대상 리전 지정)')
    .option('--purge', '완전 삭제', false)
    .option('--region <r>', '대상 리전 (기본: 마지막 up 리전)')
    .action(async (o: { purge: boolean; region?: string }) => {
      const state = requireState();
      const target = o.region ?? state.region;
      console.log(await runDown({ ...state, region: target }, o.purge,
        { api: new AwsApi(target), exec: execInherit }));
      if (o.purge) { // purge된 리전의 흔적을 상태에서 제거
        if (target === state.region) clearState();
        else saveState(removeRegionFromState(state, target));
      }
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

  program.command('rotate-key')
    .description('API 키 회전 (Secrets Manager 갱신 — 가동 중이면 재기동 시 적용)')
    .action(async () => {
      const state = requireState();
      await runRotateKey(state, {
        api: new AwsApi(state.region),
        // 헤더/셸 안전 문자만 (스택의 excludePunctuation 정책과 동일 취지)
        genKey: () => crypto.randomBytes(24).toString('hex'),
        log: (m) => console.log(m),
      });
    });

  return program;
}

/** 분 단위 옵션 — 정수만 허용 (min 이상, 7일 이하) */
export function parseMinutes(name: string, raw: string, min: number): number {
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < min || Number(raw) > 10080) {
    throw new Error(`${name}: ${min}-10080 범위의 정수(분)여야 합니다 (입력: ${raw})`);
  }
  return Number(raw);
}

/**
 * batch 작업 실행 — 셸 없이 인자 배열 그대로, API 키는 자식 환경변수로만 전달.
 * 자식을 별도 프로세스 그룹(detached)으로 띄워 신호를 그룹 전체(손자 포함)에 보낸다. 자식이 끝나면
 * 그룹에 남은 손자도 SIGKILL로 정리하고, 그 뒤로는 kill이 아무것도 하지 않는다(늦은 신호·PID 재사용 방지).
 * 분리된 그룹은 터미널 Ctrl-C를 직접 받지 않으므로 tkf가 받은 신호를 SIGTERM으로 전달한다.
 * stdin이 TTY이면 백그라운드 그룹의 TTY 읽기(SIGTTIN 정지)를 피하려고 stdin을 닫는다.
 * setsid 등으로 그룹을 벗어난 프로세스는 정리 대상이 아니다.
 */
export function spawnJob(cmd: string, args: string[], env: Record<string, string>): JobHandle {
  const p = spawn(cmd, args, {
    stdio: [process.stdin.isTTY ? 'ignore' : 'inherit', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
    detached: true,
  });
  let finished = false;
  const killGroup = (sig: NodeJS.Signals) => {
    if (p.pid === undefined) return;
    try { process.kill(-p.pid, sig); } catch { /* ESRCH: 그룹 없음 */ }
  };
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    p.once('error', (e) => { finished = true; reject(e); }); // ENOENT 등 실행 실패
    p.once('exit', (code, signal) => {
      killGroup('SIGKILL'); // 자식이 남긴 손자 정리 — 그룹 리더가 끝난 직후 1회
      finished = true;
      resolve({ code, signal });
    });
  });
  return { done, kill: (sig) => { if (!finished) killGroup(sig); } };
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

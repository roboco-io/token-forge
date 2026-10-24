import { stackNameFor } from '../../lib/naming';
import { UsagePolicy } from '../../lib/usage-mode';
import { TfState } from '../state';
import { ensureStackReady, waitReady, UpDeps } from './up';

export interface JobResult { code: number | null; signal: NodeJS.Signals | null }
/** kill은 자식의 프로세스 그룹 전체에 보낸다. 자식이 끝난 뒤 호출되면 아무것도 하지 않는다 */
export interface JobHandle { done: Promise<JobResult>; kill: (sig: NodeJS.Signals) => void }

export interface RunOpts {
  model: string; profile: string; region: string;
  policy: UsagePolicy;
  command: string[];      // [cmd, ...args] — 셸을 거치지 않고 배열 그대로 실행
  bootTimeoutMs: number;  // 스팟 확보·부팅 대기 상한
  jobTimeoutMs: number;   // 작업 실행 상한 (0 = 무제한)
  killGraceMs: number;    // SIGTERM 후 SIGKILL까지 유예
}

export interface RunDeps extends Pick<UpDeps, 'api' | 'exec' | 'probeAuth' | 'sleep' | 'log' | 'saveState'> {
  loadState: () => TfState | null;
  /** 같은 호스트 동시 실행 잠금 — 보유 중이면 throw, 반환값은 해제 함수 */
  acquireLock: (key: string) => () => void;
  spawnJob: (cmd: string, args: string[], env: Record<string, string>) => JobHandle;
  /** SIGINT/SIGTERM/SIGHUP 핸들러 등록 — 반환값은 해제 함수 */
  onSignal: (fn: (sig: NodeJS.Signals) => void) => () => void;
  probe: (url: string) => Promise<number>;
  every: (ms: number, fn: () => void) => () => void;
  after: (ms: number, fn: () => void) => () => void;
}

export interface RunResult { exitCode: number; cleanup: 'ok' | 'failed' | 'not-needed'; message: string }

const HEARTBEAT_MS = 60_000; // 유휴 알람 평가 주기(5분)보다 충분히 짧게
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

class Cancelled extends Error {
  constructor(readonly sig: NodeJS.Signals) { super(`취소됨(${sig})`); }
}

/**
 * batch 모드 작업 래퍼 (#43): 전용 스택에서 GPU를 확보 → READY → 자식 프로세스 실행 →
 * 성공·실패·취소·시간 제한 어느 경우든 GPU 용량을 0으로 되돌린다.
 * - 작업 중에는 하트비트가 엔드포인트를 핑해 요청 기반 유휴 종료가 발화하지 않게 한다.
 *   하트비트가 끊기면(SIGKILL·호스트 유실) 스택의 백스톱 유휴 알람이 GPU를 내릴 수 있다(보장 아님 — README 한계 참고).
 * - 이미 GPU가 있거나 요청된 스택(다른 세션·online)은 인수하지도 종료하지도 않는다.
 *   검사는 배포 전(ensureStackReady)과 desired를 올리기 직전 두 번 한다. 다른 호스트와의 동시 시작은 막지 못한다.
 * - 정리 실패는 작업 결과와 함께 보고하며 성공(0)으로 끝내지 않는다.
 */
export async function runBatch(opts: RunOpts, d: RunDeps): Promise<RunResult> {
  if (opts.policy.mode !== 'batch') throw new Error('tkf run은 batch 모드 전용입니다');
  if (opts.command.length === 0 || !opts.command[0]) throw new Error('실행할 명령이 없습니다 — tkf run <model> --region <r> -- <command> [args...]');
  const stackName = stackNameFor(opts.model, opts.profile);
  const release = d.acquireLock(`${stackName}@${opts.region}`);
  let unSignal = () => {};
  try {
    let cancelled: NodeJS.Signals | null = null;
    let child: JobHandle | null = null;
    let stopSignalKill = () => {};
    const abortWaiters = new Set<() => void>();
    unSignal = d.onSignal((sig) => {
      if (cancelled) { d.log(`${sig} 재수신 — GPU 정리 중입니다. 강제 종료 시 tkf down --region ${opts.region}로 정리하세요`); return; }
      cancelled = sig;
      d.log(`${sig} 수신 — 작업을 중단하고 GPU를 정리합니다`);
      if (child) {
        const c = child;
        c.kill('SIGTERM');
        stopSignalKill = d.after(opts.killGraceMs, () => c.kill('SIGKILL'));
      }
      abortWaiters.forEach((w) => w());
    });
    // 부팅 대기 중 신호를 받으면 waitReady의 대기를 즉시 깨워 중단한다
    const abortableSleep = (ms: number) => new Promise<void>((resolve, reject) => {
      if (cancelled) { reject(new Cancelled(cancelled)); return; }
      let settled = false;
      const wake = () => { if (!settled) { settled = true; abortWaiters.delete(wake); reject(new Cancelled(cancelled!)); } };
      abortWaiters.add(wake);
      d.sleep(ms).then(() => {
        if (settled) return;
        settled = true; abortWaiters.delete(wake);
        if (cancelled) reject(new Cancelled(cancelled)); else resolve();
      }, (e) => { if (!settled) { settled = true; abortWaiters.delete(wake); reject(e); } });
    });

    const prevState = d.loadState();
    const restoreState = (): string => {
      if (!prevState) return '';
      try { d.saveState(prevState); return ''; }
      catch (e) { return ` (참고: 이전 state.json 복원 실패 — ${(e as Error).message}. GPU 정리 결과와는 무관)`; }
    };

    // ① 소유권 검사 + 모드 반영(필요 시 cdk deploy). 거부·배포·시딩 실패는 GPU를 올리기 전이라 정리할 것이 없다
    let ready: { outputs: Record<string, string> };
    try {
      ready = await ensureStackReady(opts, d);
    } catch (e) {
      const note = restoreState();
      if (note) d.log(note.trim());
      throw e;
    }

    let asgName: string | null = null; // 설정되면 이 실행이 desired를 올린 소유자 → 정리 책임
    let exitCode = 1;
    let outcome = '';
    try {
      if (cancelled) throw new Cancelled(cancelled);
      const name = await d.api.getAsgName(stackName);
      // ② desired를 올리기 직전 재검사 — 배포·시딩(수 분) 동안 다른 세션이 GPU를 올렸으면 인수하지 않는다
      const st = await d.api.getAsgStatus(name);
      if (st.desired > 0 || st.instanceIds.length > 0) {
        throw new Error(`준비 중 다른 세션이 ${stackName} @ ${opts.region}의 GPU를 올렸습니다(desired=${st.desired}) — 인수하거나 종료하지 않습니다`);
      }
      asgName = name;
      const { endpoint } = await waitReady({ stackName, outputs: ready.outputs, policy: opts.policy },
        { ...d, sleep: abortableSleep, timeoutMs: opts.bootTimeoutMs });
      if (cancelled) throw new Cancelled(cancelled);

      const key = await d.api.getSecret(ready.outputs.ApiKeySecretArn);
      if (cancelled) throw new Cancelled(cancelled); // 키 조회 중 취소 — 자식 명령을 시작하지 않는다
      const env = {
        TKF_ENDPOINT: endpoint, TKF_MODEL: ready.outputs.WeightsRepo, TKF_API_KEY: key,
        OPENAI_BASE_URL: `${endpoint}/v1`, OPENAI_API_KEY: key,
      };
      d.log(`작업 실행: ${JSON.stringify(opts.command)} — env TKF_ENDPOINT=${endpoint} TKF_MODEL=${env.TKF_MODEL} ` +
        'OPENAI_BASE_URL, TKF_API_KEY/OPENAI_API_KEY=(숨김)');

      let timedOut = false;
      let stopHeartbeat = () => {};
      let stopTimeout = () => {};
      let stopTimeoutKill = () => {};
      let result: JobResult | { spawnError: Error };
      try {
        stopHeartbeat = d.every(HEARTBEAT_MS, () => { d.probe(`${endpoint}/v1/models`).catch(() => 0); });
        child = d.spawnJob(opts.command[0], opts.command.slice(1), env);
        const c = child;
        if (opts.jobTimeoutMs > 0) {
          stopTimeout = d.after(opts.jobTimeoutMs, () => {
            timedOut = true;
            d.log(`작업 시간 제한(${Math.round(opts.jobTimeoutMs / 60000)}분) 초과 — SIGTERM`);
            c.kill('SIGTERM');
            stopTimeoutKill = d.after(opts.killGraceMs, () => c.kill('SIGKILL'));
          });
        }
        if (cancelled) { // spawn 직전에 받은 신호
          c.kill('SIGTERM');
          stopSignalKill = d.after(opts.killGraceMs, () => c.kill('SIGKILL'));
        }
        result = await c.done;
      } catch (e) {
        result = { spawnError: e as Error };
      } finally {
        // 작업이 끝나면 예약된 모든 타이머를 취소한다 — 끝난 프로세스에 늦은 신호를 보내거나 CLI를 붙잡지 않게
        stopHeartbeat(); stopTimeout(); stopTimeoutKill(); stopSignalKill();
        child = null;
      }

      if ('spawnError' in result) {
        exitCode = 127; outcome = `작업 실행 실패(spawn): ${result.spawnError.message}`;
      } else if (timedOut) {
        exitCode = 124; outcome = `작업 시간 제한(${Math.round(opts.jobTimeoutMs / 60000)}분) 초과로 중단`;
      } else if (cancelled) {
        exitCode = SIGNAL_EXIT[cancelled] ?? 130; outcome = `작업 취소됨(${cancelled})`;
      } else if (result.code === 0) {
        exitCode = 0; outcome = '작업 성공(코드 0)';
      } else if (result.code !== null) {
        exitCode = result.code; outcome = `작업 실패(코드 ${result.code})`;
      } else {
        exitCode = 1; outcome = `작업이 신호로 종료됨(${result.signal})`;
      }
    } catch (e) {
      if (e instanceof Cancelled) { exitCode = SIGNAL_EXIT[e.sig] ?? 130; outcome = `작업 시작 전 취소됨(${e.sig})`; }
      else { exitCode = 1; outcome = `작업 시작 전 실패: ${(e as Error).message}`; }
    }

    // ③ 정리 — 이 실행이 desired를 올린 경우에만. 호출 성공에 더해 desired=0을 다시 읽어 확인한다.
    // desired=0 확인은 종료 요청이 받아들여졌다는 뜻이며, 인스턴스 종료·과금 중단 시점까지 확인한 것은 아니다.
    let cleanup: RunResult['cleanup'] = 'not-needed';
    let cleanupMsg = '';
    if (asgName) {
      try {
        await d.api.setDesired(asgName, 0);
        const st = await d.api.getAsgStatus(asgName);
        if (st.desired !== 0) throw new Error(`정리 후에도 desired=${st.desired}`);
        cleanup = 'ok';
        cleanupMsg = 'GPU 용량을 0으로 되돌렸습니다(min/desired=0, 인스턴스 종료는 수 분 걸릴 수 있음 — tkf status로 확인)';
      } catch (e) {
        cleanup = 'failed';
        cleanupMsg = `GPU 정리 실패: ${(e as Error).message} — desired=1이 남아 있을 수 있습니다. ` +
          `즉시 tkf down --region ${opts.region} 로 정지하세요`;
        if (exitCode === 0) exitCode = 1;
      }
    }
    // 정리 성공 시에만 이전 상태 복원(다른 세션의 tkf down 대상 보존). 실패 시 run 리전 state를 남겨 tkf down이 찾게 한다
    const note = cleanup === 'failed' ? '' : restoreState();
    return { exitCode, cleanup, message: (cleanupMsg ? `${outcome}. ${cleanupMsg}` : outcome) + note };
  } finally {
    unSignal();
    release();
  }
}

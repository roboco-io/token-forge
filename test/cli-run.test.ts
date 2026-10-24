import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBatch, RunDeps, JobResult } from '../cli/commands/run';
import { acquireLock, lockHolder } from '../cli/lock';
import { resolveUsagePolicy } from '../lib/usage-mode';

const batch = resolveUsagePolicy({ usageMode: 'batch' });
const outputs = { EndpointUrl: 'https://cdn', ApiKeySecretArn: 'arn:sec', WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo',
  UsageMode: 'batch', IdleMinutes: '30' };
const opts = { model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2', policy: batch,
  command: ['python', 'job.py', '--flag', 'a b; rm -rf /'], bootTimeoutMs: 1000, jobTimeoutMs: 0, killGraceMs: 10 };

interface Harness {
  d: RunDeps;
  logs: string[];
  desired: number[];
  spawned: Array<{ cmd: string; args: string[]; env: Record<string, string> }>;
  kills: string[];
  saved: unknown[];
  probes: string[];
  fireSignal: (s: NodeJS.Signals) => void;
  fireTimers: () => void;
  finishJob: (r: JobResult) => void;
  failJob: (e: Error) => void;
  released: () => boolean;
  heartbeatStopped: () => boolean;
}

function harness(o: {
  asg?: { desired: number; instanceIds: string[]; inServiceIds: string[] };
  outputs?: Record<string, string> | null;
  probeAuth?: () => Promise<number>;
  setDesiredFail?: (n: number) => boolean;
  desiredAfterCleanup?: number;
  spawnThrows?: Error;
  lockThrows?: Error;
  onSpawn?: (h: Harness) => void;
  onReadyProbe?: (h: Harness) => void;
  prevState?: unknown;
} = {}): Harness {
  let signalHandler: ((s: NodeJS.Signals) => void) | null = null;
  let resolveJob: (r: JobResult) => void = () => undefined;
  let rejectJob: (e: Error) => void = () => undefined;
  const timers: Array<() => void> = [];
  let released = false; let hbStopped = false;
  let cleanedUp = false;
  const h = {
    logs: [] as string[], desired: [] as number[], spawned: [] as Harness['spawned'], kills: [] as string[], saved: [] as unknown[],
    probes: [] as string[],
  } as unknown as Harness;
  h.fireSignal = (s) => signalHandler?.(s);
  h.fireTimers = () => timers.splice(0).forEach((t) => t());
  h.finishJob = (r) => resolveJob(r);
  h.failJob = (e) => rejectJob(e);
  h.released = () => released;
  h.heartbeatStopped = () => hbStopped;
  h.d = {
    api: {
      getStackOutputs: async () => (o.outputs === undefined ? outputs : o.outputs),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => (cleanedUp ? { desired: o.desiredAfterCleanup ?? 0, instanceIds: [], inServiceIds: [] }
        : o.asg ?? { desired: 0, instanceIds: [], inServiceIds: [] }),
      setDesired: async (_a: string, n: number) => {
        if (o.setDesiredFail?.(n)) throw new Error(`setDesired(${n}) denied`);
        h.desired.push(n); if (n === 0) cleanedUp = true;
      },
      setCapacity: async () => undefined,
      getSecret: async () => 'SECRET-KEY',
      headObject: async () => true,
    },
    exec: async () => 0,
    probeAuth: async () => { const r = o.probeAuth ? await o.probeAuth() : 200; if (r === 200) o.onReadyProbe?.(h); return r; },
    probe: async (u: string) => { h.probes.push(u); return 401; },
    sleep: async () => undefined,
    log: (m: string) => { h.logs.push(m); },
    saveState: (s: unknown) => { h.saved.push(s); },
    loadState: () => (o.prevState ?? null) as never,
    acquireLock: () => { if (o.lockThrows) throw o.lockThrows; return () => { released = true; }; },
    spawnJob: (cmd: string, args: string[], env: Record<string, string>) => {
      if (o.spawnThrows) throw o.spawnThrows;
      h.spawned.push({ cmd, args, env });
      const done = new Promise<JobResult>((res, rej) => { resolveJob = res; rejectJob = rej; });
      setImmediate(() => o.onSpawn?.(h));
      return { done, kill: (s: NodeJS.Signals) => { h.kills.push(s); } };
    },
    onSignal: (fn: (s: NodeJS.Signals) => void) => { signalHandler = fn; return () => { signalHandler = null; }; },
    every: (_ms: number, fn: () => void) => { fn(); return () => { hbStopped = true; }; },
    after: (_ms: number, fn: () => void) => { timers.push(fn); return () => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); }; },
  } as never;
  return h;
}

test('성공: 인자 배열 그대로 spawn, 키는 env로만 전달·로그 비노출, 종료 후 GPU 0', async () => {
  const h = harness({ onSpawn: (x) => x.finishJob({ code: 0, signal: null }) });
  const r = await runBatch(opts, h.d);
  expect(r.exitCode).toBe(0);
  expect(h.spawned[0].cmd).toBe('python');
  expect(h.spawned[0].args).toEqual(['job.py', '--flag', 'a b; rm -rf /']); // 셸 결합 없음
  expect(h.spawned[0].env).toMatchObject({ TKF_ENDPOINT: 'https://cdn', TKF_API_KEY: 'SECRET-KEY', TKF_MODEL: 'Org/Repo',
    OPENAI_BASE_URL: 'https://cdn/v1', OPENAI_API_KEY: 'SECRET-KEY' });
  expect(h.logs.join('\n')).not.toContain('SECRET-KEY');
  expect(r.message).not.toContain('SECRET-KEY');
  expect(h.desired).toEqual([1, 0]);
  expect(h.released()).toBe(true);
  expect(h.heartbeatStopped()).toBe(true);
});

test('작업 중 하트비트가 엔드포인트를 핑해 무요청 유휴 종료를 막는다', async () => {
  const h = harness({ onSpawn: (x) => x.finishJob({ code: 0, signal: null }) });
  await runBatch(opts, h.d);
  expect(h.probes).toContain('https://cdn/v1/models');
});

test('자식 실패 코드 보존 + 정리', async () => {
  const h = harness({ onSpawn: (x) => x.finishJob({ code: 3, signal: null }) });
  const r = await runBatch(opts, h.d);
  expect(r.exitCode).toBe(3);
  expect(r.cleanup).toBe('ok');
  expect(h.desired).toEqual([1, 0]);
});

test('spawn 오류(ENOENT 동기 throw / 비동기 error) → 127 + 정리', async () => {
  const h1 = harness({ spawnThrows: Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }) });
  const r1 = await runBatch(opts, h1.d);
  expect(r1.exitCode).toBe(127);
  expect(h1.desired).toEqual([1, 0]);
  const h2 = harness({ onSpawn: (x) => x.failJob(new Error('spawn nope ENOENT')) });
  const r2 = await runBatch(opts, h2.d);
  expect(r2.exitCode).toBe(127);
  expect(r2.message).toContain('ENOENT');
  expect(h2.desired).toEqual([1, 0]);
});

test('작업 시간 제한: SIGTERM → 유예 후 SIGKILL, 124 + 정리', async () => {
  const h = harness({ onSpawn: (x) => { x.fireTimers(); x.fireTimers(); x.finishJob({ code: null, signal: 'SIGKILL' }); } });
  const r = await runBatch({ ...opts, jobTimeoutMs: 60000 }, h.d);
  expect(h.kills).toEqual(['SIGTERM', 'SIGKILL']);
  expect(r.exitCode).toBe(124);
  expect(r.message).toMatch(/시간 제한/);
  expect(h.desired).toEqual([1, 0]);
});

test.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('작업 중 %s → 자식 종료 요청 + 정리, 코드 %d', async (sig, code) => {
  const h = harness({ onSpawn: (x) => { x.fireSignal(sig); x.finishJob({ code: null, signal: 'SIGTERM' }); } });
  const r = await runBatch(opts, h.d);
  expect(h.kills[0]).toBe('SIGTERM');
  expect(r.exitCode).toBe(code);
  expect(r.message).toContain(sig);
  expect(h.desired).toEqual([1, 0]);
});

test('부팅 대기 중 SIGINT → 작업을 시작하지 않고 정리', async () => {
  let n = 0;
  const h = harness({ probeAuth: async () => { n += 1; if (n === 1) h.fireSignal('SIGINT'); return 503; } });
  const r = await runBatch(opts, h.d);
  expect(h.spawned).toHaveLength(0);
  expect(r.exitCode).toBe(130);
  expect(h.desired[h.desired.length - 1]).toBe(0);
});

test('부팅 시간 제한 → 작업 미실행, 실패 코드, GPU 0', async () => {
  const h = harness({ probeAuth: async () => 503 });
  const r = await runBatch({ ...opts, bootTimeoutMs: 0 }, h.d);
  expect(h.spawned).toHaveLength(0);
  expect(r.exitCode).not.toBe(0);
  expect(r.message).toMatch(/타임아웃/);
  expect(h.desired[h.desired.length - 1]).toBe(0);
});

test('정리 실패 시 성공으로 보고하지 않고 작업 결과와 정리 실패를 모두 보존', async () => {
  const ok = harness({ onSpawn: (x) => x.finishJob({ code: 0, signal: null }), setDesiredFail: (n) => n === 0 });
  const r = await runBatch(opts, ok.d);
  expect(r.exitCode).toBe(1);
  expect(r.cleanup).toBe('failed');
  expect(r.message).toMatch(/작업 성공/);
  expect(r.message).toMatch(/정리 실패.*denied/);
  expect(r.message).toContain('tkf down --region ap-northeast-2');

  const bad = harness({ onSpawn: (x) => x.finishJob({ code: 5, signal: null }), setDesiredFail: (n) => n === 0 });
  const r2 = await runBatch(opts, bad.d);
  expect(r2.exitCode).toBe(5);
  expect(r2.message).toMatch(/코드 5/);
  expect(r2.message).toMatch(/정리 실패/);
});

test('정리 호출이 성공해도 desired가 0으로 확인되지 않으면 정리 실패', async () => {
  const h = harness({ onSpawn: (x) => x.finishJob({ code: 0, signal: null }), desiredAfterCleanup: 1 });
  const r = await runBatch(opts, h.d);
  expect(r.cleanup).toBe('failed');
  expect(r.exitCode).toBe(1);
});

test('소유권: 이미 GPU가 도는 스택(다른 세션/online)은 인수·종료하지 않는다', async () => {
  const h = harness({ asg: { desired: 1, instanceIds: ['i-9'], inServiceIds: ['i-9'] },
    outputs: { ...outputs, UsageMode: 'online', IdleMinutes: '0' } });
  await expect(runBatch(opts, h.d)).rejects.toThrow(/인수하거나 종료하지 않습니다/);
  expect(h.desired).toEqual([]); // setDesired 호출 없음
  expect(h.spawned).toHaveLength(0);
  expect(h.released()).toBe(true);
});

test('동시 실행 잠금 실패 시 아무것도 건드리지 않는다', async () => {
  const h = harness({ lockThrows: new Error('다른 tkf run이 실행 중') });
  await expect(runBatch(opts, h.d)).rejects.toThrow(/실행 중/);
  expect(h.desired).toEqual([]);
});

test('batch가 아닌 정책·빈 명령은 거부', async () => {
  const h = harness();
  await expect(runBatch({ ...opts, policy: resolveUsagePolicy() }, h.d)).rejects.toThrow(/batch/);
  await expect(runBatch({ ...opts, command: [] }, h.d)).rejects.toThrow(/명령/);
});

test('정리 성공 시 이전 상태(state.json) 복원 — 다른 리전 대화형 세션의 down 대상 보존', async () => {
  const prev = { model: 'm', profile: 'p', region: 'us-west-2' };
  const h = harness({ onSpawn: (x) => x.finishJob({ code: 0, signal: null }), prevState: prev });
  await runBatch(opts, h.d);
  expect(h.saved[h.saved.length - 1]).toEqual(prev);
});

test('정리 실패 시에는 run 리전 상태를 남겨 tkf down이 찾을 수 있게 한다', async () => {
  const prev = { model: 'm', profile: 'p', region: 'us-west-2' };
  const h = harness({ onSpawn: (x) => x.finishJob({ code: 0, signal: null }), prevState: prev, setDesiredFail: (n) => n === 0 });
  await runBatch(opts, h.d);
  expect(h.saved[h.saved.length - 1]).toMatchObject({ region: 'ap-northeast-2' });
});

describe('acquireLock — 같은 호스트 잠금 (자동 회수 없음)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkf-lock-'));
  test('보유 중이면 pid·파일 경로와 함께 거부, 해제 후 재획득', () => {
    const rel = acquireLock(dir, 'S@r', 111);
    expect(lockHolder(dir, 'S@r')).toBe('111');
    expect(() => acquireLock(dir, 'S@r', 222)).toThrow(/pid 111.*rm /);
    rel();
    expect(lockHolder(dir, 'S@r')).toBeNull();
    acquireLock(dir, 'S@r', 222)();
  });
  test('남은(죽은 프로세스·빈) 잠금도 자동 회수하지 않는다 — 수동 해제 안내', () => {
    acquireLock(dir, 'S@x', 999999); // 해제하지 않음 = 비정상 종료 흉내
    expect(() => acquireLock(dir, 'S@x', 444)).toThrow(/999999/);
    fs.writeFileSync(path.join(dir, 'locks', 'S@e.lock'), '');
    expect(() => acquireLock(dir, 'S@e', 444)).toThrow(/알 수 없음/);
  });
  test('다른 pid의 잠금은 해제 함수가 지우지 않는다, 임시 파일을 남기지 않는다', () => {
    const rel = acquireLock(dir, 'S@y', 1);
    fs.writeFileSync(path.join(dir, 'locks', 'S@y.lock'), '2');
    rel();
    expect(lockHolder(dir, 'S@y')).toBe('2');
    expect(fs.readdirSync(path.join(dir, 'locks')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  test('키의 경로 문자는 파일명으로 정규화', () => {
    acquireLock(dir, '../evil/S@r', 1)();
    expect(fs.existsSync(path.join(dir, '..', 'evil'))).toBe(false);
  });
});

test('소유권: desired=0이어도 Pending/Terminating 인스턴스가 남아 있으면 거부', async () => {
  const h = harness({ asg: { desired: 0, instanceIds: ['i-term'], inServiceIds: [] } });
  await expect(runBatch(opts, h.d)).rejects.toThrow(/인수하거나 종료하지 않습니다/);
  expect(h.desired).toEqual([]);
});

test('배포 후 desired를 올리기 직전 재검사 — 그 사이 다른 세션이 올린 GPU는 건드리지 않는다', async () => {
  let calls = 0;
  const h = harness();
  const api = (h.d as unknown as { api: { getAsgStatus: () => Promise<unknown> } }).api;
  api.getAsgStatus = async () => (++calls === 1 ? { desired: 0, instanceIds: [], inServiceIds: [] }
    : { desired: 1, instanceIds: ['i-other'], inServiceIds: [] });
  const r = await runBatch(opts, h.d);
  expect(r.exitCode).toBe(1);
  expect(r.cleanup).toBe('not-needed');
  expect(r.message).toMatch(/다른 세션/);
  expect(h.desired).toEqual([]); // setDesired(1)도 정리 setDesired(0)도 없음
  expect(h.released()).toBe(true);
});

test('취소 신호로 예약한 SIGKILL 타이머는 작업 종료 시 취소된다 (늦은 신호 없음)', async () => {
  const h = harness({ onSpawn: (x) => { x.fireSignal('SIGINT'); x.finishJob({ code: 0, signal: null }); } });
  await runBatch(opts, h.d);
  h.fireTimers(); // 남은 타이머가 있다면 여기서 SIGKILL을 보낼 것
  expect(h.kills).toEqual(['SIGTERM']);
});

test('loadState 실패 등 잠금 이후 예외에도 잠금·신호 핸들러 해제', async () => {
  const h = harness();
  let unsub = false;
  (h.d as unknown as Record<string, unknown>).loadState = () => { throw new Error('state.json 손상'); };
  const onSignal = (h.d as unknown as { onSignal: (f: unknown) => () => void }).onSignal;
  (h.d as unknown as Record<string, unknown>).onSignal = (f: unknown) => { const u = onSignal(f); return () => { unsub = true; u(); }; };
  await expect(runBatch(opts, h.d)).rejects.toThrow(/손상/);
  expect(h.released()).toBe(true);
  expect(unsub).toBe(true);
});

test('이전 상태 복원 실패는 GPU 정리 실패와 구분된다', async () => {
  const prev = { model: 'm', profile: 'p', region: 'us-west-2' };
  const h = harness({ onSpawn: (x) => x.finishJob({ code: 0, signal: null }), prevState: prev });
  (h.d as unknown as Record<string, unknown>).saveState = (s: unknown) => { if (s === prev) throw new Error('disk full'); };
  const r = await runBatch(opts, h.d);
  expect(r.cleanup).toBe('ok');
  expect(r.exitCode).toBe(0);
  expect(r.message).toMatch(/state\.json 복원 실패.*disk full/);
});

describe('실제 로컬 자식 프로세스 (AWS는 mock, spawnJob·타이머는 실물)', () => {
  const { spawnJob } = require('../cli/program');
  const realTimers = {
    every: (ms: number, fn: () => void) => { const t = setInterval(fn, ms); fn(); return () => clearInterval(t); },
    after: (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitDead = async (pid: number) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };
  // 자식: SIGTERM을 무시하고, 손자(sleep 대용 node)를 띄운 뒤 그 pid를 파일에 남긴다
  const script = (pidFile: string) => [process.execPath, '-e',
    `process.on('SIGTERM',()=>{});const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`];

  function realHarness(extra: Record<string, unknown> = {}) {
    const h = harness();
    Object.assign(h.d as unknown as Record<string, unknown>, { spawnJob, ...realTimers, ...extra });
    return h;
  }

  test('시간 제한: SIGTERM 무시 자식 → 유예 후 SIGKILL, 손자까지 종료, 124 + 정리', async () => {
    const pidFile = path.join(os.tmpdir(), `tkf-gc-${process.pid}-1`);
    const h = realHarness();
    const r = await runBatch({ ...opts, command: script(pidFile), jobTimeoutMs: 1500, killGraceMs: 300 }, h.d);
    expect(r.exitCode).toBe(124);
    expect(h.desired).toEqual([1, 0]);
    expect(await waitDead(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 15000);

  test('SIGINT 취소: 실제 자식에 SIGTERM→SIGKILL, 130 + 정리', async () => {
    const pidFile = path.join(os.tmpdir(), `tkf-gc-${process.pid}-2`);
    let fire: (s: NodeJS.Signals) => void = () => undefined;
    const h = realHarness({ onSignal: (fn: (s: NodeJS.Signals) => void) => { fire = fn; return () => undefined; } });
    const p = runBatch({ ...opts, command: script(pidFile), killGraceMs: 300 }, h.d);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    fire('SIGINT');
    const r = await p;
    expect(r.exitCode).toBe(130);
    expect(h.desired).toEqual([1, 0]);
    expect(await waitDead(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 15000);

  test('정상 종료한 자식이 남긴 손자도 정리, 종료 코드 보존', async () => {
    const pidFile = path.join(os.tmpdir(), `tkf-gc-${process.pid}-3`);
    const h = realHarness();
    const r = await runBatch({ ...opts, command: [process.execPath, '-e',
      `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.exit(4)`] }, h.d);
    expect(r.exitCode).toBe(4);
    expect(await waitDead(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 15000);

  test('없는 명령 → 127 + 정리', async () => {
    const h = realHarness();
    const r = await runBatch({ ...opts, command: ['tkf-no-such-cmd-43'] }, h.d);
    expect(r.exitCode).toBe(127);
    expect(h.desired).toEqual([1, 0]);
  });
});

test('READY 후 API 키 조회 중 SIGINT → 자식 명령을 시작하지 않고 정리', async () => {
  const h = harness();
  const api = (h.d as unknown as { api: { getSecret: () => Promise<string> } }).api;
  let n = 0;
  api.getSecret = async () => { n += 1; if (n === 2) h.fireSignal('SIGINT'); return 'SECRET-KEY'; }; // 1회차는 waitReady, 2회차는 runBatch
  const r = await runBatch(opts, h.d);
  expect(h.spawned).toHaveLength(0);
  expect(r.exitCode).toBe(130);
  expect(h.desired).toEqual([1, 0]);
});

import { ensureStackReady, runUp, runUpAuto, waitReady } from '../cli/commands/up';
import { runDown } from '../cli/commands/down';
import { DEFAULT_CONFIG } from '../cli/config';
import { resolveUsagePolicy } from '../lib/usage-mode';

const base = { EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec', WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' };
const EMPTY = JSON.stringify({ v: 1, allowedCidrs: '', azs: '', alertEmail: '' });
const SECURED = JSON.stringify({ v: 1, allowedCidrs: '203.0.113.0/24,198.51.100.7/32', azs: 'us-east-1a,us-east-1b', alertEmail: 'ops@example.com' });
const withMode = (mode: string, idle: string, ds = EMPTY) => ({ ...base, UsageMode: mode, IdleMinutes: idle, DeploymentSettings: ds });
const opts = { model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' };

function mk(o: { outputs?: Record<string, string> | null; afterDeploy?: Record<string, string>; asg?: { desired: number; instanceIds: string[]; inServiceIds: string[] }; setCapacity?: () => Promise<void> } = {}) {
  const execs: string[] = [];
  const caps: Array<[number, number]> = [];
  const desired: number[] = [];
  let deployed = false;
  const d = {
    api: {
      getStackOutputs: async () => (deployed ? (o.afterDeploy ?? base) : o.outputs === undefined ? base : o.outputs),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => o.asg ?? { desired: 0, instanceIds: [], inServiceIds: [] },
      setDesired: async (_a: string, n: number) => { desired.push(n); },
      setCapacity: o.setCapacity ?? (async (_a: string, min: number, des: number) => { caps.push([min, des]); }),
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    exec: async (cmd: string, args: string[]) => { execs.push([cmd, ...args].join(' ')); deployed = true; return 0; },
    probeAuth: async () => 200,
    sleep: async () => undefined,
    saveState: () => undefined,
    log: () => undefined,
    timeoutMs: 1000,
  };
  return { d: d as never, execs, caps, desired };
}

describe('기존 스택 정책 비교 → cdk deploy 결정', () => {
  test('신규 스택: minCapacity=0 + 요청 모드 컨텍스트로 생성', async () => {
    const { d, execs } = mk({ outputs: null, afterDeploy: { ...base, UsageMode: 'online', IdleMinutes: '0' } });
    await ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d);
    expect(execs[0]).toContain('minCapacity=0');
    expect(execs[0]).toContain('usageMode=online');
    expect(execs[0]).toContain('idleMinutes=0');
  });
  test('정책이 같으면 배포를 건너뛴다', async () => {
    const { d, execs } = mk({ outputs: { ...base, UsageMode: 'interactive', IdleMinutes: '30' } });
    await ensureStackReady({ ...opts, policy: resolveUsagePolicy() }, d);
    expect(execs).toEqual([]);
  });
  test('기존 스택의 모드가 다르면 cdk deploy로 반영한다 (존재만 보고 건너뛰지 않음)', async () => {
    const { d, execs } = mk({ outputs: withMode('interactive', '30'), afterDeploy: withMode('online', '0') });
    await ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d);
    expect(execs).toHaveLength(1);
    expect(execs[0]).toContain('usageMode=online');
  });
  test('idleMinutes만 달라도 반영한다', async () => {
    const { d, execs } = mk({ outputs: withMode('interactive', '30'), afterDeploy: withMode('interactive', '60') });
    await ensureStackReady({ ...opts, policy: resolveUsagePolicy({ idleMinutes: 60 }) }, d);
    expect(execs[0]).toContain('idleMinutes=60');
  });
  test('배포 후에도 출력이 요청 정책과 다르면 실패 (조용한 누락 방지)', async () => {
    const { d } = mk({ outputs: withMode('interactive', '30'), afterDeploy: withMode('interactive', '30') });
    await expect(ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d)).rejects.toThrow(/정책/);
  });
  test('policy 미지정(seed 경로)은 기존 스택을 건드리지 않는다', async () => {
    const { d, execs } = mk({ outputs: base });
    await ensureStackReady(opts, d);
    expect(execs).toEqual([]);
  });
  test('배치 작업이 도는 스택을 대화형/온라인으로 바꾸지 않는다', async () => {
    const { d, execs } = mk({ outputs: { ...base, UsageMode: 'batch', IdleMinutes: '30' },
      asg: { desired: 1, instanceIds: ['i-1'], inServiceIds: ['i-1'] } });
    await expect(ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d)).rejects.toThrow(/배치/);
    expect(execs).toEqual([]);
  });
});

describe('정책 갱신 시 allowedCidrs·azs·alertEmail 보존', () => {
  const hasCtx = (cmd: string, kv: string) => cmd.split(' ').includes(kv);
  test.each([
    ['interactive→online', withMode('interactive', '30', SECURED), { usageMode: 'online' }],
    ['idleMinutes 변경', withMode('interactive', '30', SECURED), { idleMinutes: 60 }],
    ['online→interactive', withMode('online', '0', SECURED), {}],
    ['interactive→batch', withMode('interactive', '30', SECURED), { usageMode: 'batch' }],
  ])('%s: 기존 설정을 그대로 다시 전달', async (_n, outputs, input) => {
    const policy = resolveUsagePolicy({ ...input, minCapacity: 0 });
    const { d, execs } = mk({ outputs, afterDeploy: { ...withMode(policy.mode, String(policy.idleMinutes), SECURED) } });
    await ensureStackReady({ ...opts, policy }, d);
    expect(execs).toHaveLength(1);
    for (const kv of ['allowedCidrs=203.0.113.0/24,198.51.100.7/32', 'azs=us-east-1a,us-east-1b', 'alertEmail=ops@example.com']) {
      expect(hasCtx(execs[0], kv)).toBe(true);
    }
  });
  test('빈 설정은 컨텍스트를 추가하지 않는다 (CLI 신규 생성 스택)', async () => {
    const { d, execs } = mk({ outputs: withMode('interactive', '30'), afterDeploy: withMode('online', '0') });
    await ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d);
    expect(execs[0]).not.toMatch(/allowedCidrs|azs=|alertEmail/);
  });
  test('배포 후 설정 출력이 달라지면 실패 (보존 실패를 성공으로 보고하지 않음)', async () => {
    const { d } = mk({ outputs: withMode('interactive', '30', SECURED), afterDeploy: withMode('online', '0', EMPTY) });
    await expect(ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d)).rejects.toThrow(/설정/);
  });
  test('설정 출력이 없는 스택은 자동 배포하지 않고 수동 갱신 명령을 안내', async () => {
    const { d, execs } = mk({ outputs: { ...base, UsageMode: 'interactive', IdleMinutes: '30' } });
    await expect(ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d))
      .rejects.toThrow(/npx cdk deploy .*usageMode=online.*allowedCidrs/);
    expect(execs).toEqual([]);
  });
  test.each(['not json', JSON.stringify({ v: 2, allowedCidrs: '', azs: '', alertEmail: '' }), JSON.stringify({ v: 1, allowedCidrs: 5 })])(
    '손상·미지원 설정(%s)은 기본값으로 바꾸지 않고 거부', async (ds) => {
      const { d, execs } = mk({ outputs: withMode('interactive', '30', ds) });
      await expect(ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d)).rejects.toThrow(/DeploymentSettings/);
      expect(execs).toEqual([]);
    });
  test('구버전 스택 + 기본 interactive 요청은 배포 없이 그대로 사용 (기존 동작 호환)', async () => {
    const { d, execs } = mk({ outputs: base });
    await ensureStackReady({ ...opts, policy: resolveUsagePolicy({ minCapacity: 0 }) }, d);
    expect(execs).toEqual([]);
  });
  test('구버전 스택 + 모드 변경 요청은 자동 배포하지 않는다', async () => {
    const { d, execs } = mk({ outputs: base });
    await expect(ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d)).rejects.toThrow(/수동/);
    expect(execs).toEqual([]);
  });
  test('정책이 같으면 설정 출력이 없어도 배포하지 않는다', async () => {
    const { d, execs } = mk({ outputs: { ...base, UsageMode: 'online', IdleMinutes: '0' } });
    await ensureStackReady({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d);
    expect(execs).toEqual([]);
  });
});

describe('같은 호스트 batch 준비 중 인수 방지', () => {
  test('tkf run 잠금이 있으면 up/seed의 ensure는 아무것도 하지 않고 거부', async () => {
    const { d, execs } = mk({ outputs: { ...base, UsageMode: 'batch', IdleMinutes: '30' } });
    (d as { batchLockHolder?: unknown }).batchLockHolder = (k: string) => (k === 'TokenForge-qwen3-coder-30b-fp8@ap-northeast-2' ? '4242' : null);
    await expect(ensureStackReady({ ...opts, policy: resolveUsagePolicy() }, d)).rejects.toThrow(/pid 4242/);
    await expect(ensureStackReady(opts, d)).rejects.toThrow(/pid 4242/);
    expect(execs).toEqual([]);
  });
  test('batch 스택에 Terminating 인스턴스가 남아 있으면 모드 변경 거부', async () => {
    const { d } = mk({ outputs: { ...base, UsageMode: 'batch', IdleMinutes: '30' }, asg: { desired: 0, instanceIds: ['i-t'], inServiceIds: [] } });
    await expect(ensureStackReady({ ...opts, policy: resolveUsagePolicy() }, d)).rejects.toThrow(/배치/);
  });
});

describe('online READY 후 min=1, down은 min/desired=0', () => {
  test('online: READY 후 setCapacity(min1, desired1)', async () => {
    const { d, caps } = mk({ outputs: { ...base, UsageMode: 'online', IdleMinutes: '0' } });
    await runUp({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d);
    expect(caps).toEqual([[1, 1]]);
  });
  test('interactive: min은 건드리지 않는다', async () => {
    const { d, caps } = mk({ outputs: { ...base, UsageMode: 'interactive', IdleMinutes: '30' } });
    await runUp({ ...opts, policy: resolveUsagePolicy() }, d);
    expect(caps).toEqual([]);
  });
  test('online min=1 적용 실패는 성공으로 보고하지 않는다', async () => {
    const { d } = mk({ outputs: { ...base, UsageMode: 'online', IdleMinutes: '0' }, setCapacity: async () => { throw new Error('denied'); } });
    const saved: unknown[] = [];
    (d as { saveState: unknown }).saveState = (s: unknown) => { saved.push(s); };
    await expect(runUp({ ...opts, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d)).rejects.toThrow(/min=1.*denied.*tkf down/);
    expect(saved).toEqual([{ model: opts.model, profile: opts.profile, region: opts.region }]); // tkf down이 대상을 찾을 수 있음
  });
  test('online 준비 단계(READY 전)에는 min=1을 걸지 않는다 — 타임아웃 시 0으로 복원', async () => {
    const { d, caps, desired } = mk({ outputs: { ...base, UsageMode: 'online', IdleMinutes: '0' } });
    (d as { probeAuth: unknown }).probeAuth = async () => 503;
    (d as { timeoutMs: number }).timeoutMs = 0;
    await expect(waitReady({ stackName: 'S', outputs: base, policy: resolveUsagePolicy({ usageMode: 'online' }) }, d)).rejects.toThrow(/타임아웃/);
    expect(caps).toEqual([]);
    expect(desired[desired.length - 1]).toBe(0);
  });
  test('runUp에 batch 정책은 거부 (tkf run 전용)', async () => {
    const { d } = mk();
    await expect(runUp({ ...opts, policy: resolveUsagePolicy({ usageMode: 'batch' }) }, d)).rejects.toThrow(/tkf run/);
  });
  test('down: online 스택도 setDesired(0) (= MinSize 0, Desired 0) 로 종료', async () => {
    const set: number[] = [];
    await runDown(opts, false, { api: { getStackOutputs: async () => ({ ...base, UsageMode: 'online' }), getAsgName: async () => 'a',
      setDesired: async (_a: string, n: number) => { set.push(n); }, emptyAndDeleteBucket: async () => undefined }, exec: async () => 0 } as never);
    expect(set).toEqual([0]);
  });
});

describe('자동 리전 경로도 모드를 전달', () => {
  test('ensure·wait 양쪽에 policy 전달 (race·lazy 공통)', async () => {
    for (const standby of ['race', 'lazy', 'single'] as const) {
      const ensured: unknown[] = []; const waited: unknown[] = [];
      const policy = resolveUsagePolicy({ usageMode: 'online' });
      await runUpAuto({ model: 'm', profile: 'p', policy }, {
        config: { ...DEFAULT_CONFIG, standby },
        gather: async () => ({ cands: [
          { region: 'r1', score: 8, scoreSource: 'feed48h', rttMs: 30, price: 2, cached: true },
          { region: 'r2', score: 7, scoreSource: 'feed48h', rttMs: 30, price: 2, cached: true }], notices: [] }),
        ensure: async (o: { policy?: unknown }) => { ensured.push(o.policy); return { outputs: { EndpointUrl: 'e' }, stackName: 'S' }; },
        asgNameFor: async (r: string) => `asg-${r}`,
        race: async (e: unknown[]) => e[0],
        wait: async (a: { policy?: unknown }) => { waited.push(a.policy); return { endpoint: 'e' }; },
        saveState: () => undefined, log: () => undefined, now: () => new Date(),
      } as never);
      expect(ensured.length).toBeGreaterThan(0);
      expect(ensured.every((p) => p === policy)).toBe(true);
      expect(waited).toEqual([policy]);
    }
  });
});

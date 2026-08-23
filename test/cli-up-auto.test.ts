import { runUpAuto } from '../cli/commands/up';
import { DEFAULT_CONFIG } from '../cli/config';
import { Candidate } from '../cli/placement/engine';

const cands: Candidate[] = [
  { region: 'ap-northeast-1', score: 8, scoreSource: 'feed48h', rttMs: 35, price: 2.7, cached: true },
  { region: 'ap-northeast-2', score: 7.8, scoreSource: 'feed48h', rttMs: 30, price: 2.6, cached: true },
  { region: 'us-east-1', score: 4, scoreSource: 'feed48h', rttMs: 180, price: 2.3, cached: false },
];

function makeDeps(overrides: Record<string, unknown> = {}) {
  const log: string[] = [];
  const ensured: string[] = [];
  const raced: string[][] = [];
  const saved: unknown[] = [];
  const deps = {
    config: { ...DEFAULT_CONFIG },
    gather: async () => ({ cands, notices: [] }),
    ensure: async (o: { region: string }) => {
      ensured.push(o.region);
      return { outputs: { EndpointUrl: `http://${o.region}`, ApiKeySecretArn: 'arn', WeightsBucketName: 'b', WeightsRepo: 'O/M' }, stackName: 'S' };
    },
    asgNameFor: async (region: string) => `asg-${region}`,
    race: async (entrants: { region: string }[]) => { raced.push(entrants.map((e) => e.region)); return entrants[0] as never; },
    wait: async (a: { outputs: Record<string, string> }) => ({ endpoint: a.outputs.EndpointUrl }),
    saveState: (s: unknown) => { saved.push(s); },
    log: (m: string) => { log.push(m); },
    now: () => new Date('2026-08-23T12:00:00Z'),
    ...overrides,
  };
  return { deps, log, ensured, raced, saved };
}

test('race 모드(기본): 상위 K=2 준비 → 레이스 → 승자에서 READY → 상태 저장', async () => {
  const { deps, ensured, raced, saved } = makeDeps();
  const r = await runUpAuto({ model: 'm', profile: 'p' }, deps as never);
  // 서열 1위 apne2(RTT 동치→저가), 2위 apne1
  expect(ensured).toEqual(['ap-northeast-2', 'ap-northeast-1']); // 순차 ensure (cdk 충돌 방지)
  expect(raced).toEqual([['ap-northeast-2', 'ap-northeast-1']]);
  expect(r.region).toBe('ap-northeast-2'); // race 스텁이 첫 entrant 반환
  const st = saved[saved.length - 1] as { region: string; standbyRegions: string[]; lastUsed: Record<string, string> };
  expect(st.region).toBe('ap-northeast-2');
  expect(st.standbyRegions).toEqual(['ap-northeast-2', 'ap-northeast-1']);
  expect(st.lastUsed['ap-northeast-2']).toBe('2026-08-23T12:00:00.000Z');
});

test('single 모드: 1위 리전만, 레이스 없음', async () => {
  const { deps, ensured, raced } = makeDeps({ config: { ...DEFAULT_CONFIG, standby: 'single' } });
  const r = await runUpAuto({ model: 'm', profile: 'p' }, deps as never);
  expect(ensured).toEqual(['ap-northeast-2']);
  expect(raced).toHaveLength(0);
  expect(r.region).toBe('ap-northeast-2');
});

test('lazy 모드: 레이스 후 패자 정리 제안 로그', async () => {
  const { deps, log } = makeDeps({ config: { ...DEFAULT_CONFIG, standby: 'lazy' } });
  await runUpAuto({ model: 'm', profile: 'p' }, deps as never);
  expect(log.some((l) => l.includes('tkf down --purge --region ap-northeast-1'))).toBe(true);
});

test('캐시 상한 초과 시 LRU 정리 제안', async () => {
  const { deps, log } = makeDeps({
    loadState: () => ({ model: 'm', profile: 'p', region: 'ap-northeast-2',
      lastUsed: { 'us-east-1': '2026-08-01T00:00:00Z', 'us-west-2': '2026-08-10T00:00:00Z' } }),
  });
  await runUpAuto({ model: 'm', profile: 'p' }, deps as never);
  // race cap=K=2, 기존 2 + 신규 2 = 4 > 2 → 가장 오래된 us-east-1 정리 제안
  expect(log.some((l) => l.includes('us-east-1') && l.includes('--purge'))).toBe(true);
});

import { pickLeader, rank, gatherCandidates, Candidate } from '../cli/placement/engine';
import { DEFAULT_CONFIG } from '../cli/config';
import { FeedData } from '../cli/placement/feed';

const T = { score: 1, rttMs: 30 };
const c = (region: string, score: number, rttMs: number, price: number | null): Candidate =>
  ({ region, score, scoreSource: 'feed48h', rttMs, price, cached: false });

describe('pickLeader — 안정성 → 레이턴시 → 가격, 동치 임계값', () => {
  test('점수 차 1 이상이면 점수가 결정', () => {
    expect(pickLeader([c('a', 8, 200, 1), c('b', 6.9, 10, 0.5)], T).region).toBe('a');
  });
  test('점수 차 1 미만은 동점 — RTT 30ms 이상 차이가 결정', () => {
    expect(pickLeader([c('a', 8, 200, 1), c('b', 7.5, 40, 9)], T).region).toBe('b');
  });
  test('점수·RTT 모두 동점이면 최저가', () => {
    expect(pickLeader([c('a', 8, 40, 3.0), c('b', 7.5, 50, 2.5)], T).region).toBe('b');
  });
  test('가격 null은 최후순위', () => {
    expect(pickLeader([c('a', 8, 40, null), c('b', 8, 45, 2.5)], T).region).toBe('b');
  });
});

describe('rank', () => {
  test('leader 반복 제거로 전체 서열', () => {
    const out = rank([c('a', 8, 200, 1), c('b', 7.5, 40, 9), c('d', 3, 10, 0.1)], T);
    expect(out.map((x) => x.region)).toEqual(['b', 'a', 'd']);
  });
});

describe('gatherCandidates', () => {
  const NOW = new Date('2026-08-23T12:00:00Z');
  const feed: FeedData = {
    generated: '', types: ['g6e.12xlarge'], regions: ['ap-northeast-1', 'ap-northeast-2'],
    scores: { 'g6e.12xlarge': { 'ap-northeast-1': [['2026-08-23T11:00:00Z', 8]] } }, // apne2는 미커버
    prices: { 'g6e.12xlarge': { 'ap-northeast-1': [['2026-08-23T11:00:00Z', 2.7]] } },
  };
  const apiFor = (region: string) => ({
    getSpotVcpuQuota: async () => 192,
    getVcpuCount: async () => 48,
    getPlacementScore: async () => (region === 'ap-northeast-2' ? 5 : null),
    getCurrentSpotPrice: async () => 2.61,
    getStackOutputs: async () => (region === 'ap-northeast-2' ? { WeightsBucketName: 'b', WeightsRepo: 'Org/M' } : null),
    headObject: async () => true,
  });
  const deps = {
    config: DEFAULT_CONFIG, fetchFeed: async () => feed, apiFor,
    getRtt: async (r: string) => (r === 'ap-northeast-2' ? 30 : 35), now: () => NOW,
  };
  const opts = { types: ['g6e.12xlarge'], stackName: 'TokenForge-m-p', weightsRepo: 'Org/M' };

  test('피드 커버 리전은 feed48h, 미커버는 realtime 폴백 + 고지', async () => {
    const { cands, notices } = await gatherCandidates(opts, deps);
    const apne1 = cands.find((x) => x.region === 'ap-northeast-1')!;
    const apne2 = cands.find((x) => x.region === 'ap-northeast-2')!;
    expect(apne1.scoreSource).toBe('feed48h');
    expect(apne1.score).toBe(8);
    expect(apne2.scoreSource).toBe('realtime');
    expect(apne2.score).toBe(5);
    expect(apne2.cached).toBe(true); // 스택+마커 존재
    expect(notices.some((n) => n.includes('ap-northeast-2'))).toBe(true);
  });

  test('피드 전체 실패 → 전 리전 realtime + 고지', async () => {
    const { cands, notices } = await gatherCandidates(opts,
      { ...deps, fetchFeed: async () => { throw new Error('down'); } });
    expect(cands.every((x) => x.scoreSource === 'realtime')).toBe(true);
    expect(notices.some((n) => n.includes('피드'))).toBe(true);
  });

  test('쿼터 부족 리전은 제외, 전 리전 미달이면 가이드 안내 오류', async () => {
    const zeroQuota = (region: string) => ({ ...apiFor(region), getSpotVcpuQuota: async () => 0 });
    await expect(gatherCandidates(opts, { ...deps, apiFor: zeroQuota }))
      .rejects.toThrow('ec2-quota-guide');
  });

  test('realtime 점수도 null인 리전은 후보 제외', async () => {
    const noScore = (region: string) => ({ ...apiFor(region), getPlacementScore: async () => null });
    const { cands } = await gatherCandidates(opts, { ...deps, apiFor: noScore });
    expect(cands.map((x) => x.region)).toEqual(['ap-northeast-1']); // 피드 커버 리전만 남음
  });
});

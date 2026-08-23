import { runPlacement } from '../cli/commands/placement';
import { DEFAULT_CONFIG } from '../cli/config';
import { Candidate } from '../cli/placement/engine';

test('서열 순 표 + 상위 K 마킹 + 고지 포함', async () => {
  const cands: Candidate[] = [
    { region: 'ap-northeast-1', score: 8, scoreSource: 'feed48h', rttMs: 35, price: 2.7, cached: true },
    { region: 'us-east-1', score: 5, scoreSource: 'realtime', rttMs: 180, price: 2.3, cached: false },
  ];
  const lines = await runPlacement(
    { types: ['g6e.12xlarge'], stackName: 's', weightsRepo: 'O/M', k: 2 },
    {
      config: DEFAULT_CONFIG,
      fetchFeed: async () => { throw new Error('unused'); },
      apiFor: () => { throw new Error('unused'); },
      getRtt: async () => 0, now: () => new Date('2026-08-23T12:00:00Z'),
      thresholds: { score: 1, rttMs: 30 },
      gather: async () => ({ cands, notices: ['테스트 고지'] }),
    },
  );
  const text = lines.join('\n');
  expect(lines[0]).toContain('테스트 고지');
  expect(text).toMatch(/ap-northeast-1.*8\.0.*35ms.*\$2\.7.*있음/s); // 점수·RTT·가격·캐시
  expect(text).toContain('realtime'); // 폴백 출처 표시
  const apne1Line = lines.find((l) => l.includes('ap-northeast-1'))!;
  expect(apne1Line).toContain('*'); // 상위 K 마킹
});

import { avg48h, regionScore, regionPrice, fetchFeed, FeedData } from '../cli/placement/feed';

const NOW = new Date('2026-08-23T12:00:00Z');
const feed: FeedData = {
  generated: '2026-08-23 11:00 UTC',
  types: ['g6e.12xlarge', 'g6e.24xlarge'],
  regions: ['ap-northeast-1', 'ap-northeast-2', 'us-east-1'],
  noPool: { 'g6e.24xlarge': ['us-east-1'] },
  scores: {
    'g6e.12xlarge': {
      'ap-northeast-1': [['2026-08-21T10:00:00Z', 9], ['2026-08-22T12:00:00Z', 7], ['2026-08-23T11:00:00Z', 5]],
      'ap-northeast-2': [['2026-08-23T11:00:00Z', 3]],
    },
    'g6e.24xlarge': {
      'ap-northeast-2': [['2026-08-23T11:00:00Z', 8]],
      'us-east-1': [['2026-08-23T11:00:00Z', 9]], // noPool이므로 무시되어야 함
    },
  },
  prices: {
    'g6e.12xlarge': { 'ap-northeast-2': [['2026-08-23T11:00:00Z', 2.61]] },
    'g6e.24xlarge': { 'ap-northeast-2': [['2026-08-23T11:00:00Z', 5.2]] },
  },
};

describe('avg48h', () => {
  test('48시간 내 값만 평균 (2026-08-21T10시는 제외)', () => {
    expect(avg48h(feed.scores['g6e.12xlarge']['ap-northeast-1'], NOW)).toBe(6); // (7+5)/2
  });
  test('48시간 내 값 없으면 null', () => {
    expect(avg48h([['2026-08-01T00:00:00Z', 9]], NOW)).toBeNull();
  });
});

describe('regionScore', () => {
  test('프로파일 타입들 중 최대 48h 평균', () => {
    expect(regionScore(feed, ['g6e.12xlarge', 'g6e.24xlarge'], 'ap-northeast-2', NOW)).toBe(8);
  });
  test('noPool 타입은 제외 — us-east-1은 12xlarge 데이터도 없으므로 null', () => {
    expect(regionScore(feed, ['g6e.12xlarge', 'g6e.24xlarge'], 'us-east-1', NOW)).toBeNull();
  });
});

describe('regionPrice', () => {
  test('커버 타입 중 최저 최신가', () => {
    expect(regionPrice(feed, ['g6e.12xlarge', 'g6e.24xlarge'], 'ap-northeast-2')).toBe(2.61);
  });
  test('가격 데이터 없으면 null', () => {
    expect(regionPrice(feed, ['g6e.12xlarge'], 'us-east-1')).toBeNull();
  });
});

describe('fetchFeed', () => {
  test('주입된 fetch로 JSON 파싱', async () => {
    const fake = (async () => ({ ok: true, json: async () => feed })) as unknown as typeof fetch;
    expect((await fetchFeed('https://example.test/data.json', fake)).regions).toHaveLength(3);
  });
  test('HTTP 오류는 throw', async () => {
    const fake = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchFeed('https://example.test/data.json', fake)).rejects.toThrow('503');
  });
});

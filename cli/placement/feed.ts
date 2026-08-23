// cli/placement/feed.ts — 공개 스팟 인텔리전스 피드 소비 (익명 GET, 스펙 R2 허용 예외)
export interface FeedData {
  generated: string;
  types: string[];
  regions: string[];
  noPool?: Record<string, string[]>;
  scores: Record<string, Record<string, [string, number][]>>;
  prices: Record<string, Record<string, [string, number][]>>;
}

export async function fetchFeed(url: string, f: typeof fetch = fetch): Promise<FeedData> {
  const r = await f(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`피드 응답 ${r.status}`);
  return (await r.json()) as FeedData;
}

/** 최근 48시간 내 값들의 평균. 값이 없으면 null (스펙: 48h 평균 우선) */
export function avg48h(series: [string, number][], now: Date): number | null {
  const cutoff = now.getTime() - 48 * 3600 * 1000;
  const vals = series.filter(([ts]) => new Date(ts).getTime() >= cutoff).map(([, v]) => v);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** 프로파일 타입 후보들 중 피드가 커버하는 타입의 48h 평균 최대값. noPool 타입 제외 */
export function regionScore(feed: FeedData, types: string[], region: string, now: Date): number | null {
  let best: number | null = null;
  for (const t of types) {
    if ((feed.noPool?.[t] ?? []).includes(region)) continue;
    const series = feed.scores[t]?.[region];
    if (!series) continue;
    const avg = avg48h(series, now);
    if (avg !== null && (best === null || avg > best)) best = avg;
  }
  return best;
}

/** 커버 타입들의 최신가 중 최저. 없으면 null */
export function regionPrice(feed: FeedData, types: string[], region: string): number | null {
  let best: number | null = null;
  for (const t of types) {
    const series = feed.prices[t]?.[region];
    if (!series || series.length === 0) continue;
    const latest = series[series.length - 1][1];
    if (best === null || latest < best) best = latest;
  }
  return best;
}

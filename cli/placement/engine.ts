import { TfConfig } from '../config';
import { FeedData, regionScore, regionPrice } from './feed';
import { AwsApi } from '../aws';

export const DEFAULT_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'ap-northeast-1', 'ap-northeast-2'];

export interface Candidate {
  region: string;
  score: number;
  scoreSource: 'feed48h' | 'realtime';
  rttMs: number;
  price: number | null;
  cached: boolean; // 가중치 캐시(.complete) 존재 — 시딩 시간·비용 가산 판단용
}

export type EngineApi = Pick<AwsApi,
  'getSpotVcpuQuota' | 'getVcpuCount' | 'getPlacementScore' | 'getCurrentSpotPrice' | 'getStackOutputs' | 'headObject'>;

export interface GatherDeps {
  config: TfConfig;
  fetchFeed: (url: string) => Promise<FeedData>;
  apiFor: (region: string) => EngineApi;
  getRtt: (region: string) => Promise<number>;
  now: () => Date;
}

/** 스펙 R10 동치 기준: 점수 차 < t.score 동점 → RTT 차 < t.rttMs 동점 → 최저가 */
export function pickLeader(cands: Candidate[], t: { score: number; rttMs: number }): Candidate {
  const best = Math.max(...cands.map((c) => c.score));
  let pool = cands.filter((c) => best - c.score < t.score);
  const minRtt = Math.min(...pool.map((c) => c.rttMs));
  pool = pool.filter((c) => c.rttMs - minRtt < t.rttMs);
  return [...pool].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0];
}

export function rank(cands: Candidate[], t: { score: number; rttMs: number }): Candidate[] {
  const rest = [...cands];
  const out: Candidate[] = [];
  while (rest.length) {
    const leader = pickLeader(rest, t);
    out.push(leader);
    rest.splice(rest.indexOf(leader), 1);
  }
  return out;
}

export async function gatherCandidates(
  opts: { types: string[]; stackName: string; weightsRepo: string },
  d: GatherDeps,
): Promise<{ cands: Candidate[]; notices: string[] }> {
  const notices: string[] = [];
  let feed: FeedData | null = null;
  try { feed = await d.fetchFeed(d.config.feedUrl); }
  catch (e) { notices.push(`피드 접근 불가(${(e as Error).message}) — 전 리전 실시간 배치점수로 폴백`); }

  const regions = feed?.regions ?? DEFAULT_REGIONS;
  const family: 'g' | 'p' = opts.types[0].startsWith('p') ? 'p' : 'g';
  // 쿼터는 "가장 작은 후보 타입이라도 뜰 수 있는가"로 판정 (ASG가 리전 내 타입 레이스 수행)
  const vcpus = await Promise.all(opts.types.map((t) => d.apiFor(regions[0]).getVcpuCount(t)));
  const minVcpu = Math.min(...vcpus);

  const cands: Candidate[] = [];
  let quotaShort = 0;
  for (const region of regions) {
    const api = d.apiFor(region);
    const quota = await api.getSpotVcpuQuota(family);
    if (quota < minVcpu) { quotaShort++; continue; }

    let score = feed ? regionScore(feed, opts.types, region, d.now()) : null;
    let scoreSource: Candidate['scoreSource'] = 'feed48h';
    if (score === null) {
      score = await api.getPlacementScore(opts.types, region);
      scoreSource = 'realtime';
      if (score !== null && feed) notices.push(`${region}: 피드 미커버 — 실시간 배치점수로 폴백(추이 없음)`);
    }
    if (score === null) continue; // 점수를 얻을 수 없는 리전은 후보 제외

    const price = (feed ? regionPrice(feed, opts.types, region) : null) ?? (await api.getCurrentSpotPrice(opts.types[0]));
    const outputs = await api.getStackOutputs(opts.stackName);
    const cached = outputs
      ? await api.headObject(outputs.WeightsBucketName, `${opts.weightsRepo.replace(/\//g, '_')}/.complete`)
      : false;
    cands.push({ region, score, scoreSource, rttMs: await d.getRtt(region), price, cached });
  }

  if (cands.length === 0 && quotaShort > 0) {
    throw new Error('모든 후보 리전의 스팟 vCPU 쿼터가 부족합니다 — docs/ec2-quota-guide.md의 증설 가이드를 참고하세요');
  }
  if (cands.length === 0) throw new Error('배치점수를 얻을 수 있는 후보 리전이 없습니다 — --region으로 직접 지정하세요');
  return { cands, notices };
}

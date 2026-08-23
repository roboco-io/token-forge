import { Candidate, rank } from '../placement/engine';
import { ensureStackReady, UpDeps } from './up';

export interface SeedChoice { region: string; label: string; checked: boolean }

export interface SeedDeps {
  gather: () => Promise<{ cands: Candidate[]; notices: string[] }>;
  thresholds: { score: number; rttMs: number };
  k: number;
  /** ensureStackReady를 리전만 바꿔 호출하는 클로저 (program.ts에서 조립) — desired는 절대 올리지 않음 */
  ensure: (region: string) => Promise<void>;
  select: (choices: SeedChoice[]) => Promise<string[]>;
  log: (m: string) => void;
}

/**
 * ensureStackReady를 seed 전용으로 감싼 클로저 팩토리 (program.ts가 이것만 조립해 쓴다).
 * seed는 배포 추적(state.json)을 절대 건드리지 않는다 — 다른 리전에서 up이 GPU를
 * 가동 중일 때 seed로 또 다른 리전을 건드리면 실제 saveState가 state.json을 그
 * 리전으로 덮어써 tkf down(기본 대상 = state.region)이 엉뚱한(GPU 없는) 리전을
 * 내리고 활성 GPU는 비용 가드에서 놓쳐 방치된다. 그래서 주입된 saveState를 여기서
 * 강제로 no-op으로 덮어써 program.ts 배선 실수로도 오염될 수 없게 한다.
 */
export function mkSeedEnsure(
  model: string,
  profile: string,
  mkDeps: (region: string) => Pick<UpDeps, 'api' | 'exec' | 'log' | 'saveState'>,
): (region: string) => Promise<void> {
  return async (region: string) => {
    await ensureStackReady({ model, profile, region }, { ...mkDeps(region), saveState: () => {} });
  };
}

/** placement 표 행과 같은 정보 밀도의 라벨 (순위·48h점수·RTT·가격·캐시·출처) */
function labelFor(c: Candidate, rankIndex: number): string {
  return `${String(rankIndex + 1).padStart(2)}. ${c.region.padEnd(16)} ${c.score.toFixed(1).padStart(6)}점  ` +
    `${String(c.rttMs) + 'ms'}`.padEnd(7) + `  ${c.price !== null ? '$' + c.price : '-'}`.padEnd(9) +
    `  ${c.cached ? '캐시있음' : '캐시없음'}  ${c.scoreSource}`;
}

export async function runSeed(
  opts: { model: string; profile: string; region?: string },
  d: SeedDeps,
): Promise<string[]> {
  let regions: string[];
  if (opts.region) {
    regions = [opts.region];
  } else {
    const { cands, notices } = await d.gather();
    notices.forEach(d.log);
    const ranked = rank(cands, d.thresholds);
    const choices: SeedChoice[] = ranked.map((c, i) => ({
      region: c.region,
      label: labelFor(c, i),
      checked: i < d.k,
    }));
    regions = await d.select(choices);
  }

  if (regions.length === 0) {
    d.log('선택된 리전이 없습니다 — 종료');
    return [];
  }

  d.log('리전당 비용: 시딩 CPU 스팟 약 $0.03 + 스택 ALB 약 $16/월(S3 보관비 별도)');

  for (let i = 0; i < regions.length; i++) {
    d.log(`시딩 보장: ${regions[i]} (${i + 1}/${regions.length})`);
    await d.ensure(regions[i]);
  }

  return regions;
}

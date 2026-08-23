import { gatherCandidates, rank, GatherDeps, Candidate } from '../placement/engine';

export interface PlacementDeps extends GatherDeps {
  thresholds: { score: number; rttMs: number };
  /** 테스트 주입용 — 생략 시 gatherCandidates 사용 */
  gather?: (opts: { types: string[]; stackName: string; weightsRepo: string }, d: GatherDeps)
    => Promise<{ cands: Candidate[]; notices: string[] }>;
}

export async function runPlacement(
  opts: { types: string[]; stackName: string; weightsRepo: string; k: number },
  d: PlacementDeps,
): Promise<string[]> {
  const { cands, notices } = await (d.gather ?? gatherCandidates)(opts, d);
  const ranked = rank(cands, d.thresholds);
  const lines: string[] = [...notices];
  lines.push('순위  리전              48h점수  RTT     스팟가     캐시   출처');
  ranked.forEach((c, i) => {
    const mark = i < opts.k ? '*' : ' ';
    lines.push(
      `${mark}${String(i + 1).padEnd(4)} ${c.region.padEnd(16)} ${c.score.toFixed(1).padStart(6)}  ` +
      `${String(c.rttMs) + 'ms'}`.padEnd(7) + `  ${c.price !== null ? '$' + c.price : '-'}`.padEnd(9) +
      `  ${c.cached ? '있음' : '없음'}   ${c.scoreSource}`,
    );
  });
  lines.push(`(* = 기동 시 레이스 참여 후보 상위 ${opts.k}개, 우선순위: 안정성 → 레이턴시 → 가격)`);
  return lines;
}

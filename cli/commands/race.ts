import { AwsApi } from '../aws';

export interface RaceEntrant { region: string; asgName: string; endpointUrl: string }

export interface RaceDeps {
  apiFor: (region: string) => Pick<AwsApi, 'setDesired' | 'getAsgStatus'>;
  probe: (url: string) => Promise<number>; // 무인증 핑 — ALB 요청 카운트를 올려 유휴 알람 발화 차단
  sleep: (ms: number) => Promise<void>;
  log: (m: string) => void;
  timeoutMs: number;
}

/**
 * 전 후보 desired=1 동시 설정 → 첫 InService(인스턴스 확보) 리전이 승자 → 패자 즉시 desired=0.
 * 승자 판정은 부팅 완료가 아니라 확보 시점 (스펙: 패자를 부팅 전에 취소해 낭비 0 수렴).
 * 레이스 중 강등 복구·핑은 참여 전 후보에 적용 (스펙: 레이스 시작부터 승자 확정 시까지).
 */
export async function runRace(entrants: RaceEntrant[], d: RaceDeps): Promise<RaceEntrant> {
  await Promise.all(entrants.map((e) => d.apiFor(e.region).setDesired(e.asgName, 1)));
  d.log(`레이스 시작 — ${entrants.map((e) => e.region).join(', ')} 동시 확보 시도`);

  const deadline = Date.now() + d.timeoutMs;
  while (Date.now() < deadline) {
    for (const e of entrants) {
      const st = await d.apiFor(e.region).getAsgStatus(e.asgName);
      if (st.instanceIds.length > 0) {
        const losers = entrants.filter((x) => x !== e);
        await Promise.all(losers.map((l) => d.apiFor(l.region).setDesired(l.asgName, 0)));
        d.log(`승자: ${e.region} (패자 ${losers.map((l) => l.region).join(', ') || '없음'} 취소)`);
        return e;
      }
      if (st.desired === 0) { // 유휴 가드 강등 감지 → 복구 (스펙 교훈 반영 절)
        d.log(`${e.region}: 유휴 가드 강등 감지 — desired=1 복구`);
        await d.apiFor(e.region).setDesired(e.asgName, 1);
      }
      await d.probe(`${e.endpointUrl}/v1/models`);
    }
    await d.sleep(15000);
  }
  // 타임아웃: 전 후보 취소 (비용 가드 최우선 원칙)
  await Promise.all(entrants.map((e) => d.apiFor(e.region).setDesired(e.asgName, 0).catch(() => {})));
  throw new Error(`레이스 타임아웃(${Math.round(d.timeoutMs / 60000)}분) — 전 후보 리전에서 스팟 확보 실패. 용량을 0으로 되돌렸습니다`);
}

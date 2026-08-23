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
 * 승자 판정은 부팅 완료가 아니라 확보 시점이되, launching 상태는 아직 확보로 보지 않는다
 * (스펙 R10: launching이 실패할 수 있으므로 InService 확정 전에 패자를 취소하면 재확보 기회를
 * 잃는다). 레이스 중 강등 복구·핑은 참여 전 후보에 적용 (스펙: 레이스 시작부터 승자 확정 시까지).
 * 시작 설정(desired=1)도 일부 리전에서 실패할 수 있다 — 성공한 리전만으로 레이스를 계속하고
 * (실패 리전은 애초에 desired=1이 아니므로 정리 불요), 전 리전 실패 시에만 오류로 중단한다.
 */
export async function runRace(entrants: RaceEntrant[], d: RaceDeps): Promise<RaceEntrant> {
  const starts = await Promise.allSettled(entrants.map((e) => d.apiFor(e.region).setDesired(e.asgName, 1)));
  const active = entrants.filter((_, i) => starts[i].status === 'fulfilled');
  const startFailed = entrants.filter((_, i) => starts[i].status === 'rejected');
  for (const e of startFailed) d.log(`${e.region} 기동 설정 실패 — 레이스에서 제외`);

  if (active.length === 0) {
    const reasons = entrants.map((e, i) => {
      const r = starts[i];
      return r.status === 'rejected' ? `${e.region}: ${(r.reason as Error).message}` : null;
    }).filter((x): x is string => x !== null).join('; ');
    throw new Error(`레이스 시작 실패 — 전 후보 리전에서 기동 설정에 실패했습니다. ${reasons}`);
  }
  d.log(`레이스 시작 — ${active.map((e) => e.region).join(', ')} 동시 확보 시도`);

  const deadline = Date.now() + d.timeoutMs;
  while (Date.now() < deadline) {
    for (const e of active) {
      const st = await d.apiFor(e.region).getAsgStatus(e.asgName);
      if (st.inServiceIds.length > 0) {
        const losers = active.filter((x) => x !== e);
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
  // 타임아웃: 전 후보 취소 (비용 가드 최우선 원칙) — 취소 실패 리전은 오류 메시지에 보고
  const results = await Promise.allSettled(active.map((e) => d.apiFor(e.region).setDesired(e.asgName, 0)));
  const failed = active.filter((_, i) => results[i].status === 'rejected');
  const restoreMsg = failed.length === 0
    ? '용량을 0으로 되돌렸습니다'
    : `단, ${failed.map((e) => e.region).join(', ')}은(는) 되돌리기 실패 — tkf down --region <r>로 정리 필요`;
  throw new Error(`레이스 타임아웃(${Math.round(d.timeoutMs / 60000)}분) — 전 후보 리전에서 스팟 확보 실패. ${restoreMsg}`);
}

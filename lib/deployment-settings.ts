// 배포 설정 기록(#43) — 사용 모드와 무관한 보안·운영 컨텍스트(allowedCidrs/azs/alertEmail)를 스택 출력에 남겨,
// tkf CLI가 정책 갱신용 cdk deploy를 할 때 이 값을 그대로 다시 전달하게 한다. 누락하면 IP 허용목록이 풀리거나
// AZ 선택·알림 구독이 초기화되므로, 기록을 모르거나 해석할 수 없으면 자동 배포하지 않는다.

export const DEPLOYMENT_SETTINGS_VERSION = 1;
export const SETTINGS_KEYS = ['allowedCidrs', 'azs', 'alertEmail'] as const;

export interface DeploymentSettings { v: 1; allowedCidrs: string; azs: string; alertEmail: string }

/** 키 순서를 고정한 JSON — 출력 비교가 직렬화 순서에 흔들리지 않게 한다 */
export function encodeSettings(s: Omit<DeploymentSettings, 'v'>): string {
  return JSON.stringify({ v: DEPLOYMENT_SETTINGS_VERSION, allowedCidrs: s.allowedCidrs, azs: s.azs, alertEmail: s.alertEmail });
}

/** 스택 출력 해석. 없거나 손상·미지원 버전이면 throw — 기본값으로 대체하지 않는다 */
export function parseSettings(raw: string | undefined): DeploymentSettings {
  if (raw === undefined) throw new Error('DeploymentSettings 출력 없음');
  let o: unknown;
  try { o = JSON.parse(raw); } catch { throw new Error(`DeploymentSettings 출력을 해석할 수 없습니다: ${raw}`); }
  const r = o as Record<string, unknown>;
  if (!r || typeof r !== 'object' || r.v !== DEPLOYMENT_SETTINGS_VERSION
    || SETTINGS_KEYS.some((k) => typeof r[k] !== 'string')) {
    throw new Error(`DeploymentSettings 출력 형식이 올바르지 않거나 지원하지 않는 버전입니다: ${raw}`);
  }
  return { v: 1, allowedCidrs: r.allowedCidrs as string, azs: r.azs as string, alertEmail: r.alertEmail as string };
}

/** 값이 있는 설정만 -c 인자로 (인자 배열 — 셸을 거치지 않음) */
export function settingsContextArgs(s: DeploymentSettings): string[] {
  return SETTINGS_KEYS.flatMap((k) => (s[k] ? ['-c', `${k}=${s[k]}`] : []));
}

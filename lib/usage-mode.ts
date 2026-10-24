// 사용 모드(#43) — 모델 양자화 프로파일과 별개인 "GPU를 언제 켜고 끄는가" 정책.
// CDK 컨텍스트(-c usageMode/-c idleMinutes/-c minCapacity)와 CLI(--usage-mode/--idle-minutes)가
// 같은 해석기를 써서 두 경로의 정책이 어긋나지 않게 한다.

export const USAGE_MODES = ['interactive', 'batch', 'online'] as const;
export type UsageMode = typeof USAGE_MODES[number];

/** 유휴 알람은 ALB RequestCount 5분 주기로 평가된다 — 그 배수만 허용해 반올림으로 일찍 꺼지는 일을 막는다 */
export const IDLE_STEP_MINUTES = 5;
/** 평가 기간 상한: 5분 × 288 = 24시간 (CloudWatch 평가 기간 총합 1일 이내) */
export const IDLE_MAX_MINUTES = 1440;
/** 하위 호환: 기존 기본값 30분을 유지한다 (단축은 활동 감시가 생길 때까지 보류 — 계획 문서 참고) */
export const DEFAULT_IDLE_MINUTES = 30;

export interface UsagePolicy {
  mode: UsageMode;
  /** 0이면 유휴 알람 없음. batch에서는 작업 하트비트가 끊겼을 때만 발화하는 고아 GPU 백스톱 */
  idleMinutes: number;
  /** CDK가 ASG에 거는 MinSize (CLI 경로는 항상 0으로 생성하고 READY 이후 별도 적용) */
  minCapacity: 0 | 1;
  /** READY 이후 CLI가 적용할 MinSize — online만 1 */
  readyMinCapacity: 0 | 1;
}

export interface UsagePolicyInput {
  usageMode?: unknown;
  idleMinutes?: unknown;
  minCapacity?: unknown;
}

function isUnset(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

function parseMode(raw: unknown): UsageMode {
  if (isUnset(raw)) return 'interactive';
  const s = String(raw).trim();
  if (!(USAGE_MODES as readonly string[]).includes(s)) {
    throw new Error(`usageMode: 알 수 없는 값 "${s}" — ${USAGE_MODES.join('|')} 중 하나여야 합니다`);
  }
  return s as UsageMode;
}

/** 정수 문자열/숫자만 허용 ("30", 30). "1e2", "12.5", "-5" 등은 거부 */
function parseNonNegInt(name: string, raw: unknown): number {
  const s = typeof raw === 'number' ? String(raw) : String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${name}: 0 이상의 정수여야 합니다 (입력: "${String(raw)}")`);
  return Number(s);
}

function validateIdleWindow(mode: UsageMode, n: number): void {
  if (n % IDLE_STEP_MINUTES !== 0 || n < IDLE_STEP_MINUTES || n > IDLE_MAX_MINUTES) {
    throw new Error(`idleMinutes(${mode}): ${IDLE_STEP_MINUTES}의 배수이면서 ${IDLE_STEP_MINUTES}-${IDLE_MAX_MINUTES} 범위여야 합니다 ` +
      `(입력: ${n}) — CloudWatch가 ${IDLE_STEP_MINUTES}분 단위로 평가하므로 반올림하지 않습니다`);
  }
}

/**
 * 우선순위: 명시값 > 모드 기본값. 모드 목적과 충돌하는 명시값은 조용히 무시하지 않고 거부한다.
 * - interactive: idle 기본 30, 명시 0(비활성, 기존 호환) 또는 5분 배수. minCapacity 기본 1(직접 CDK 호환).
 * - batch: idle은 백스톱(기본 30, 0 거부 — 클라이언트 유실 시 GPU를 내릴 장치가 사라짐). minCapacity 1 거부.
 * - online: idle 비활성(0만 허용). minCapacity 기본 1, READY 이후 min=1.
 */
export function resolveUsagePolicy(input: UsagePolicyInput = {}): UsagePolicy {
  const mode = parseMode(input.usageMode);

  let idleMinutes: number;
  if (isUnset(input.idleMinutes)) {
    idleMinutes = mode === 'online' ? 0 : DEFAULT_IDLE_MINUTES;
  } else {
    idleMinutes = parseNonNegInt('idleMinutes', input.idleMinutes);
    if (mode === 'online' && idleMinutes !== 0) {
      throw new Error(`idleMinutes: online 모드는 유휴 종료를 쓰지 않습니다 (입력: ${idleMinutes}) — ` +
        '유휴 종료가 필요하면 usageMode=interactive를 쓰세요');
    }
    if (mode === 'batch' && idleMinutes === 0) {
      throw new Error('idleMinutes: batch 모드에서 0은 허용하지 않습니다 — 작업 래퍼가 비정상 종료(SIGKILL·호스트 유실)됐을 때 ' +
        'GPU를 내리는 백스톱이 사라집니다');
    }
    if (idleMinutes !== 0) validateIdleWindow(mode, idleMinutes);
  }

  let minCapacity: 0 | 1;
  if (isUnset(input.minCapacity)) {
    minCapacity = mode === 'batch' ? 0 : 1;
  } else {
    const n = parseNonNegInt('minCapacity', input.minCapacity);
    if (n > 1) throw new Error(`minCapacity: 0 또는 1이어야 합니다 (maxCapacity=1, 입력: ${n})`);
    if (mode === 'batch' && n === 1) {
      throw new Error('minCapacity: batch 모드는 작업 수명 동안만 GPU를 켭니다 — minCapacity=1과 함께 쓸 수 없습니다');
    }
    minCapacity = n as 0 | 1;
  }

  return { mode, idleMinutes, minCapacity, readyMinCapacity: mode === 'online' ? 1 : 0 };
}

/** CLI가 cdk deploy에 넘기는 컨텍스트 — 해석된 값을 전부 명시해 CDK 쪽 기본값에 기대지 않는다 */
export function policyContextArgs(p: UsagePolicy): string[] {
  return ['-c', `usageMode=${p.mode}`, '-c', `idleMinutes=${p.idleMinutes}`];
}

/** 스택 출력(UsageMode/IdleMinutes)과 요청 정책 비교. 출력이 없는 구버전 스택은 불일치로 본다 */
export function policyMatchesOutputs(p: UsagePolicy, outputs: Record<string, string>): boolean {
  return outputs.UsageMode === p.mode && outputs.IdleMinutes === String(p.idleMinutes);
}

export function describePolicy(p: UsagePolicy): string {
  if (p.mode === 'online') return 'online (유휴 종료 없음, READY 후 min=1 — 끄려면 tkf down)';
  if (p.mode === 'batch') return `batch (작업 종료 시 GPU 0, 하트비트 유실 ${p.idleMinutes}분 후 백스톱 정지)`;
  return p.idleMinutes === 0 ? 'interactive (유휴 종료 비활성)' : `interactive (무요청 ${p.idleMinutes}분 후 자동 정지)`;
}

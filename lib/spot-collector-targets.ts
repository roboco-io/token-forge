/**
 * 스팟 배치점수 수집 대상 카탈로그 — 수집기·퍼블리셔·대시보드가 공유하는 단일 기준.
 *
 * "대상(target)"은 GetSpotPlacementScores 1회 조회에 함께 넣는 인스턴스 타입 묶음이다.
 * - GPU(P·G 계열)는 타입 1개가 대상 1개다. AWS 문서가 이 계열은 최소 타입 수 권고에서 제외한다.
 * - 그 외(T·C·R)는 같은 크기의 타입 3개를 한 대상으로 묶는다. AWS 문서에 따르면 P·G·Trn·Inf가
 *   아닌 타입을 1-2개만 지정하면 점수가 항상 낮게 반환된다(2026-11-18 실측: t4g.medium 단독은
 *   4개 리전에서 3점, 같은 계열 3개 묶음은 9점). 그래서 이 대상의 점수는 "묶음 중 아무 타입이나
 *   1대"의 확보 가능성을 뜻하고, 가격은 묶음 내 최저가다.
 *
 * 대상을 추가하면 시간당 조회가 2회(리전 단위·AZ 단위) 늘어난다. AWS는 24시간 내 "새 조회 구성"의
 * 수를 제한할 수 있다고만 밝히고 수치는 공개하지 않으므로, 한 번에 많이 늘리지 말 것.
 * id는 DynamoDB scope 키의 접두어로 쓰이므로 '#'을 포함할 수 없고, 한 번 배포한 id를 바꾸면
 * 그 대상의 과거 수집 이력이 대시보드에서 빠진다.
 */
export type TargetFamily = 'gpu' | 't' | 'c' | 'r';

export interface CollectTarget {
  /** 피드(data.json)의 키. GPU는 인스턴스 타입 이름 그대로다. */
  id: string;
  family: TargetFamily;
  arch: 'x86' | 'arm';
  /** 대시보드에 표시하는 사양 요약 */
  spec: string;
  /** GPU 구성 (GPU 대상만) */
  gpu?: string;
  /** 한 번의 조회에 함께 넣는 인스턴스 타입 */
  instanceTypes: string[];
}

export const COLLECT_TARGETS: CollectTarget[] = [
  { id: 'p5.48xlarge', family: 'gpu', arch: 'x86', gpu: '8×H100', spec: '192 vCPU · 2048 GiB', instanceTypes: ['p5.48xlarge'] },
  { id: 'g6e.48xlarge', family: 'gpu', arch: 'x86', gpu: '8×L40S', spec: '192 vCPU · 1536 GiB', instanceTypes: ['g6e.48xlarge'] },
  { id: 'g6e.24xlarge', family: 'gpu', arch: 'x86', gpu: '4×L40S', spec: '96 vCPU · 768 GiB', instanceTypes: ['g6e.24xlarge'] },
  { id: 'g6e.12xlarge', family: 'gpu', arch: 'x86', gpu: '4×L40S', spec: '48 vCPU · 384 GiB', instanceTypes: ['g6e.12xlarge'] },
  { id: 't.medium', family: 't', arch: 'x86', spec: '2 vCPU · 4 GiB', instanceTypes: ['t3.medium', 't3a.medium', 't2.medium'] },
  { id: 't.large', family: 't', arch: 'x86', spec: '2 vCPU · 8 GiB', instanceTypes: ['t3.large', 't3a.large', 't2.large'] },
  // Graviton 버스터블은 t4g 한 세대뿐이라 같은 크기 3개를 만들 수 없어 크기를 섞는다 (가격은 사실상 medium 기준)
  { id: 't4g.mixed', family: 't', arch: 'arm', spec: '2-4 vCPU · 4-16 GiB', instanceTypes: ['t4g.medium', 't4g.large', 't4g.xlarge'] },
  { id: 'c.xlarge', family: 'c', arch: 'x86', spec: '4 vCPU · 8 GiB', instanceTypes: ['c7i.xlarge', 'c6i.xlarge', 'c6a.xlarge'] },
  { id: 'c.xlarge-arm', family: 'c', arch: 'arm', spec: '4 vCPU · 8 GiB', instanceTypes: ['c8g.xlarge', 'c7g.xlarge', 'c6g.xlarge'] },
  { id: 'r.xlarge', family: 'r', arch: 'x86', spec: '4 vCPU · 32 GiB', instanceTypes: ['r7i.xlarge', 'r6i.xlarge', 'r6a.xlarge'] },
  { id: 'r.xlarge-arm', family: 'r', arch: 'arm', spec: '4 vCPU · 32 GiB', instanceTypes: ['r8g.xlarge', 'r7g.xlarge', 'r6g.xlarge'] },
];

/** 카탈로그의 구조적 오류를 synth 시점에 막는다. 문제가 있으면 무엇이 잘못됐는지 담아 throw한다. */
export function validateTargets(targets: CollectTarget[]): void {
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  for (const t of targets) {
    if (!t.id || t.id.includes('#')) throw new Error(`수집 대상 id가 비었거나 '#'을 포함한다: "${t.id}"`);
    if (ids.has(t.id)) throw new Error(`수집 대상 id가 중복된다: "${t.id}"`);
    ids.add(t.id);
    if (t.instanceTypes.length === 0) throw new Error(`수집 대상 "${t.id}"에 인스턴스 타입이 없다`);
    if (t.family !== 'gpu' && t.instanceTypes.length < 3) {
      throw new Error(`수집 대상 "${t.id}": GPU가 아닌 계열은 타입을 3개 이상 묶어야 한다 (3개 미만이면 AWS가 항상 낮은 점수를 반환)`);
    }
    for (const it of t.instanceTypes) {
      // 한 타입이 두 대상에 속하면 퍼블리셔가 가격 기록을 어느 대상에 붙일지 정할 수 없다
      const prev = owner.get(it);
      if (prev) throw new Error(`인스턴스 타입 "${it}"이 두 수집 대상("${prev}", "${t.id}")에 속한다`);
      owner.set(it, t.id);
    }
  }
}

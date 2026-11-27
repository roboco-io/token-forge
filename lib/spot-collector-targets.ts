/**
 * 스팟 배치점수 수집 대상 카탈로그 — 수집기·퍼블리셔·대시보드가 공유하는 단일 기준.
 *
 * "대상(target)"은 GetSpotPlacementScores 1회 조회에 함께 넣는 인스턴스 타입 묶음이다.
 * - GPU(P·G 계열)는 타입 1개가 대상 1개다. AWS 문서가 이 계열은 최소 타입 수 권고에서 제외한다.
 * - 그 외(T·M·C·R·I)는 같은 크기의 타입 3개를 한 대상으로 묶는다. AWS 문서에 따르면 P·G·Trn·Inf가
 *   아닌 타입을 1-2개만 지정하면 점수가 항상 낮게 반환된다(2026-11-18 실측: t4g.medium 단독은
 *   4개 리전에서 3점, 같은 계열 3개 묶음은 9점). 그래서 이 대상의 점수는 "묶음 중 아무 타입이나
 *   1대"의 확보 가능성을 뜻하고, 가격은 묶음 내 최저가다.
 *
 * 묶음의 타입은 수집 리전 5곳 모두에서 제공되는 것만 고른다. 어떤 리전에 없는 타입이 섞이면 그 리전에서는
 * 사실상 2개 묶음이 되어 점수가 낮게 나온다(2026-11-19 실측: c6a·r6a가 없는 서울에서 c.xlarge·r.xlarge가
 * 3점). `aws ec2 describe-instance-type-offerings`로 리전별 제공 여부를 확인한 뒤 추가할 것.
 * HPC 계열(hpc6a·hpc7a·hpc7g 등)은 스팟을 지원하지 않아(SupportedUsageClasses가 on-demand뿐) 대상이 될 수 없다.
 *
 * 대상을 추가하면 시간당 조회가 2회(리전 단위·AZ 단위) 늘어난다. AWS는 24시간 내 "새 조회 구성"의
 * 수를 제한할 수 있다고만 밝히고 수치는 공개하지 않으므로, 한 번에 많이 늘리지 말 것.
 * id는 DynamoDB scope 키의 접두어로 쓰이므로 '#'을 포함할 수 없고, 한 번 배포한 id를 바꾸면
 * 그 대상의 과거 수집 이력이 대시보드에서 빠진다.
 */
export type TargetFamily = 'gpu' | 't' | 'm' | 'c' | 'r' | 'i';

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

/** [크기, vCPU, 메모리 GiB, GPU 수] */
type GpuSize = [string, number, number, number];
const G5_G6_SIZES: GpuSize[] = [
  ['xlarge', 4, 16, 1], ['2xlarge', 8, 32, 1], ['4xlarge', 16, 64, 1], ['8xlarge', 32, 128, 1],
  ['12xlarge', 48, 192, 4], ['16xlarge', 64, 256, 1], ['24xlarge', 96, 384, 4], ['48xlarge', 192, 768, 8],
];
const G4DN_SIZES: GpuSize[] = [
  ['xlarge', 4, 16, 1], ['2xlarge', 8, 32, 1], ['4xlarge', 16, 64, 1], ['8xlarge', 32, 128, 1],
  ['12xlarge', 48, 192, 4], ['16xlarge', 64, 256, 1], ['metal', 96, 384, 8],
];

/** GPU 계열의 크기별 단일 타입 대상. GPU 대상은 id가 타입 이름 그대로다. */
function gpuSizes(prefix: string, gpuName: string, sizes: GpuSize[]): CollectTarget[] {
  return sizes.map(([size, vcpu, gib, n]) => {
    const type = `${prefix}.${size}`;
    return { id: type, family: 'gpu', arch: 'x86', gpu: `${n}×${gpuName}`, spec: `${vcpu} vCPU · ${gib} GiB`, instanceTypes: [type] };
  });
}

export const COLLECT_TARGETS: CollectTarget[] = [
  { id: 'p5.48xlarge', family: 'gpu', arch: 'x86', gpu: '8×H100', spec: '192 vCPU · 2048 GiB', instanceTypes: ['p5.48xlarge'] },
  { id: 'g6e.48xlarge', family: 'gpu', arch: 'x86', gpu: '8×L40S', spec: '192 vCPU · 1536 GiB', instanceTypes: ['g6e.48xlarge'] },
  { id: 'g6e.24xlarge', family: 'gpu', arch: 'x86', gpu: '4×L40S', spec: '96 vCPU · 768 GiB', instanceTypes: ['g6e.24xlarge'] },
  { id: 'g6e.12xlarge', family: 'gpu', arch: 'x86', gpu: '4×L40S', spec: '48 vCPU · 384 GiB', instanceTypes: ['g6e.12xlarge'] },
  // g6·g5·g4dn은 스팟을 지원하는 전 크기를 수집한다 (2026-11-27 확인: 23개 모두 수집 리전 5곳에서 스팟 지원)
  ...gpuSizes('g6', 'L4', G5_G6_SIZES),
  ...gpuSizes('g5', 'A10G', G5_G6_SIZES),
  ...gpuSizes('g4dn', 'T4', G4DN_SIZES),
  { id: 't.medium', family: 't', arch: 'x86', spec: '2 vCPU · 4 GiB', instanceTypes: ['t3.medium', 't3a.medium', 't2.medium'] },
  { id: 't.large', family: 't', arch: 'x86', spec: '2 vCPU · 8 GiB', instanceTypes: ['t3.large', 't3a.large', 't2.large'] },
  // Graviton 버스터블은 t4g 한 세대뿐이라 같은 크기 3개를 만들 수 없어 크기를 섞는다 (가격은 사실상 medium 기준)
  { id: 't4g.mixed', family: 't', arch: 'arm', spec: '2-4 vCPU · 4-16 GiB', instanceTypes: ['t4g.medium', 't4g.large', 't4g.xlarge'] },
  { id: 'm.xlarge', family: 'm', arch: 'x86', spec: '4 vCPU · 16 GiB', instanceTypes: ['m7i.xlarge', 'm6i.xlarge', 'm5.xlarge'] },
  { id: 'm.xlarge-arm', family: 'm', arch: 'arm', spec: '4 vCPU · 16 GiB', instanceTypes: ['m8g.xlarge', 'm7g.xlarge', 'm6g.xlarge'] },
  { id: 'c.xlarge', family: 'c', arch: 'x86', spec: '4 vCPU · 8 GiB', instanceTypes: ['c7i.xlarge', 'c6i.xlarge', 'c5.xlarge'] },
  { id: 'c.xlarge-arm', family: 'c', arch: 'arm', spec: '4 vCPU · 8 GiB', instanceTypes: ['c8g.xlarge', 'c7g.xlarge', 'c6g.xlarge'] },
  { id: 'r.xlarge', family: 'r', arch: 'x86', spec: '4 vCPU · 32 GiB', instanceTypes: ['r7i.xlarge', 'r6i.xlarge', 'r5.xlarge'] },
  { id: 'r.xlarge-arm', family: 'r', arch: 'arm', spec: '4 vCPU · 32 GiB', instanceTypes: ['r8g.xlarge', 'r7g.xlarge', 'r6g.xlarge'] },
  { id: 'i.xlarge', family: 'i', arch: 'x86', spec: '4 vCPU · 30.5-32 GiB · NVMe 937-950 GB', instanceTypes: ['i7i.xlarge', 'i4i.xlarge', 'i3.xlarge'] },
  // 5개 리전 모두에 있는 Graviton 스토리지 최적화 세대는 i8g뿐이라 t4g처럼 크기를 섞는다 (가격은 사실상 large 기준)
  { id: 'i8g.mixed', family: 'i', arch: 'arm', spec: '2-8 vCPU · 16-64 GiB · NVMe 468-1875 GB', instanceTypes: ['i8g.large', 'i8g.xlarge', 'i8g.2xlarge'] },
];

/**
 * 퍼블리셔가 피드의 typeMeta를 만드는 데 쓰는 카탈로그. 대상이 38개를 넘으면서 환경 변수(합계 4KB 한도)에
 * 담을 수 없게 되어, 스택이 이 값을 퍼블리셔 코드 패키지의 targets.json으로 넣는다.
 */
export function publisherCatalog(targets: CollectTarget[]) {
  return targets.map(t => ({
    id: t.id, family: t.family, arch: t.arch, spec: t.spec, ...(t.gpu ? { gpu: t.gpu } : {}), types: t.instanceTypes,
  }));
}

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

# tf CLI 2단계 — 배치 엔진 + 병렬 레이스 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tf up <model>`에서 `--region`을 생략하면 배치점수·레이턴시·가격·쿼터를 종합해 후보 리전을 자동 선정하고, 후보 K개 리전에 동시 기동을 걸어 먼저 스팟을 확보한 리전만 남기는(First-Acquired-Wins) R10 지능형 배치를 구현한다.

**Architecture:** 순수 함수 중심의 배치 엔진(`cli/placement/`)이 공개 피드(48h 평균)·TCP RTT(24h 캐시)·Service Quotas·스팟 가격을 모아 후보를 서열화하고, 레이스 오케스트레이터(`cli/commands/race.ts`)가 리전별 ASG desired=1 동시 설정→첫 InService 승자→패자 즉시 취소를 수행한다. 기존 `runUp`의 스택 보장/READY 대기 로직은 리전 파라미터화된 함수로 추출해 단일 리전 경로와 자동 경로가 공유한다. 모든 외부 효과는 기존 패턴대로 의존성 주입으로 테스트한다.

**Tech Stack:** TypeScript, commander@^12, @aws-sdk v3 (기존 5종 + client-service-quotas 신규 1종), Node 20 내장 fetch/net, jest + ts-jest + aws-sdk-client-mock

**Spec:** `docs/superpowers/specs/2026-08-22-token-forge-v1-requirements.md` — R10 절 전체(입력·실패 경로·병렬 레이스·스탠바이 정책·우선순위와 동치 기준)와 파생 기능 요구 3·4가 이 계획의 구속 권위다.

## Global Constraints

- 런타임 의존성 허용 목록: commander@^12, js-yaml, @aws-sdk/client-{cloudformation,auto-scaling,ec2,secrets-manager,s3} + **이 계획에서 @aws-sdk/client-service-quotas 1종 추가 허용**. dev는 기존 + aws-sdk-client-mock. 그 외 추가 금지.
- 텔레메트리·외부 전송 금지(스펙 R2). 유일한 외부 GET은 공개 피드 `data.json` — **익명**이어야 한다: 요청에 계정 식별 헤더·쿼리 부착 금지.
- 우선순위: **확보 안정성 → 레이턴시 → 가격**. 동치 임계값 기본: 48h 평균 점수 차 < 1, RTT 차 < 30ms (스펙 명시 기본값 — config로만 조정).
- 스탠바이 정책 `race`(기본, K=2) / `single` / `lazy`. K는 1-4.
- 레이스 중 유휴 가드 강등 방지(상시 핑 + desired 복구)는 **참여 중 전 후보 리전**에 적용(스펙 교훈 반영 절).
- 브랜치: `feat/tf-cli-phase2-placement` (main에서 분기). 태스크별 커밋, 커밋 메시지·문서는 한국어.
- 마크다운 본문에 `~` 금지(범위 `-`, 근사 '약'). 경로 표기(`~/.token-forge`)는 예외.
- 스테일 컴파일 산출물(`*.js`/`*.d.ts`) 주의 — 테스트가 설명 불가하게 실패하면 먼저 `find lib bin cli test \( -name '*.js' -o -name '*.d.ts' \) -delete`.
- 기존 공개 인터페이스 불변: `stackNameFor(model, profile)`, `AwsApi` 기존 8메서드, `TfState` 기존 3필드(확장은 옵셔널 필드만), `runDown`/`renderClaudeEnv`/`runStatus` 시그니처.

## 설계 결정 (스펙 해석 — 태스크 전체에 구속)

1. **후보 리전 유니버스** = 피드 `regions`(현재 us-east-1, us-east-2, us-west-2, ap-northeast-1, ap-northeast-2). 피드 접근 불가 시 동일 5개를 `DEFAULT_REGIONS` 상수로 사용.
2. **리전 점수** = 프로파일 `instanceType` 후보들 중 피드가 커버하는 타입의 48h 평균 **최대값**(ASG가 리전 내에서 타입 레이스를 이미 수행하므로 가장 유리한 타입 기준). noPool 타입은 제외. 커버 타입이 0개면 그 리전은 `GetSpotPlacementScores` 실시간 폴백(사용자 고지) — 스펙 실패 경로 ①.
3. **쿼터 판정** = 리전별 스팟 vCPU 한도(G/VT: `L-3819A6DF`, P: `L-7212CCBC`) ≥ 프로파일 타입들의 **최소** vCPU(가장 작은 타입이라도 뜰 수 있으면 후보 유지). 전 리전 미달 시 `docs/ec2-quota-guide.md` 안내 후 중단 — 스펙 실패 경로 ②.
4. **lazy 모드의 패자 스택**: 자동 삭제하지 않고 종료 시 `tf down --purge --region <r>` 제안만 출력한다. 근거: 가중치 버킷 이름이 스택 생성 난수를 포함해 스택 재생성 시 기존 Retain 버킷을 재사용할 수 없으므로(캐시 소실), 자동 destroy는 스펙의 "캐시 상한 2(최근 사용 우선 보존)"와 모순된다. 파괴적 자동 작업 회피 원칙에도 부합.
5. **캐시 보유 리전 상한** = race: K / single: 1 / lazy: 2 (스펙 명문). 초과 시 LRU 리전에 대한 정리 **제안 로그**만 출력(자동 삭제 금지).
6. **cdk deploy는 리전별 순차 실행** — 같은 앱을 컨텍스트만 바꿔 병렬 실행하면 cdk.out이 충돌한다. 레이스의 병렬성은 desired=1 이후 확보 단계에만 적용(스펙도 "동시 desired=1"만 요구).
7. **가중치 캐시 위치의 "시딩 시간·비용 가산"** 해석: 서열화 우선순위는 스펙이 명문화한 3단(안정성 → 레이턴시 → 가격)만 사용하고, 캐시 유무는 ① `tf placement` 표에 표시 ② `up` 자동 모드의 ensure 단계에서 자동 선시딩으로 반영한다. 점수 가산항으로 넣으면 스펙의 명문 우선순위·동치 기준과 충돌하기 때문.

---

### Task 1: cli/config.ts — 설정 파일 + tf config 커맨드

**Files:**
- Create: `cli/config.ts`
- Modify: `cli/program.ts` (config 커맨드 추가)
- Test: `test/cli-config.test.ts`

**Interfaces:**
- Produces: `TfConfig { standby: 'race'|'single'|'lazy'; k: number; feedUrl: string; scoreTieThreshold: number; rttTieThresholdMs: number }`, `DEFAULT_CONFIG: TfConfig`, `loadConfig(dir?: string): TfConfig`, `saveConfig(c: TfConfig, dir?: string): void`. 이후 태스크 전부가 `loadConfig`를 소비.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-config.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../cli/config';

describe('config', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfcfg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('파일 없으면 기본값 (standby=race, k=2)', () => {
    const c = loadConfig(dir);
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(c.standby).toBe('race');
    expect(c.k).toBe(2);
    expect(c.scoreTieThreshold).toBe(1);
    expect(c.rttTieThresholdMs).toBe(30);
  });

  test('부분 파일은 기본값과 병합', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ standby: 'single' }));
    const c = loadConfig(dir);
    expect(c.standby).toBe('single');
    expect(c.k).toBe(2); // 기본값 유지
  });

  test('save 후 load 왕복', () => {
    saveConfig({ ...DEFAULT_CONFIG, k: 3 }, dir);
    expect(loadConfig(dir).k).toBe(3);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest test/cli-config.test.ts` / Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

```typescript
// cli/config.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TfConfig {
  standby: 'race' | 'single' | 'lazy';
  k: number;                 // 레이스 후보 수 (1-4, 스펙: 기본 2)
  feedUrl: string;           // 공개 배치점수 피드. 프라이버시 모드는 자가 수집기 URL로 교체
  scoreTieThreshold: number; // 48h 평균 점수 동치 임계값 (스펙 기본 1)
  rttTieThresholdMs: number; // RTT 동치 임계값 (스펙 기본 30ms)
}

export const DEFAULT_CONFIG: TfConfig = {
  standby: 'race',
  k: 2,
  feedUrl: 'https://d16jdvzof4zpo7.cloudfront.net/data.json',
  scoreTieThreshold: 1,
  rttTieThresholdMs: 30,
};

const DEFAULT_DIR = path.join(os.homedir(), '.token-forge');

export function loadConfig(dir: string = DEFAULT_DIR): TfConfig {
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function saveConfig(c: TfConfig, dir: string = DEFAULT_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c, null, 2));
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx jest test/cli-config.test.ts` / Expected: PASS

- [ ] **Step 5: tf config 커맨드 추가** — `cli/program.ts`의 `return program;` 앞에 삽입:

```typescript
  const config = program.command('config').description('CLI 설정 (~/.token-forge/config.json)');
  config.command('get [key]').description('설정 조회').action((key?: string) => {
    const c = loadConfig();
    if (!key) { console.log(JSON.stringify(c, null, 2)); return; }
    if (!(key in c)) { console.error(`알 수 없는 키: ${key}`); process.exit(1); }
    console.log(String(c[key as keyof typeof c]));
  });
  config.command('set <key> <value>').description('설정 변경').action((key: string, value: string) => {
    const c = loadConfig();
    if (key === 'standby') {
      if (!['race', 'single', 'lazy'].includes(value)) { console.error('standby는 race|single|lazy'); process.exit(1); }
      c.standby = value as typeof c.standby;
    } else if (key === 'k') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 4) { console.error('k는 1-4 정수'); process.exit(1); }
      c.k = n;
    } else if (key === 'feedUrl') { c.feedUrl = value; }
    else if (key === 'scoreTieThreshold' || key === 'rttTieThresholdMs') {
      const n = Number(value);
      if (!(n >= 0)) { console.error(`${key}는 0 이상 숫자`); process.exit(1); }
      c[key] = n;
    } else { console.error(`알 수 없는 키: ${key}`); process.exit(1); }
    saveConfig(c);
    console.log(`설정됨: ${key}=${value}`);
  });
```

파일 상단 import에 `import { loadConfig, saveConfig } from './config';` 추가.

- [ ] **Step 6: 전체 확인 + 커밋**

```bash
npx jest && npm run build
git add cli/config.ts cli/program.ts test/cli-config.test.ts
git commit -m "feat: tf config — standby/k/feedUrl 설정 (기본 race, K=2)"
```

---

### Task 2: 수집기 커버리지에 g6e.12xlarge 추가

R7 기준 인스턴스(g6e.12xlarge)가 수집 대상에 없어 피드가 앵커 워크로드를 커버하지 못한다(발견: 수집기 상수는 p5.48xlarge, g6e.48xlarge, g6e.24xlarge뿐). 엔진의 피드 경로가 실사용에서 작동하도록 커버리지를 넓힌다.

**Files:**
- Modify: `lib/spot-score-collector-stack.ts:14` — `const INSTANCE_TYPES = 'p5.48xlarge,g6e.48xlarge,g6e.24xlarge';` → `const INSTANCE_TYPES = 'p5.48xlarge,g6e.48xlarge,g6e.24xlarge,g6e.12xlarge';`
- Test: `test/spot-score-collector-stack.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — 기존 테스트 파일에서 Lambda 환경변수 `INSTANCE_TYPES`를 검증하는 기존 케이스를 찾아 기대값에 `g6e.12xlarge`를 추가한다. 해당 검증이 없으면 추가:

```typescript
test('수집 대상에 R7 기준 타입 g6e.12xlarge 포함', () => {
  // 기존 파일의 template 헬퍼/합성 패턴을 재사용할 것
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { INSTANCE_TYPES: 'p5.48xlarge,g6e.48xlarge,g6e.24xlarge,g6e.12xlarge' } },
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest test/spot-score-collector-stack.test.ts` / Expected: FAIL
- [ ] **Step 3: 상수 수정 후 통과 확인** — Run: `npx jest test/spot-score-collector-stack.test.ts` / Expected: PASS
- [ ] **Step 4: 커밋**

```bash
git add lib/spot-score-collector-stack.ts test/spot-score-collector-stack.test.ts
git commit -m "feat: 수집기 커버리지에 g6e.12xlarge 추가 (R7 기준 타입)"
```

주의: 실제 수집 반영은 사용자가 수집기 스택을 재배포해야 한다(`npx cdk deploy -c collector=1`) — 이 계획의 범위 밖이므로 태스크 보고서에 그 사실만 명기.

---

### Task 3: cli/placement/feed.ts — 피드 파싱·48h 집계 (순수 함수)

**Files:**
- Create: `cli/placement/feed.ts`
- Test: `test/placement-feed.test.ts`

**Interfaces:**
- Produces: `FeedData`(피드 스키마 타입), `fetchFeed(url: string, f?: typeof fetch): Promise<FeedData>`, `avg48h(series: [string, number][], now: Date): number | null`, `regionScore(feed: FeedData, types: string[], region: string, now: Date): number | null`, `regionPrice(feed: FeedData, types: string[], region: string): number | null`
- 피드 스키마 근거: `docs/spot-feed.md` (scores/prices는 `[ISO시각, 값]` 시계열, noPool은 타입별 미개설 리전 목록)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/placement-feed.test.ts
import { avg48h, regionScore, regionPrice, fetchFeed, FeedData } from '../cli/placement/feed';

const NOW = new Date('2026-08-23T12:00:00Z');
const feed: FeedData = {
  generated: '2026-08-23 11:00 UTC',
  types: ['g6e.12xlarge', 'g6e.24xlarge'],
  regions: ['ap-northeast-1', 'ap-northeast-2', 'us-east-1'],
  noPool: { 'g6e.24xlarge': ['us-east-1'] },
  scores: {
    'g6e.12xlarge': {
      'ap-northeast-1': [['2026-08-21T10:00:00Z', 9], ['2026-08-22T12:00:00Z', 7], ['2026-08-23T11:00:00Z', 5]],
      'ap-northeast-2': [['2026-08-23T11:00:00Z', 3]],
    },
    'g6e.24xlarge': {
      'ap-northeast-2': [['2026-08-23T11:00:00Z', 8]],
      'us-east-1': [['2026-08-23T11:00:00Z', 9]], // noPool이므로 무시되어야 함
    },
  },
  prices: {
    'g6e.12xlarge': { 'ap-northeast-2': [['2026-08-23T11:00:00Z', 2.61]] },
    'g6e.24xlarge': { 'ap-northeast-2': [['2026-08-23T11:00:00Z', 5.2]] },
  },
};

describe('avg48h', () => {
  test('48시간 내 값만 평균 (2026-08-21T10시는 제외)', () => {
    expect(avg48h(feed.scores['g6e.12xlarge']['ap-northeast-1'], NOW)).toBe(6); // (7+5)/2
  });
  test('48시간 내 값 없으면 null', () => {
    expect(avg48h([['2026-08-01T00:00:00Z', 9]], NOW)).toBeNull();
  });
});

describe('regionScore', () => {
  test('프로파일 타입들 중 최대 48h 평균', () => {
    expect(regionScore(feed, ['g6e.12xlarge', 'g6e.24xlarge'], 'ap-northeast-2', NOW)).toBe(8);
  });
  test('noPool 타입은 제외 — us-east-1은 12xlarge 데이터도 없으므로 null', () => {
    expect(regionScore(feed, ['g6e.12xlarge', 'g6e.24xlarge'], 'us-east-1', NOW)).toBeNull();
  });
});

describe('regionPrice', () => {
  test('커버 타입 중 최저 최신가', () => {
    expect(regionPrice(feed, ['g6e.12xlarge', 'g6e.24xlarge'], 'ap-northeast-2')).toBe(2.61);
  });
  test('가격 데이터 없으면 null', () => {
    expect(regionPrice(feed, ['g6e.12xlarge'], 'us-east-1')).toBeNull();
  });
});

describe('fetchFeed', () => {
  test('주입된 fetch로 JSON 파싱', async () => {
    const fake = (async () => ({ ok: true, json: async () => feed })) as unknown as typeof fetch;
    expect((await fetchFeed('https://example.test/data.json', fake)).regions).toHaveLength(3);
  });
  test('HTTP 오류는 throw', async () => {
    const fake = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchFeed('https://example.test/data.json', fake)).rejects.toThrow('503');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest test/placement-feed.test.ts` / Expected: FAIL

- [ ] **Step 3: 구현**

```typescript
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
```

- [ ] **Step 4: 통과 확인 + 커밋**

```bash
npx jest test/placement-feed.test.ts
git add cli/placement/feed.ts test/placement-feed.test.ts
git commit -m "feat: 배치 엔진 피드 소비 — 48h 평균·noPool·최신가 (순수 함수)"
```

---

### Task 4: cli/placement/latency.ts — EC2 엔드포인트 RTT 측정 + 24h 캐시

**Files:**
- Create: `cli/placement/latency.ts`
- Test: `test/placement-latency.test.ts`

**Interfaces:**
- Produces: `Connector = (host: string, port: number, timeoutMs: number) => Promise<number>`, `tcpConnector: Connector`(net.Socket 실구현), `measureRtt(region: string, connect: Connector): Promise<number>`(3회 중앙값), `getRtt(region: string, d: { connect: Connector; dir: string; now: () => Date }): Promise<number>`(24h 캐시 우선, `<dir>/latency.json`)
- 스펙 근거: R10 입력 — "EC2 엔드포인트(`ec2.<region>.amazonaws.com`) TCP 연결 3회 중앙값, 로컬 캐시 24h"

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/placement-latency.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { measureRtt, getRtt } from '../cli/placement/latency';

const NOW = new Date('2026-08-23T12:00:00Z');

describe('measureRtt', () => {
  test('3회 측정의 중앙값, 대상은 ec2.<region>.amazonaws.com:443', async () => {
    const calls: string[] = [];
    const results = [80, 30, 50];
    const connect = async (host: string, port: number) => { calls.push(`${host}:${port}`); return results.shift()!; };
    expect(await measureRtt('ap-northeast-1', connect)).toBe(50);
    expect(calls).toEqual(Array(3).fill('ec2.ap-northeast-1.amazonaws.com:443'));
  });
});

describe('getRtt (24h 캐시)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tflat-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('캐시 미스 → 측정 후 저장', async () => {
    const connect = async () => 42;
    expect(await getRtt('us-east-1', { connect, dir, now: () => NOW })).toBe(42);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'latency.json'), 'utf8'));
    expect(cache['us-east-1'].rttMs).toBe(42);
  });

  test('24시간 내 캐시는 재측정하지 않음', async () => {
    fs.writeFileSync(path.join(dir, 'latency.json'),
      JSON.stringify({ 'us-east-1': { rttMs: 99, measuredAt: '2026-08-23T00:00:00Z' } }));
    let called = 0;
    const connect = async () => { called++; return 1; };
    expect(await getRtt('us-east-1', { connect, dir, now: () => NOW })).toBe(99);
    expect(called).toBe(0);
  });

  test('24시간 지난 캐시는 재측정', async () => {
    fs.writeFileSync(path.join(dir, 'latency.json'),
      JSON.stringify({ 'us-east-1': { rttMs: 99, measuredAt: '2026-08-20T00:00:00Z' } }));
    const connect = async () => 7;
    expect(await getRtt('us-east-1', { connect, dir, now: () => NOW })).toBe(7);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest test/placement-latency.test.ts` / Expected: FAIL

- [ ] **Step 3: 구현**

```typescript
// cli/placement/latency.ts — 후보 리전 레이턴시: EC2 엔드포인트 TCP RTT (스펙 R10 입력)
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

export type Connector = (host: string, port: number, timeoutMs: number) => Promise<number>;

/** TCP 연결 수립까지의 시간(ms). 실패·타임아웃은 reject */
export const tcpConnector: Connector = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = net.connect({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(Date.now() - start); });
    sock.once('timeout', () => { sock.destroy(); reject(new Error(`${host} 연결 타임아웃`)); });
    sock.once('error', (e) => { sock.destroy(); reject(e); });
  });

/** 3회 측정 후 중앙값 (스펙: TCP 연결 시간 3회 측정 후 중앙값) */
export async function measureRtt(region: string, connect: Connector): Promise<number> {
  const host = `ec2.${region}.amazonaws.com`;
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) samples.push(await connect(host, 443, 5000));
  samples.sort((a, b) => a - b);
  return samples[1];
}

interface LatencyCache { [region: string]: { rttMs: number; measuredAt: string } }

/** 24h 로컬 캐시 우선, 미스·만료 시 측정 후 저장 */
export async function getRtt(region: string, d: { connect: Connector; dir: string; now: () => Date }): Promise<number> {
  const file = path.join(d.dir, 'latency.json');
  const cache: LatencyCache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const hit = cache[region];
  if (hit && d.now().getTime() - new Date(hit.measuredAt).getTime() < 24 * 3600 * 1000) return hit.rttMs;
  const rttMs = await measureRtt(region, d.connect);
  cache[region] = { rttMs, measuredAt: d.now().toISOString() };
  fs.mkdirSync(d.dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  return rttMs;
}
```

- [ ] **Step 4: 통과 확인 + 커밋**

```bash
npx jest test/placement-latency.test.ts
git add cli/placement/latency.ts test/placement-latency.test.ts
git commit -m "feat: 리전 레이턴시 측정 — EC2 엔드포인트 TCP 3회 중앙값, 24h 캐시"
```

---

### Task 5: AwsApi 확장 — 쿼터·vCPU·스팟가·실시간 배치점수

**Files:**
- Modify: `cli/aws.ts` (메서드 4개 추가), `package.json` (@aws-sdk/client-service-quotas)
- Test: `test/cli-aws.test.ts` (기존 파일에 추가)

**Interfaces:**
- Produces (AwsApi 추가 메서드, 모두 생성자 리전 기준):
  - `getSpotVcpuQuota(family: 'g' | 'p'): Promise<number>` — Service Quotas `ec2`/`L-3819A6DF`(G·VT) 또는 `L-7212CCBC`(P). 쿼터 미조회 오류(AccessDenied 등)는 throw
  - `getVcpuCount(instanceType: string): Promise<number>` — EC2 DescribeInstanceTypes
  - `getCurrentSpotPrice(instanceType: string): Promise<number | null>` — DescribeSpotPriceHistory 최신 결과 중 최저(Linux/UNIX, MaxResults 20). 결과 없으면 null
  - `getPlacementScore(instanceTypes: string[], region: string): Promise<number | null>` — GetSpotPlacementScores(TargetCapacity 1, RegionNames=[region], SingleAvailabilityZone false). 결과 없으면 null
- 주의: aws-sdk-client-mock의 resolves/rejectsOnce 등록 순서 이슈(이 리포 기존 교훈) — 특정 응답 등록을 기본 resolves보다 먼저 하지 말 것.

- [ ] **Step 1: 의존성 추가** — Run: `npm install @aws-sdk/client-service-quotas@^3`

- [ ] **Step 2: 실패하는 테스트 작성** — `test/cli-aws.test.ts`에 추가:

```typescript
// 상단 import에 추가:
import { ServiceQuotasClient, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { DescribeInstanceTypesCommand, DescribeSpotPriceHistoryCommand, GetSpotPlacementScoresCommand } from '@aws-sdk/client-ec2';
// (기존 EC2 mock 인스턴스를 재사용 — 파일의 기존 패턴을 따를 것)
const sqMock = mockClient(ServiceQuotasClient);

describe('배치 엔진용 확장 메서드', () => {
  beforeEach(() => { sqMock.reset(); });

  test('getSpotVcpuQuota: g 패밀리는 L-3819A6DF', async () => {
    sqMock.on(GetServiceQuotaCommand, { ServiceCode: 'ec2', QuotaCode: 'L-3819A6DF' })
      .resolves({ Quota: { Value: 192 } });
    expect(await new AwsApi('ap-northeast-1').getSpotVcpuQuota('g')).toBe(192);
  });

  test('getVcpuCount', async () => {
    ec2Mock.on(DescribeInstanceTypesCommand).resolves({
      InstanceTypes: [{ InstanceType: 'g6e.12xlarge', VCpuInfo: { DefaultVCpus: 48 } }] as never,
    });
    expect(await new AwsApi('ap-northeast-1').getVcpuCount('g6e.12xlarge')).toBe(48);
  });

  test('getCurrentSpotPrice: 최신 최저가, 없으면 null', async () => {
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({
      SpotPriceHistory: [{ SpotPrice: '2.9' }, { SpotPrice: '2.61' }] as never,
    });
    expect(await new AwsApi('ap-northeast-1').getCurrentSpotPrice('g6e.12xlarge')).toBe(2.61);
    ec2Mock.on(DescribeSpotPriceHistoryCommand).resolves({ SpotPriceHistory: [] });
    expect(await new AwsApi('ap-northeast-1').getCurrentSpotPrice('g6e.12xlarge')).toBeNull();
  });

  test('getPlacementScore: 해당 리전 점수, 없으면 null', async () => {
    ec2Mock.on(GetSpotPlacementScoresCommand).resolves({
      SpotPlacementScores: [{ Region: 'ap-northeast-1', Score: 7 }] as never,
    });
    expect(await new AwsApi('ap-northeast-1').getPlacementScore(['g6e.12xlarge'], 'ap-northeast-1')).toBe(7);
    ec2Mock.on(GetSpotPlacementScoresCommand).resolves({ SpotPlacementScores: [] });
    expect(await new AwsApi('ap-northeast-1').getPlacementScore(['g6e.12xlarge'], 'ap-northeast-1')).toBeNull();
  });
});
```

- [ ] **Step 3: 실패 확인** — Run: `npx jest test/cli-aws.test.ts` / Expected: FAIL (새 케이스만)

- [ ] **Step 4: 구현** — `cli/aws.ts`에 추가:

```typescript
// 상단 import 추가:
import { ServiceQuotasClient, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { DescribeInstanceTypesCommand, DescribeSpotPriceHistoryCommand, GetSpotPlacementScoresCommand } from '@aws-sdk/client-ec2';

// 클래스 필드·생성자에 추가:
  private sq: ServiceQuotasClient;
  // constructor 안: this.sq = new ServiceQuotasClient({ region });

// 메서드 추가:
  /** 스팟 vCPU 쿼터 — G·VT: L-3819A6DF, P: L-7212CCBC (스펙 R10 파생 입력) */
  async getSpotVcpuQuota(family: 'g' | 'p'): Promise<number> {
    const code = family === 'p' ? 'L-7212CCBC' : 'L-3819A6DF';
    const out = await this.sq.send(new GetServiceQuotaCommand({ ServiceCode: 'ec2', QuotaCode: code }));
    return out.Quota?.Value ?? 0;
  }

  async getVcpuCount(instanceType: string): Promise<number> {
    const out = await this.ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as never] }));
    const v = out.InstanceTypes?.[0]?.VCpuInfo?.DefaultVCpus;
    if (!v) throw new Error(`인스턴스 타입 정보 없음: ${instanceType}`);
    return v;
  }

  async getCurrentSpotPrice(instanceType: string): Promise<number | null> {
    const out = await this.ec2.send(new DescribeSpotPriceHistoryCommand({
      InstanceTypes: [instanceType as never], ProductDescriptions: ['Linux/UNIX'], MaxResults: 20,
    }));
    const prices = (out.SpotPriceHistory ?? []).map((h) => Number(h.SpotPrice)).filter((n) => !Number.isNaN(n));
    return prices.length ? Math.min(...prices) : null;
  }

  /** 피드 미커버 리전의 실시간 폴백 (스펙 R10 실패 경로 ①) */
  async getPlacementScore(instanceTypes: string[], region: string): Promise<number | null> {
    const out = await this.ec2.send(new GetSpotPlacementScoresCommand({
      InstanceTypes: instanceTypes as never, TargetCapacity: 1,
      SingleAvailabilityZone: false, RegionNames: [region],
    }));
    const hit = (out.SpotPlacementScores ?? []).find((s) => s.Region === region);
    return hit?.Score ?? null;
  }
```

- [ ] **Step 5: 통과 확인 + 커밋**

```bash
npx jest test/cli-aws.test.ts && npm run build
git add cli/aws.ts test/cli-aws.test.ts package.json package-lock.json
git commit -m "feat: AwsApi 확장 — 스팟 쿼터·vCPU·현재가·실시간 배치점수"
```

---

### Task 6: cli/placement/engine.ts — 후보 수집 + 서열화

**Files:**
- Create: `cli/placement/engine.ts`
- Test: `test/placement-engine.test.ts`

**Interfaces:**
- Consumes: Task 3 `fetchFeed/regionScore/regionPrice/FeedData`, Task 4 `getRtt`, Task 5 AwsApi 확장 4메서드 + 기존 `getStackOutputs/headObject`, Task 1 `TfConfig`
- Produces:
  - `Candidate { region: string; score: number; scoreSource: 'feed48h' | 'realtime'; rttMs: number; price: number | null; cached: boolean }`
  - `DEFAULT_REGIONS: string[]` — `['us-east-1','us-east-2','us-west-2','ap-northeast-1','ap-northeast-2']`
  - `pickLeader(cands: Candidate[], t: { score: number; rttMs: number }): Candidate`
  - `rank(cands: Candidate[], t): Candidate[]`
  - `gatherCandidates(opts: { types: string[]; stackName: string; weightsRepo: string }, d: GatherDeps): Promise<{ cands: Candidate[]; notices: string[] }>`
  - `GatherDeps { config: TfConfig; fetchFeed: (url: string) => Promise<FeedData>; apiFor: (region: string) => EngineApi; getRtt: (region: string) => Promise<number>; now: () => Date }` — `EngineApi = Pick<AwsApi, 'getSpotVcpuQuota' | 'getVcpuCount' | 'getPlacementScore' | 'getCurrentSpotPrice' | 'getStackOutputs' | 'headObject'>`

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/placement-engine.test.ts
import { pickLeader, rank, gatherCandidates, Candidate } from '../cli/placement/engine';
import { DEFAULT_CONFIG } from '../cli/config';
import { FeedData } from '../cli/placement/feed';

const T = { score: 1, rttMs: 30 };
const c = (region: string, score: number, rttMs: number, price: number | null): Candidate =>
  ({ region, score, scoreSource: 'feed48h', rttMs, price, cached: false });

describe('pickLeader — 안정성 → 레이턴시 → 가격, 동치 임계값', () => {
  test('점수 차 1 이상이면 점수가 결정', () => {
    expect(pickLeader([c('a', 8, 200, 1), c('b', 6.9, 10, 0.5)], T).region).toBe('a');
  });
  test('점수 차 1 미만은 동점 — RTT 30ms 이상 차이가 결정', () => {
    expect(pickLeader([c('a', 8, 200, 1), c('b', 7.5, 40, 9)], T).region).toBe('b');
  });
  test('점수·RTT 모두 동점이면 최저가', () => {
    expect(pickLeader([c('a', 8, 40, 3.0), c('b', 7.5, 50, 2.5)], T).region).toBe('b');
  });
  test('가격 null은 최후순위', () => {
    expect(pickLeader([c('a', 8, 40, null), c('b', 8, 45, 2.5)], T).region).toBe('b');
  });
});

describe('rank', () => {
  test('leader 반복 제거로 전체 서열', () => {
    const out = rank([c('a', 8, 200, 1), c('b', 7.5, 40, 9), c('d', 3, 10, 0.1)], T);
    expect(out.map((x) => x.region)).toEqual(['b', 'a', 'd']);
  });
});

describe('gatherCandidates', () => {
  const NOW = new Date('2026-08-23T12:00:00Z');
  const feed: FeedData = {
    generated: '', types: ['g6e.12xlarge'], regions: ['ap-northeast-1', 'ap-northeast-2'],
    scores: { 'g6e.12xlarge': { 'ap-northeast-1': [['2026-08-23T11:00:00Z', 8]] } }, // apne2는 미커버
    prices: { 'g6e.12xlarge': { 'ap-northeast-1': [['2026-08-23T11:00:00Z', 2.7]] } },
  };
  const apiFor = (region: string) => ({
    getSpotVcpuQuota: async () => 192,
    getVcpuCount: async () => 48,
    getPlacementScore: async () => (region === 'ap-northeast-2' ? 5 : null),
    getCurrentSpotPrice: async () => 2.61,
    getStackOutputs: async () => (region === 'ap-northeast-2' ? { WeightsBucketName: 'b', WeightsRepo: 'Org/M' } : null),
    headObject: async () => true,
  });
  const deps = {
    config: DEFAULT_CONFIG, fetchFeed: async () => feed, apiFor,
    getRtt: async (r: string) => (r === 'ap-northeast-2' ? 30 : 35), now: () => NOW,
  };
  const opts = { types: ['g6e.12xlarge'], stackName: 'TokenForge-m-p', weightsRepo: 'Org/M' };

  test('피드 커버 리전은 feed48h, 미커버는 realtime 폴백 + 고지', async () => {
    const { cands, notices } = await gatherCandidates(opts, deps);
    const apne1 = cands.find((x) => x.region === 'ap-northeast-1')!;
    const apne2 = cands.find((x) => x.region === 'ap-northeast-2')!;
    expect(apne1.scoreSource).toBe('feed48h');
    expect(apne1.score).toBe(8);
    expect(apne2.scoreSource).toBe('realtime');
    expect(apne2.score).toBe(5);
    expect(apne2.cached).toBe(true); // 스택+마커 존재
    expect(notices.some((n) => n.includes('ap-northeast-2'))).toBe(true);
  });

  test('피드 전체 실패 → 전 리전 realtime + 고지', async () => {
    const { cands, notices } = await gatherCandidates(opts,
      { ...deps, fetchFeed: async () => { throw new Error('down'); } });
    expect(cands.every((x) => x.scoreSource === 'realtime')).toBe(true);
    expect(notices.some((n) => n.includes('피드'))).toBe(true);
  });

  test('쿼터 부족 리전은 제외, 전 리전 미달이면 가이드 안내 오류', async () => {
    const zeroQuota = (region: string) => ({ ...apiFor(region), getSpotVcpuQuota: async () => 0 });
    await expect(gatherCandidates(opts, { ...deps, apiFor: zeroQuota }))
      .rejects.toThrow('ec2-quota-guide');
  });

  test('realtime 점수도 null인 리전은 후보 제외', async () => {
    const noScore = (region: string) => ({ ...apiFor(region), getPlacementScore: async () => null });
    const { cands } = await gatherCandidates(opts, { ...deps, apiFor: noScore });
    expect(cands.map((x) => x.region)).toEqual(['ap-northeast-1']); // 피드 커버 리전만 남음
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest test/placement-engine.test.ts` / Expected: FAIL

- [ ] **Step 3: 구현**

```typescript
// cli/placement/engine.ts — R10 배치 엔진: 입력 수집 + 안정성→레이턴시→가격 서열화
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
```

- [ ] **Step 4: 통과 확인 + 커밋**

```bash
npx jest test/placement-engine.test.ts
git add cli/placement/engine.ts test/placement-engine.test.ts
git commit -m "feat: 배치 엔진 — 후보 수집(피드/실시간 폴백/쿼터)과 3단 서열화"
```

---

### Task 7: tf placement 커맨드 — 추천 표 표시

**Files:**
- Create: `cli/commands/placement.ts`
- Modify: `cli/program.ts`
- Test: `test/cli-placement.test.ts`

**Interfaces:**
- Consumes: Task 6 `gatherCandidates/rank/Candidate`, Task 1 `TfConfig`
- Produces: `runPlacement(opts: { types: string[]; stackName: string; weightsRepo: string; k: number }, d: GatherDeps & { thresholds: { score: number; rttMs: number } }): Promise<string[]>` — 표 형식 라인 배열(콘솔 출력용). Task 10이 후보 선정 로직을 공유하지는 않음(placement는 표시 전용, up은 gather+rank 직접 호출).

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-placement.test.ts
import { runPlacement } from '../cli/commands/placement';
import { DEFAULT_CONFIG } from '../cli/config';
import { Candidate } from '../cli/placement/engine';

test('서열 순 표 + 상위 K 마킹 + 고지 포함', async () => {
  const cands: Candidate[] = [
    { region: 'ap-northeast-1', score: 8, scoreSource: 'feed48h', rttMs: 35, price: 2.7, cached: true },
    { region: 'us-east-1', score: 5, scoreSource: 'realtime', rttMs: 180, price: 2.3, cached: false },
  ];
  const lines = await runPlacement(
    { types: ['g6e.12xlarge'], stackName: 's', weightsRepo: 'O/M', k: 2 },
    {
      config: DEFAULT_CONFIG,
      fetchFeed: async () => { throw new Error('unused'); },
      apiFor: () => { throw new Error('unused'); },
      getRtt: async () => 0, now: () => new Date('2026-08-23T12:00:00Z'),
      thresholds: { score: 1, rttMs: 30 },
      gather: async () => ({ cands, notices: ['테스트 고지'] }),
    },
  );
  const text = lines.join('\n');
  expect(lines[0]).toContain('테스트 고지');
  expect(text).toMatch(/ap-northeast-1.*8\.0.*35ms.*\$2\.7.*있음/s); // 점수·RTT·가격·캐시
  expect(text).toContain('realtime'); // 폴백 출처 표시
  const apne1Line = lines.find((l) => l.includes('ap-northeast-1'))!;
  expect(apne1Line).toContain('*'); // 상위 K 마킹
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest test/cli-placement.test.ts` / Expected: FAIL

- [ ] **Step 3: 구현**

```typescript
// cli/commands/placement.ts — tf placement: R10 추천 결과를 사람이 읽는 표로
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
```

- [ ] **Step 4: program.ts에 커맨드 추가** — `return program;` 앞에:

```typescript
  program.command('placement <model>')
    .description('리전 추천 표시 (배치점수·레이턴시·가격·쿼터 종합)')
    .option('--profile <p>', '모델 프로파일 (기본: yaml 첫 프로파일)')
    .action(async (model: string, o: { profile?: string }) => {
      const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
      const rp = loadModelProfile(MODELS_DIR, model, profile);
      const cfg = loadConfig();
      const lines = await runPlacement(
        { types: rp.instanceType.split(','), stackName: stackNameFor(model, profile), weightsRepo: rp.weightsRepo, k: cfg.k },
        {
          config: cfg, fetchFeed: (u) => fetchFeed(u), apiFor: (r) => new AwsApi(r),
          getRtt: (r) => getRtt(r, { connect: tcpConnector, dir: path.join(os.homedir(), '.token-forge'), now: () => new Date() }),
          now: () => new Date(),
          thresholds: { score: cfg.scoreTieThreshold, rttMs: cfg.rttTieThresholdMs },
        });
      lines.forEach((l) => console.log(l));
    });
```

import 추가: `runPlacement`, `fetchFeed`, `getRtt`, `tcpConnector`.

- [ ] **Step 5: 통과 확인 + 커밋**

```bash
npx jest test/cli-placement.test.ts && npm run build
git add cli/commands/placement.ts cli/program.ts test/cli-placement.test.ts
git commit -m "feat: tf placement — 리전 추천 표 (점수·RTT·가격·캐시·출처)"
```

---

### Task 8: up.ts 리팩토링 — ensureStackReady / waitReady 추출 (동작 불변)

이후 태스크(레이스·자동 모드)가 리전 파라미터화된 조각을 재사용할 수 있도록 기존 `runUp`을 분해한다. **외부 동작·시그니처·기존 테스트는 그대로 통과해야 한다.**

**Files:**
- Modify: `cli/commands/up.ts`
- Test: `test/cli-up.test.ts` (기존 3+2건 그대로 통과 — 새 테스트 추가 없음)

**Interfaces:**
- Produces (up.ts에서 export 추가):
  - `ensureStackReady(opts: UpOpts, d: Pick<UpDeps, 'api' | 'exec' | 'log'>): Promise<{ outputs: Record<string, string>; stackName: string }>` — 기존 ① 스택 보장 + ② 시딩 보장(내부에서 headObject 사용하므로 api Pick에 headObject 포함)
  - `waitReady(args: { stackName: string; outputs: Record<string, string> }, d: Pick<UpDeps, 'api' | 'probeAuth' | 'sleep' | 'log' | 'timeoutMs'>): Promise<{ endpoint: string }>` — 기존 ③ desired=1 + ④ READY 폴링(강등 복구·타임아웃 desired=0 포함)
  - `runUp`은 두 함수 조합 + saveState로 재구성(시그니처 불변)

- [ ] **Step 1: 리팩토링** — `runUp` 본문을 위 두 함수로 분리. 코드 이동만 수행하고 로직 변경 금지. `ensureStackReady`의 api Pick은 `'getStackOutputs' | 'headObject'`, exec·log 포함. `waitReady`의 api Pick은 `'getAsgName' | 'getAsgStatus' | 'setDesired' | 'getSecret'`.
- [ ] **Step 2: 기존 테스트 전체 통과 확인** — Run: `npx jest test/cli-up.test.ts` / Expected: PASS (수정 없이)
- [ ] **Step 3: 전체 회귀 확인** — Run: `npx jest && npm run build` / Expected: PASS
- [ ] **Step 4: 커밋**

```bash
git add cli/commands/up.ts
git commit -m "refactor: runUp을 ensureStackReady/waitReady로 분해 (동작 불변, 레이스 준비)"
```

---

### Task 9: cli/commands/race.ts — 리전 간 병렬 레이스 (First-Acquired-Wins)

**Files:**
- Create: `cli/commands/race.ts`
- Test: `test/cli-race.test.ts`

**Interfaces:**
- Consumes: `AwsApi.setDesired/getAsgStatus` (리전별 인스턴스는 `apiFor`로 주입)
- Produces:
  - `RaceEntrant { region: string; asgName: string; endpointUrl: string }`
  - `RaceDeps { apiFor: (region: string) => Pick<AwsApi, 'setDesired' | 'getAsgStatus'>; probe: (url: string) => Promise<number>; sleep: (ms: number) => Promise<void>; log: (m: string) => void; timeoutMs: number }`
  - `runRace(entrants: RaceEntrant[], d: RaceDeps): Promise<RaceEntrant>` — 승자 반환. 패자는 반환 전에 desired=0 완료

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-race.test.ts
import { runRace, RaceEntrant } from '../cli/commands/race';

const entrants: RaceEntrant[] = [
  { region: 'ap-northeast-1', asgName: 'asg-1', endpointUrl: 'http://e1' },
  { region: 'ap-northeast-2', asgName: 'asg-2', endpointUrl: 'http://e2' },
];

function makeDeps(instancesByRegion: Record<string, string[][]>, desiredSeq: Record<string, number[]> = {}) {
  const calls: string[] = [];
  const probed: string[] = [];
  const apiFor = (region: string) => ({
    setDesired: async (asg: string, n: number) => { calls.push(`${region}:desired=${n}`); },
    getAsgStatus: async () => ({
      desired: (desiredSeq[region] ?? [1]).length > 1 ? desiredSeq[region].shift()! : (desiredSeq[region] ?? [1])[0],
      instanceIds: (instancesByRegion[region] ?? [[]]).length > 1
        ? instancesByRegion[region].shift()! : (instancesByRegion[region] ?? [[]])[0],
    }),
  });
  return { calls, probed, deps: { apiFor, probe: async (u: string) => { probed.push(u); return 0; },
    sleep: async () => {}, log: () => {}, timeoutMs: 60_000 } };
}

test('전 후보 desired=1 → 첫 확보 리전이 승자, 패자는 즉시 desired=0', async () => {
  // apne1은 2번째 폴링에서 확보, apne2는 계속 미확보
  const { calls, deps } = makeDeps({ 'ap-northeast-1': [[], ['i-1'], ['i-1']], 'ap-northeast-2': [[]] });
  const winner = await runRace(entrants, deps);
  expect(winner.region).toBe('ap-northeast-1');
  expect(calls.slice(0, 2)).toEqual(['ap-northeast-1:desired=1', 'ap-northeast-2:desired=1']); // 동시 시작
  expect(calls).toContain('ap-northeast-2:desired=0'); // 패자 취소
  expect(calls.filter((c) => c === 'ap-northeast-1:desired=0')).toHaveLength(0); // 승자는 취소 안 함
});

test('레이스 중 유휴 가드 강등 감지 시 복구 + 전 후보 핑', async () => {
  const { calls, probed, deps } = makeDeps(
    { 'ap-northeast-1': [[], [], ['i-1']], 'ap-northeast-2': [[]] },
    { 'ap-northeast-2': [0, 1, 1] }, // 첫 폴링에서 desired=0 (강등)
  );
  await runRace(entrants, deps);
  expect(calls.filter((c) => c === 'ap-northeast-2:desired=1').length).toBeGreaterThanOrEqual(2); // 시작 + 복구
  expect(probed).toContain('http://e1/v1/models'); // 유휴 알람 발화 차단용 핑
  expect(probed).toContain('http://e2/v1/models');
});

test('타임아웃 시 전 후보 desired=0 후 오류', async () => {
  const t = { now: 0 };
  const deps = {
    apiFor: () => ({ setDesired: async () => {}, getAsgStatus: async () => ({ desired: 1, instanceIds: [] }) }),
    probe: async () => 0, log: () => {},
    sleep: async () => { t.now += 20 * 60 * 1000; }, timeoutMs: 30 * 60 * 1000,
  };
  // Date.now 대신 주입 시계를 쓰도록 구현하므로, 여기서는 timeoutMs를 0으로 줄여 즉시 만료를 검증
  const zeroDeps = { ...deps, timeoutMs: 0 };
  const calls: string[] = [];
  zeroDeps.apiFor = () => ({ setDesired: async (a: string, n: number) => { calls.push(`${n}`); },
    getAsgStatus: async () => ({ desired: 1, instanceIds: [] }) });
  await expect(runRace(entrants, zeroDeps)).rejects.toThrow('레이스 타임아웃');
  expect(calls.filter((c) => c === '0')).toHaveLength(2); // 두 후보 모두 취소
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest test/cli-race.test.ts` / Expected: FAIL

- [ ] **Step 3: 구현**

```typescript
// cli/commands/race.ts — 리전 간 병렬 레이스 (스펙 R10: First-Acquired-Wins)
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
```

- [ ] **Step 4: 통과 확인 + 커밋**

```bash
npx jest test/cli-race.test.ts
git add cli/commands/race.ts test/cli-race.test.ts
git commit -m "feat: 리전 간 병렬 레이스 — 동시 desired=1, 첫 확보 승자, 패자 즉시 취소"
```

---

### Task 10: up 자동 모드 — 엔진 + 스탠바이 정책 + 레이스 통합

**Files:**
- Modify: `cli/commands/up.ts` (runUpAuto 추가), `cli/state.ts` (옵셔널 필드), `cli/program.ts` (up 커맨드 분기)
- Test: `test/cli-up-auto.test.ts`, `test/cli-state.test.ts` (하위 호환 1건 추가)

**Interfaces:**
- Consumes: Task 6 `gatherCandidates/rank`, Task 8 `ensureStackReady/waitReady`, Task 9 `runRace`, Task 1 `TfConfig`
- Produces:
  - `TfState`에 옵셔널 추가: `standbyRegions?: string[]; lastUsed?: Record<string, string>` (기존 3필드 파일과 하위 호환)
  - `runUpAuto(opts: { model: string; profile: string }, d: UpAutoDeps): Promise<{ endpoint: string; region: string }>`
  - `UpAutoDeps { config: TfConfig; gather: typeof gatherCandidates 시그니처; gatherDeps: GatherDeps; apiFor: (region: string) => AwsApi 계열; exec; probe; probeAuth; sleep; saveState; loadState; log; timeoutMs; now: () => Date }` — 정확한 타입은 구현에서 Pick으로 좁힐 것

- [ ] **Step 1: state 하위 호환 테스트 추가** — `test/cli-state.test.ts`에:

```typescript
test('구버전 상태 파일(3필드)도 로드되고 새 필드는 undefined', () => {
  fs.writeFileSync(path.join(dir, 'state.json'),
    JSON.stringify({ model: 'm', profile: 'p', region: 'r' }));
  const s = loadState(dir)!;
  expect(s.standbyRegions).toBeUndefined();
  expect(s.lastUsed).toBeUndefined();
});
```

`cli/state.ts`의 `TfState`를 `{ model: string; profile: string; region: string; standbyRegions?: string[]; lastUsed?: Record<string, string> }`로 확장. Run: `npx jest test/cli-state.test.ts` / Expected: PASS

- [ ] **Step 2: 실패하는 테스트 작성**

```typescript
// test/cli-up-auto.test.ts
import { runUpAuto } from '../cli/commands/up';
import { DEFAULT_CONFIG } from '../cli/config';
import { Candidate } from '../cli/placement/engine';

const cands: Candidate[] = [
  { region: 'ap-northeast-1', score: 8, scoreSource: 'feed48h', rttMs: 35, price: 2.7, cached: true },
  { region: 'ap-northeast-2', score: 7.8, scoreSource: 'feed48h', rttMs: 30, price: 2.6, cached: true },
  { region: 'us-east-1', score: 4, scoreSource: 'feed48h', rttMs: 180, price: 2.3, cached: false },
];

function makeDeps(overrides: Record<string, unknown> = {}) {
  const log: string[] = [];
  const ensured: string[] = [];
  const raced: string[][] = [];
  const saved: unknown[] = [];
  const deps = {
    config: { ...DEFAULT_CONFIG },
    gather: async () => ({ cands, notices: [] }),
    ensure: async (o: { region: string }) => {
      ensured.push(o.region);
      return { outputs: { EndpointUrl: `http://${o.region}`, ApiKeySecretArn: 'arn', WeightsBucketName: 'b', WeightsRepo: 'O/M' }, stackName: 'S' };
    },
    asgNameFor: async (region: string) => `asg-${region}`,
    race: async (entrants: { region: string }[]) => { raced.push(entrants.map((e) => e.region)); return entrants[0] as never; },
    wait: async (a: { outputs: Record<string, string> }) => ({ endpoint: a.outputs.EndpointUrl }),
    saveState: (s: unknown) => { saved.push(s); },
    log: (m: string) => { log.push(m); },
    now: () => new Date('2026-08-23T12:00:00Z'),
    ...overrides,
  };
  return { deps, log, ensured, raced, saved };
}

test('race 모드(기본): 상위 K=2 준비 → 레이스 → 승자에서 READY → 상태 저장', async () => {
  const { deps, ensured, raced, saved } = makeDeps();
  const r = await runUpAuto({ model: 'm', profile: 'p' }, deps as never);
  // 서열 1위 apne2(RTT 동치→저가), 2위 apne1
  expect(ensured).toEqual(['ap-northeast-2', 'ap-northeast-1']); // 순차 ensure (cdk 충돌 방지)
  expect(raced).toEqual([['ap-northeast-2', 'ap-northeast-1']]);
  expect(r.region).toBe('ap-northeast-2'); // race 스텁이 첫 entrant 반환
  const st = saved[saved.length - 1] as { region: string; standbyRegions: string[]; lastUsed: Record<string, string> };
  expect(st.region).toBe('ap-northeast-2');
  expect(st.standbyRegions).toEqual(['ap-northeast-2', 'ap-northeast-1']);
  expect(st.lastUsed['ap-northeast-2']).toBe('2026-08-23T12:00:00.000Z');
});

test('single 모드: 1위 리전만, 레이스 없음', async () => {
  const { deps, ensured, raced } = makeDeps({ config: { ...DEFAULT_CONFIG, standby: 'single' } });
  const r = await runUpAuto({ model: 'm', profile: 'p' }, deps as never);
  expect(ensured).toEqual(['ap-northeast-2']);
  expect(raced).toHaveLength(0);
  expect(r.region).toBe('ap-northeast-2');
});

test('lazy 모드: 레이스 후 패자 정리 제안 로그', async () => {
  const { deps, log } = makeDeps({ config: { ...DEFAULT_CONFIG, standby: 'lazy' } });
  await runUpAuto({ model: 'm', profile: 'p' }, deps as never);
  expect(log.some((l) => l.includes('tf down --purge --region ap-northeast-1'))).toBe(true);
});

test('캐시 상한 초과 시 LRU 정리 제안', async () => {
  const { deps, log } = makeDeps({
    loadState: () => ({ model: 'm', profile: 'p', region: 'ap-northeast-2',
      lastUsed: { 'us-east-1': '2026-08-01T00:00:00Z', 'us-west-2': '2026-08-10T00:00:00Z' } }),
  });
  await runUpAuto({ model: 'm', profile: 'p' }, deps as never);
  // race cap=K=2, 기존 2 + 신규 2 = 4 > 2 → 가장 오래된 us-east-1 정리 제안
  expect(log.some((l) => l.includes('us-east-1') && l.includes('--purge'))).toBe(true);
});
```

- [ ] **Step 3: 실패 확인** — Run: `npx jest test/cli-up-auto.test.ts` / Expected: FAIL

- [ ] **Step 4: 구현** — `cli/commands/up.ts`에 추가:

```typescript
import { TfConfig } from '../config';
import { Candidate, rank } from '../placement/engine';
import { RaceEntrant } from './race';

export interface UpAutoDeps {
  config: TfConfig;
  gather: () => Promise<{ cands: Candidate[]; notices: string[] }>;
  /** ensureStackReady를 리전만 바꿔 호출하는 클로저 (program.ts에서 조립) */
  ensure: (o: { model: string; profile: string; region: string }) => Promise<{ outputs: Record<string, string>; stackName: string }>;
  asgNameFor: (region: string, stackName: string) => Promise<string>;
  race: (entrants: RaceEntrant[]) => Promise<RaceEntrant>;
  wait: (a: { stackName: string; outputs: Record<string, string>; region: string }) => Promise<{ endpoint: string }>;
  saveState: (s: TfState) => void;
  loadState?: () => TfState | null;
  log: (m: string) => void;
  now: () => Date;
}

export async function runUpAuto(opts: { model: string; profile: string }, d: UpAutoDeps): Promise<{ endpoint: string; region: string }> {
  const { cands, notices } = await d.gather();
  notices.forEach(d.log);
  const ranked = rank(cands, { score: d.config.scoreTieThreshold, rttMs: d.config.rttTieThresholdMs });
  const k = d.config.standby === 'single' ? 1 : Math.min(d.config.k, ranked.length);
  const top = ranked.slice(0, k);
  d.log(`후보 선정: ${top.map((c, i) => `${i + 1}. ${c.region}(점수 ${c.score.toFixed(1)})`).join('  ')}`);

  // 스택·시딩은 순차 보장 — cdk.out 충돌 방지 (설계 결정 6)
  const prepared: { cand: Candidate; outputs: Record<string, string>; stackName: string; asgName: string }[] = [];
  for (const cand of top) {
    const { outputs, stackName } = await d.ensure({ model: opts.model, profile: opts.profile, region: cand.region });
    prepared.push({ cand, outputs, stackName, asgName: await d.asgNameFor(cand.region, stackName) });
  }

  let winner = prepared[0];
  if (prepared.length > 1) {
    const w = await d.race(prepared.map((p) => ({ region: p.cand.region, asgName: p.asgName, endpointUrl: p.outputs.EndpointUrl })));
    winner = prepared.find((p) => p.cand.region === w.region)!;
  }

  const prev = d.loadState?.() ?? null;
  const lastUsed = { ...(prev?.lastUsed ?? {}), [winner.cand.region]: d.now().toISOString() };
  const state: TfState = { model: opts.model, profile: opts.profile, region: winner.cand.region,
    standbyRegions: top.map((c) => c.region), lastUsed };
  d.saveState(state);

  const { endpoint } = await d.wait({ stackName: winner.stackName, outputs: winner.outputs, region: winner.cand.region });

  // lazy: 패자 스택 정리 제안 (자동 삭제 금지 — 설계 결정 4)
  if (d.config.standby === 'lazy') {
    for (const p of prepared.filter((x) => x !== winner)) {
      d.log(`lazy 모드 — 대기 스택 정리: tf down --purge --region ${p.cand.region}`);
    }
  }
  // 캐시 보유 리전 상한(설계 결정 5) 초과 시 LRU 정리 제안
  const cap = d.config.standby === 'race' ? d.config.k : d.config.standby === 'single' ? 1 : 2;
  const regions = Object.entries(lastUsed).sort(([, a], [, b]) => a.localeCompare(b)); // 오래된 순
  const over = regions.length - cap;
  for (let i = 0; i < over; i++) {
    if (top.some((c) => c.region === regions[i][0])) continue; // 이번 후보는 제안 제외
    d.log(`가중치 캐시 보유 리전이 상한(${cap})을 초과 — 정리 제안: tf down --purge --region ${regions[i][0]}`);
  }
  return { endpoint, region: winner.cand.region };
}
```

- [ ] **Step 5: program.ts up 커맨드 분기** — `--region` 기본값을 제거하고(옵션 정의에서 `'ap-northeast-2'` 삭제), 분기:

```typescript
  program.command('up <model>')
    .description('스팟 LLM 기동 — 리전 생략 시 배치 엔진이 자동 선정 + 병렬 레이스')
    .option('--profile <p>', '모델 프로파일 (기본: yaml 첫 프로파일)')
    .option('--region <r>', 'AWS 리전 (지정 시 해당 리전만 사용)')
    .action(async (model: string, o: { profile?: string; region?: string }) => {
      const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
      if (o.region) { // 기존 단일 리전 경로 (동작 불변)
        await runUp({ model, profile, region: o.region }, {
          api: new AwsApi(o.region), exec: execInherit, probeAuth,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          saveState, log: (m) => console.log(m), timeoutMs: 30 * 60 * 1000,
        });
        return;
      }
      const cfg = loadConfig();
      const rp = loadModelProfile(MODELS_DIR, model, profile);
      const types = rp.instanceType.split(',');
      const stackName = stackNameFor(model, profile);
      const tfDir = path.join(os.homedir(), '.token-forge');
      const mkUpDeps = (region: string) => ({
        api: new AwsApi(region), exec: execInherit, probeAuth,
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        saveState, log: (m: string) => console.log(m), timeoutMs: 30 * 60 * 1000,
      });
      const r = await runUpAuto({ model, profile }, {
        config: cfg,
        gather: () => gatherCandidates({ types, stackName, weightsRepo: rp.weightsRepo }, {
          config: cfg, fetchFeed: (u) => fetchFeed(u), apiFor: (rg) => new AwsApi(rg),
          getRtt: (rg) => getRtt(rg, { connect: tcpConnector, dir: tfDir, now: () => new Date() }),
          now: () => new Date(),
        }),
        ensure: (eo) => ensureStackReady(eo, mkUpDeps(eo.region)),
        asgNameFor: (region, sn) => new AwsApi(region).getAsgName(sn),
        race: (entrants) => runRace(entrants, {
          apiFor: (rg) => new AwsApi(rg), probe,
          sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
          log: (m) => console.log(m), timeoutMs: 30 * 60 * 1000,
        }),
        wait: (a) => waitReady({ stackName: a.stackName, outputs: a.outputs }, mkUpDeps(a.region)),
        saveState, loadState, log: (m) => console.log(m), now: () => new Date(),
      });
      console.log(`완료 — ${r.region} / ${r.endpoint}`);
    });
```

import 추가: `runUpAuto`, `ensureStackReady`, `waitReady`, `gatherCandidates`, `runRace` (기타는 이전 태스크에서 이미 추가됨).

- [ ] **Step 6: 통과 확인 + 커밋**

주의: `--region` 기본값 제거로 `test/cli-program.test.ts`가 up 커맨드의 region 기본값을 검증하고 있었다면 그 기대를 갱신한다(자동 모드 도입에 따른 의도된 변경 — 커밋 메시지에 명기).

```bash
npx jest && npm run build
git add cli/commands/up.ts cli/state.ts cli/program.ts test/cli-up-auto.test.ts test/cli-state.test.ts test/cli-program.test.ts
git commit -m "feat: tf up 자동 모드 — 배치 엔진 + 스탠바이 정책 + 병렬 레이스 통합"
```

---

### Task 11: down --region + 상태 정리

**Files:**
- Modify: `cli/commands/down.ts`, `cli/program.ts`, `cli/state.ts`
- Test: `test/cli-down.test.ts` (추가), `test/cli-state.test.ts` (추가)

**Interfaces:**
- Produces:
  - `state.ts`에 추가: `clearState(dir?: string): void` (state.json 삭제, 없으면 no-op), `removeRegionFromState(s: TfState, region: string): TfState` (standbyRegions·lastUsed에서 해당 리전 제거한 새 객체 반환 — 순수 함수)
  - `runDown` 시그니처 불변 — 리전 오버라이드는 program.ts에서 `{ ...state, region: 지정값 }`으로 전달

- [ ] **Step 1: 실패하는 테스트 작성** — `test/cli-state.test.ts`에:

```typescript
test('removeRegionFromState: standbyRegions·lastUsed에서 제거', () => {
  const s = { model: 'm', profile: 'p', region: 'r1',
    standbyRegions: ['r1', 'r2'], lastUsed: { r1: 't1', r2: 't2' } };
  const out = removeRegionFromState(s, 'r2');
  expect(out.standbyRegions).toEqual(['r1']);
  expect(out.lastUsed).toEqual({ r1: 't1' });
  expect(s.standbyRegions).toEqual(['r1', 'r2']); // 원본 불변
});

test('clearState: 파일 삭제, 없어도 오류 없음', () => {
  saveState({ model: 'm', profile: 'p', region: 'r' }, dir);
  clearState(dir);
  expect(loadState(dir)).toBeNull();
  clearState(dir); // 두 번째 호출도 안전
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx jest test/cli-state.test.ts` / Expected: FAIL

- [ ] **Step 3: state.ts 구현**

```typescript
export function clearState(dir: string = DEFAULT_DIR): void {
  fs.rmSync(path.join(dir, 'state.json'), { force: true });
}

/** 순수 함수 — purge된 리전의 흔적을 상태에서 제거 */
export function removeRegionFromState(s: TfState, region: string): TfState {
  const lastUsed = { ...(s.lastUsed ?? {}) };
  delete lastUsed[region];
  return { ...s, standbyRegions: (s.standbyRegions ?? []).filter((r) => r !== region), lastUsed };
}
```

- [ ] **Step 4: program.ts down 커맨드 확장** — 기존 down 액션을 교체:

```typescript
  program.command('down')
    .description('GPU 정지 (--purge: 스택·가중치 캐시까지 완전 삭제, --region: 대상 리전 지정)')
    .option('--purge', '완전 삭제', false)
    .option('--region <r>', '대상 리전 (기본: 마지막 up 리전)')
    .action(async (o: { purge: boolean; region?: string }) => {
      const state = requireState();
      const target = o.region ?? state.region;
      console.log(await runDown({ ...state, region: target }, o.purge,
        { api: new AwsApi(target), exec: execInherit }));
      if (o.purge) { // purge된 리전의 흔적을 상태에서 제거
        if (target === state.region) clearState();
        else saveState(removeRegionFromState(state, target));
      }
    });
```

주의: `runDown`은 내부에서 `stackNameFor(state.model, state.profile)`을 쓰므로 리전 오버라이드만으로 대상 스택이 올바르게 결정된다(스택 이름은 전 리전 동일). import에 `clearState`, `removeRegionFromState` 추가.

- [ ] **Step 5: down 리전 오버라이드 테스트** — `test/cli-down.test.ts`에 순수 함수 수준 검증 추가(기존 패턴대로 runDown에 리전 치환 상태를 넘겨 setDesired가 호출되는지):

```typescript
test('리전 오버라이드 상태로도 정지 동작 동일', async () => {
  const calls: string[] = [];
  const api = {
    getAsgName: async () => 'asg-x',
    setDesired: async (a: string, n: number) => { calls.push(`${a}:${n}`); },
    getStackOutputs: async () => null, emptyAndDeleteBucket: async () => {},
  };
  const msg = await runDown({ model: 'm', profile: 'p', region: 'us-west-2' }, false,
    { api: api as never, exec: async () => 0 });
  expect(calls).toEqual(['asg-x:0']);
  expect(msg).toContain('정지');
});
```

- [ ] **Step 6: 통과 확인 + 커밋**

```bash
npx jest && npm run build
git add cli/state.ts cli/commands/down.ts cli/program.ts test/cli-state.test.ts test/cli-down.test.ts
git commit -m "feat: tf down --region — 스탠바이 리전 정지·purge와 상태 정리"
```

---

### Task 12: README 갱신 + 통합 검증 + PR

**Files:**
- Modify: `README.md` (tf CLI 절 확장)

- [ ] **Step 1: README의 "## tf CLI (권장 인터페이스)" 절을 다음으로 교체** (코드 블록과 뒤따르는 두 문단 전체):

````markdown
## tf CLI (권장 인터페이스)

cdk 컨텍스트와 scripts/*.sh를 직접 다루는 대신 통합 CLI를 쓸 수 있다:

```bash
npm install && npm run build && npm link   # tf 명령 설치
tf model list                              # 검증된 모델 카탈로그
tf placement qwen3-coder-30b               # 리전 추천 표 (배치점수 48h·RTT·가격·쿼터)
tf up qwen3-coder-30b                      # 리전 자동 선정 + 병렬 레이스 기동 (R10)
tf up qwen3-coder-30b --region ap-northeast-2   # 리전 직접 지정
tf status                                  # 상태 확인
tf connect claude                          # Claude Code 연결 (source ~/.token-forge/env.sh)
tf down                                    # GPU 정지 (--purge: 완전 삭제, --region: 대상 지정)
tf config set standby single               # 스탠바이 정책: race(기본, K=2) | single | lazy
```

`--region`을 생략하면 배치 엔진이 공개 피드의 48시간 배치점수 평균, EC2 엔드포인트
RTT(24h 캐시), 스팟 가격, 계정 쿼터를 종합해 후보 리전을 서열화하고(안정성 → 레이턴시
→ 가격), 상위 K개 리전에 동시에 스팟을 요청해 먼저 확보한 리전만 남긴다(First-Acquired-
Wins). 피드가 대상 타입을 커버하지 않으면 실시간 배치점수로 자동 폴백한다.

첫 `up`은 선시딩 포함 약 20분, 이후에는 캐시 부팅으로 약 8분(스팟 즉시 배정 기준).
프라이버시 모드는 `tf config set feedUrl <자가 수집기 URL>`로 피드 조회조차 자기 계정
안에서 해결할 수 있다.
````

- [ ] **Step 2: 전체 검증**

Run: `npm test && npm run build && npx ts-node cli/tf.ts --help && npx ts-node cli/tf.ts config get`
Expected: 테스트 전체 통과(기존 75 + 신규 약 25), 도움말에 placement/config 표시, config 기본값 JSON 출력

- [ ] **Step 3: 스테일 산출물 정리 후 재확인** — Run: `find lib bin cli test \( -name '*.js' -o -name '*.d.ts' \) -delete && npm test` / Expected: 통과

- [ ] **Step 4: 커밋 + PR**

```bash
git add README.md
git commit -m "docs: README에 배치 엔진·병렬 레이스·placement/config 사용법 추가"
git push -u origin feat/tf-cli-phase2-placement
gh pr create --title "feat: tf CLI 2단계 — R10 배치 엔진 + 리전 간 병렬 레이스" \
  --body "스펙 R10(지능형 배치)과 파생 기능 요구 3·4 구현. 계획: docs/superpowers/plans/2026-08-23-tf-cli-phase2-placement.md"
# CodeSolar 리뷰 Green까지 수정 후 머지
```

- [ ] **Step 5: (선택, 사용자 승인 필요) 실전 검증** — `tf placement qwen3-coder-30b`로 추천 표 실측 확인(GPU 비용 0), 이후 원하면 `tf up qwen3-coder-30b` 레이스 완주 + 즉시 `tf down`. 레이스 검증은 후보 리전 2곳에 스택·시딩이 생기므로 비용(리전당 ALB 약 $16/월 + 시딩 $0.03 + S3 보관)을 사용자에게 먼저 고지할 것. 수집기 재배포(`npx cdk deploy -c collector=1`)도 사용자 확인 사항.

# tf CLI 1단계 (단일 리전 골격) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tf up / down / status / model / connect` 다섯 명령으로 단일 리전에서 스팟 LLM을 기동·정지·연결하는 통합 CLI를 만든다 (스펙 파생 기능 요구 1·2의 단일 리전 부분).

**Architecture:** commander 기반 TypeScript CLI(`cli/`)가 기존 자산(CDK 스택, scripts/seed-weights.sh)을 오케스트레이션한다. AWS 접근은 SDK v3를 얇게 감싼 `AwsApi` 클래스로 격리해 aws-sdk-client-mock으로 단위 테스트하고, 외부 프로세스(cdk·시딩 스크립트)는 주입 가능한 exec 함수로 격리한다. 배치 엔진·멀티리전 레이스는 계획 2, TLS는 계획 3에서 다룬다 — 이 계획에서 리전은 설정/플래그로 명시된다.

**Tech Stack:** TypeScript 5.6, Node >= 20(global fetch 사용), commander, @aws-sdk/client-{cloudformation,auto-scaling,ec2,secrets-manager,s3}, jest + ts-jest + aws-sdk-client-mock

**Spec:** docs/superpowers/specs/2026-08-22-token-forge-v1-requirements.md

## Global Constraints

- Node >= 20 (package.json engines 유지), 의존성은 위 Tech Stack 외 추가 금지 (R2: 텔레메트리 없음 — 분석/추적 라이브러리 절대 금지)
- 모든 명령은 사용자 계정 밖으로 데이터를 보내지 않는다 (허용 외부 통신: AWS API뿐 — 이 계획 범위에서는 HF/피드 접근 없음)
- 문서·커밋 메시지는 한국어, 마크다운 본문에 `~` 금지(범위는 `-`, 근사는 "약")
- 스테일 컴파일 산출물 주의: 테스트가 설명 불가하게 실패하면 `find lib bin cli test \( -name '*.js' -o -name '*.d.ts' \) -delete` 먼저
- 작업 브랜치 `feat/tf-cli-phase1`에서 태스크별 커밋, 전체 완료 후 PR 1건(CodeSolar 리뷰 Green까지 수정 후 머지)
- 기존 테스트 48개는 항상 통과 상태 유지 (`npm test`)

---

### Task 1: 스택 이름 규칙을 lib/naming.ts로 추출

CLI와 CDK 앱이 같은 스택 이름 규칙을 써야 한다. 현재 bin/token-forge.ts:25에 인라인으로 있다.

**Files:**
- Create: `lib/naming.ts`
- Modify: `bin/token-forge.ts:24-25`
- Test: `test/naming.test.ts`

**Interfaces:**
- Produces: `stackNameFor(model: string, profile: string): string` — 예: `stackNameFor('glm-4.6','fp8')` → `'TokenForge-glm-4-6-fp8'` (후속 모든 태스크가 사용)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/naming.test.ts
import { stackNameFor } from '../lib/naming';

test('모델·프로파일에서 CFN 제약에 맞는 스택 이름 생성', () => {
  expect(stackNameFor('solar-open2-250b', 'int4')).toBe('TokenForge-solar-open2-250b-int4');
  expect(stackNameFor('glm-4.6', 'fp8')).toBe('TokenForge-glm-4-6-fp8'); // 점 → 대시
});
```

- [ ] **Step 2: 실행해 실패 확인** — Run: `npx jest test/naming.test.ts` / Expected: FAIL "Cannot find module '../lib/naming'"

- [ ] **Step 3: 구현**

```typescript
// lib/naming.ts
/** CloudFormation 스택 이름 제약(/^[A-Za-z][A-Za-z0-9-]*$/)에 맞게 정규화 */
export function stackNameFor(model: string, profile: string): string {
  return `TokenForge-${model}-${profile}`.replace(/[^A-Za-z0-9-]/g, '-');
}
```

bin/token-forge.ts에서 인라인 정규화를 대체:

```typescript
// bin/token-forge.ts 상단 import에 추가
import { stackNameFor } from '../lib/naming';
// 기존 25행의
//   const stackName = `TokenForge-${model}-${profileName}`.replace(/[^A-Za-z0-9-]/g, '-');
// 를 다음으로 교체 (24행 주석은 naming.ts로 이동했으므로 삭제)
  const stackName = stackNameFor(model, profileName);
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `npm test` / Expected: 전체 통과(기존 48 + 신규 1)
- [ ] **Step 5: 커밋** — `git add lib/naming.ts bin/token-forge.ts test/naming.test.ts && git commit -m "refactor: 스택 이름 규칙을 lib/naming.ts로 추출 (CLI 공유 준비)"`

---

### Task 2: CLI 스캐폴드 (commander, tf --version)

**Files:**
- Create: `cli/tf.ts` (엔트리), `cli/program.ts` (커맨드 조립 — 테스트 대상)
- Modify: `package.json` (bin·deps), `.gitignore`(`cli/**/*.js` 등은 기존 `*.js` 무시 규칙 확인만)
- Test: `test/cli-program.test.ts`

**Interfaces:**
- Produces: `buildProgram(): Command` — commander 프로그램. 이후 태스크들이 `.addCommand()` 지점으로 사용
- Produces: package.json `"bin": {"tf": "cli/tf.js"}` — `npm run build` 후 `npm link`로 로컬 설치 가능

- [ ] **Step 1: 의존성 설치**

```bash
npm install commander @aws-sdk/client-cloudformation @aws-sdk/client-auto-scaling \
  @aws-sdk/client-ec2 @aws-sdk/client-secrets-manager @aws-sdk/client-s3
npm install -D aws-sdk-client-mock
```

- [ ] **Step 2: 실패하는 테스트 작성**

```typescript
// test/cli-program.test.ts
import { buildProgram } from '../cli/program';

test('프로그램 이름은 tf, --version 옵션이 등록돼 있다', () => {
  const program = buildProgram();
  expect(program.name()).toBe('tf');
  // program.version() getter는 commander 버전에 따라 동작이 달라 옵션 등록 여부로 검증
  expect(program.options.some((o) => o.long === '--version')).toBe(true);
});
```

- [ ] **Step 3: 실행해 실패 확인** — Run: `npx jest test/cli-program.test.ts` / Expected: FAIL
- [ ] **Step 4: 구현**

```typescript
// cli/program.ts
import { Command } from 'commander';
import * as pkg from '../package.json';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('tf')
    .description('token-forge — 내 AWS 계정 안의 프라이빗 바이브 코딩 LLM')
    .version(pkg.version);
  return program;
}
```

```typescript
// cli/tf.ts
#!/usr/bin/env node
import { buildProgram } from './program';

buildProgram().parseAsync(process.argv).catch((e) => {
  console.error(`오류: ${e.message}`);
  process.exit(1);
});
```

package.json에 추가 (tsconfig의 `resolveJsonModule`이 꺼져 있으면 `"resolveJsonModule": true`도 추가):

```json
"bin": { "tf": "cli/tf.js" }
```

- [ ] **Step 5: 테스트·수동 확인** — Run: `npm test && npx ts-node cli/tf.ts --version` / Expected: 테스트 통과, 버전 출력
- [ ] **Step 6: 커밋** — `git add -A && git commit -m "feat: tf CLI 스캐폴드 — commander 엔트리와 bin 등록"`

---

### Task 3: 모델 카탈로그 + `tf model list`

**Files:**
- Create: `cli/catalog.ts`
- Modify: `cli/program.ts`
- Test: `test/cli-catalog.test.ts`

**Interfaces:**
- Consumes: `loadModelProfile(modelsDir, model, profile)` (lib/model-profile.ts — 기존)
- Produces: `listModels(modelsDir: string): Array<{ model: string; profiles: string[] }>`
- Produces: `defaultProfile(modelsDir: string, model: string): string` — yaml에 선언된 첫 프로파일 키. Task 7·9가 `--profile` 생략 시 사용

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-catalog.test.ts
import * as path from 'path';
import { listModels, defaultProfile } from '../cli/catalog';

const MODELS = path.join(__dirname, '..', 'models');

test('models/ 디렉토리의 카탈로그를 나열한다', () => {
  const models = listModels(MODELS);
  const names = models.map((m) => m.model);
  expect(names).toEqual(expect.arrayContaining(['solar-open2-250b', 'glm-4-6', 'qwen3-coder-30b']));
  expect(models.find((m) => m.model === 'qwen3-coder-30b')!.profiles).toEqual(['fp8']);
});

test('기본 프로파일은 yaml의 첫 프로파일', () => {
  expect(defaultProfile(MODELS, 'solar-open2-250b')).toBe('int4');
});
```

- [ ] **Step 2: 실행해 실패 확인** — Run: `npx jest test/cli-catalog.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현**

```typescript
// cli/catalog.ts
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

interface CatalogEntry { model: string; profiles: string[] }

export function listModels(modelsDir: string): CatalogEntry[] {
  return fs.readdirSync(modelsDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => {
      const doc = yaml.load(fs.readFileSync(path.join(modelsDir, f), 'utf8')) as
        { model: string; profiles: Record<string, unknown> };
      return { model: doc.model, profiles: Object.keys(doc.profiles ?? {}) };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

export function defaultProfile(modelsDir: string, model: string): string {
  const entry = listModels(modelsDir).find((m) => m.model === model);
  if (!entry || entry.profiles.length === 0) {
    throw new Error(`모델 "${model}"을 카탈로그에서 찾을 수 없습니다. tf model list로 확인하세요.`);
  }
  return entry.profiles[0];
}
```

cli/program.ts의 `return program;` 직전에 추가:

```typescript
import * as path from 'path';
import { listModels } from './catalog';

const MODELS_DIR = path.join(__dirname, '..', 'models');

const model = program.command('model').description('모델 카탈로그');
model.command('list').description('사용 가능한 모델·프로파일 나열').action(() => {
  for (const m of listModels(MODELS_DIR)) {
    console.log(`${m.model}  (profiles: ${m.profiles.join(', ')})`);
  }
});
```

- [ ] **Step 4: 테스트·수동 확인** — Run: `npm test && npx ts-node cli/tf.ts model list` / Expected: 3개 모델 출력
- [ ] **Step 5: 커밋** — `git commit -am "feat: tf model list — 모델 카탈로그 나열"`

---

### Task 4: 상태 파일 (마지막 up 대상 기억)

status/down/connect가 인자 없이 동작하려면 마지막 `up`의 (model, profile, region)을 기억해야 한다.

**Files:**
- Create: `cli/state.ts`
- Test: `test/cli-state.test.ts`

**Interfaces:**
- Produces: `interface TfState { model: string; profile: string; region: string }`
- Produces: `saveState(s: TfState, dir?: string): void`, `loadState(dir?: string): TfState | null` — dir 기본값 `~/.token-forge` (테스트는 임시 디렉토리 주입)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-state.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveState, loadState } from '../cli/state';

test('상태 저장·로드 왕복', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-state-'));
  expect(loadState(dir)).toBeNull();
  saveState({ model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' }, dir);
  expect(loadState(dir)).toEqual({ model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' });
});
```

- [ ] **Step 2: 실행해 실패 확인** — Run: `npx jest test/cli-state.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현**

```typescript
// cli/state.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TfState { model: string; profile: string; region: string }

const DEFAULT_DIR = path.join(os.homedir(), '.token-forge');

export function saveState(s: TfState, dir: string = DEFAULT_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2));
}

export function loadState(dir: string = DEFAULT_DIR): TfState | null {
  const file = path.join(dir, 'state.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TfState;
}
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `npm test` / Expected: 통과
- [ ] **Step 5: 커밋** — `git commit -am "feat: tf 상태 파일 — 마지막 up 대상 기억"`

---

### Task 5: AwsApi — SDK 래퍼

**Files:**
- Create: `cli/aws.ts`
- Test: `test/cli-aws.test.ts`

**Interfaces:**
- Produces: `class AwsApi { constructor(region: string) }` 메서드 (전부 Promise):
  - `getStackOutputs(stackName): Promise<Record<string,string> | null>` — 스택 없으면 null
  - `getAsgName(stackName): Promise<string>` — 스택 리소스에서 `AWS::AutoScaling::AutoScalingGroup`의 PhysicalResourceId
  - `setDesired(asgName, n: number): Promise<void>` — desired=n (n=0이면 MinSize도 0)
  - `getAsgStatus(asgName): Promise<{ desired: number; instanceIds: string[] }>`
  - `getInstanceType(instanceId): Promise<string>`
  - `getSecret(arn): Promise<string>`
  - `emptyAndDeleteBucket(bucket): Promise<void>` — down --purge용 (버전 없는 버킷 가정)
- 후속 태스크는 이 시그니처만 사용한다. 실 AWS 호출은 없고 aws-sdk-client-mock으로 검증.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-aws.test.ts
import { mockClient } from 'aws-sdk-client-mock';
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { AutoScalingClient, SetDesiredCapacityCommand, UpdateAutoScalingGroupCommand, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { AwsApi } from '../cli/aws';

const cfnMock = mockClient(CloudFormationClient);
const asgMock = mockClient(AutoScalingClient);
beforeEach(() => { cfnMock.reset(); asgMock.reset(); });

test('getStackOutputs — 스택 출력 맵 반환, 미존재 시 null', async () => {
  cfnMock.on(DescribeStacksCommand, { StackName: 'S1' }).resolves({
    Stacks: [{ StackName: 'S1', CreationTime: new Date(), StackStatus: 'CREATE_COMPLETE',
      Outputs: [{ OutputKey: 'EndpointUrl', OutputValue: 'http://alb' }] }],
  });
  cfnMock.on(DescribeStacksCommand, { StackName: 'NOPE' })
    .rejects(new Error('Stack with id NOPE does not exist'));
  const api = new AwsApi('ap-northeast-2');
  expect(await api.getStackOutputs('S1')).toEqual({ EndpointUrl: 'http://alb' });
  expect(await api.getStackOutputs('NOPE')).toBeNull();
});

test('setDesired(0)은 MinSize도 0으로 내린다', async () => {
  asgMock.on(UpdateAutoScalingGroupCommand).resolves({});
  asgMock.on(SetDesiredCapacityCommand).resolves({});
  const api = new AwsApi('ap-northeast-2');
  await api.setDesired('my-asg', 0);
  expect(asgMock.commandCalls(UpdateAutoScalingGroupCommand)[0].args[0].input)
    .toMatchObject({ AutoScalingGroupName: 'my-asg', MinSize: 0, DesiredCapacity: 0 });
});
```

- [ ] **Step 2: 실행해 실패 확인** — Run: `npx jest test/cli-aws.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현**

```typescript
// cli/aws.ts
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { AutoScalingClient, SetDesiredCapacityCommand, UpdateAutoScalingGroupCommand, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';

export class AwsApi {
  private cfn: CloudFormationClient;
  private asg: AutoScalingClient;
  private ec2: EC2Client;
  private sm: SecretsManagerClient;
  private s3: S3Client;

  constructor(region: string) {
    this.cfn = new CloudFormationClient({ region });
    this.asg = new AutoScalingClient({ region });
    this.ec2 = new EC2Client({ region });
    this.sm = new SecretsManagerClient({ region });
    this.s3 = new S3Client({ region });
  }

  async getStackOutputs(stackName: string): Promise<Record<string, string> | null> {
    try {
      const out = await this.cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const outputs: Record<string, string> = {};
      for (const o of out.Stacks?.[0]?.Outputs ?? []) outputs[o.OutputKey!] = o.OutputValue!;
      return outputs;
    } catch (e) {
      if (e instanceof Error && e.message.includes('does not exist')) return null;
      throw e;
    }
  }

  async getAsgName(stackName: string): Promise<string> {
    const out = await this.cfn.send(new ListStackResourcesCommand({ StackName: stackName }));
    const asg = out.StackResourceSummaries?.find(
      (r) => r.ResourceType === 'AWS::AutoScaling::AutoScalingGroup');
    if (!asg?.PhysicalResourceId) throw new Error(`스택 ${stackName}에서 ASG를 찾을 수 없습니다`);
    return asg.PhysicalResourceId;
  }

  async setDesired(asgName: string, n: number): Promise<void> {
    if (n === 0) {
      await this.asg.send(new UpdateAutoScalingGroupCommand(
        { AutoScalingGroupName: asgName, MinSize: 0, DesiredCapacity: 0 }));
    } else {
      await this.asg.send(new SetDesiredCapacityCommand(
        { AutoScalingGroupName: asgName, DesiredCapacity: n }));
    }
  }

  async getAsgStatus(asgName: string): Promise<{ desired: number; instanceIds: string[] }> {
    const out = await this.asg.send(new DescribeAutoScalingGroupsCommand(
      { AutoScalingGroupNames: [asgName] }));
    const g = out.AutoScalingGroups?.[0];
    if (!g) throw new Error(`ASG ${asgName} 없음`);
    return { desired: g.DesiredCapacity ?? 0, instanceIds: (g.Instances ?? []).map((i) => i.InstanceId!) };
  }

  async getInstanceType(instanceId: string): Promise<string> {
    const out = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    return out.Reservations?.[0]?.Instances?.[0]?.InstanceType ?? 'unknown';
  }

  async getSecret(arn: string): Promise<string> {
    const out = await this.sm.send(new GetSecretValueCommand({ SecretId: arn }));
    return out.SecretString!;
  }

  async emptyAndDeleteBucket(bucket: string): Promise<void> {
    for (;;) {
      const list = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length === 0) break;
      await this.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      if (!list.IsTruncated) break;
    }
    await this.s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
}
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `npm test` / Expected: 통과
- [ ] **Step 5: 커밋** — `git commit -am "feat: AwsApi — CLI용 AWS SDK 래퍼 (mock 테스트 포함)"`

---

### Task 6: `tf status`

**Files:**
- Create: `cli/commands/status.ts`
- Modify: `cli/program.ts`
- Test: `test/cli-status.test.ts`

**Interfaces:**
- Consumes: `AwsApi`(Task 5), `loadState`(Task 4), `stackNameFor`(Task 1)
- Produces: `runStatus(deps: { api: AwsApi; state: TfState; probe: (url: string) => Promise<number> }): Promise<string[]>` — 출력 라인 배열(테스트 용이). probe는 엔드포인트 HTTP 상태 코드(도달 불가 시 0)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-status.test.ts
import { runStatus } from '../cli/commands/status';

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec' }),
    getAsgName: async () => 'asg-1',
    getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-123'] }),
    getInstanceType: async () => 'g6e.12xlarge',
    ...overrides,
  } as never;
}
const state = { model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' };

test('가동 중이면 인스턴스 타입과 READY 표시', async () => {
  const lines = await runStatus({ api: fakeApi(), state, probe: async () => 200 });
  expect(lines.join('\n')).toContain('g6e.12xlarge');
  expect(lines.join('\n')).toContain('READY');
});

test('스택 없으면 안내', async () => {
  const lines = await runStatus({ api: fakeApi({ getStackOutputs: async () => null }), state, probe: async () => 0 });
  expect(lines.join('\n')).toContain('스택 없음');
});
```

- [ ] **Step 2: 실행해 실패 확인** — Run: `npx jest test/cli-status.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현**

```typescript
// cli/commands/status.ts
import { AwsApi } from '../aws';
import { TfState } from '../state';
import { stackNameFor } from '../../lib/naming';

interface Deps { api: AwsApi; state: TfState; probe: (url: string) => Promise<number> }

export async function runStatus({ api, state, probe }: Deps): Promise<string[]> {
  const stackName = stackNameFor(state.model, state.profile);
  const lines = [`대상: ${state.model}/${state.profile} @ ${state.region} (${stackName})`];
  const outputs = await api.getStackOutputs(stackName);
  if (!outputs) return [...lines, '스택 없음 — tf up으로 생성하세요'];

  const asgName = await api.getAsgName(stackName);
  const { desired, instanceIds } = await api.getAsgStatus(asgName);
  if (instanceIds.length === 0) {
    return [...lines, desired === 0 ? '정지됨 (desired=0) — tf up으로 기동' : '스팟 확보 대기 중 (desired=1, 인스턴스 0대)'];
  }
  const type = await api.getInstanceType(instanceIds[0]);
  const code = await probe(`${outputs.EndpointUrl}/v1/models`);
  lines.push(`인스턴스: ${instanceIds[0]} (${type})`);
  lines.push(code === 200 ? `READY — ${outputs.EndpointUrl}` : `부팅 중 (엔드포인트 ${code || '연결 불가'})`);
  return lines;
}
```

cli/program.ts에 등록 (모든 명령 공통 헬퍼도 여기 추가 — Task 7-9가 재사용):

```typescript
import { AwsApi } from './aws';
import { loadState } from './state';
import { runStatus } from './commands/status';

/** 상태 파일 필수 로드 — 없으면 사용법 안내 후 종료 */
function requireState() {
  const s = loadState();
  if (!s) { console.error('기록된 대상이 없습니다. 먼저 tf up <model>을 실행하세요.'); process.exit(1); }
  return s;
}

/** 엔드포인트 프로브 — API 키 없이 상태 코드만 (401도 "떠 있음"의 신호) */
async function probe(url: string): Promise<number> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.status; }
  catch { return 0; }
}

program.command('status').description('현재 스택·인스턴스·엔드포인트 상태').action(async () => {
  const state = requireState();
  const lines = await runStatus({ api: new AwsApi(state.region), state, probe });
  lines.forEach((l) => console.log(l));
});
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `npm test` / Expected: 통과
- [ ] **Step 5: 커밋** — `git commit -am "feat: tf status — 스택·인스턴스·엔드포인트 상태 조회"`

---

### Task 7: `tf up <model>` — 스택 보장 → 시딩 보장 → 기동 → READY 대기

가장 큰 태스크. 흐름: ① 카탈로그 검증 ② 스택 없으면 `cdk deploy -c minCapacity=0` ③ S3 `.complete` 마커 없으면 seed-weights.sh 실행 ④ desired=1 ⑤ READY까지 폴링(유휴 강등 자동 복구 포함, 스펙 "교훈 반영" 절) ⑥ 상태 파일 저장.

**Files:**
- Create: `cli/commands/up.ts`
- Modify: `cli/program.ts`, `cli/aws.ts` (headObject 1개 메서드 추가)
- Test: `test/cli-up.test.ts`

**Interfaces:**
- Consumes: `AwsApi`, `stackNameFor`, `defaultProfile`, `saveState`
- Produces: `runUp(opts, deps): Promise<{ endpoint: string }>` — 시그니처는 Step 3 코드 참조. `deps.exec(cmd: string, args: string[]): Promise<number>`는 자식 프로세스(상속 stdio) 실행, `deps.sleep(ms)`, `deps.probeAuth(url, key)` 주입으로 테스트
- Produces(AwsApi 추가): `headObject(bucket, key): Promise<boolean>`

- [ ] **Step 1: AwsApi.headObject 테스트·구현 (같은 커밋)**

```typescript
// test/cli-aws.test.ts에 추가
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
const s3Mock = mockClient(S3Client);

test('headObject — 404는 false', async () => {
  s3Mock.on(HeadObjectCommand).rejectsOnce(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
  s3Mock.on(HeadObjectCommand).resolves({});
  const api = new AwsApi('ap-northeast-2');
  expect(await api.headObject('b', 'k')).toBe(false);
  expect(await api.headObject('b', 'k')).toBe(true);
});
```

```typescript
// cli/aws.ts — S3 import에 HeadObjectCommand 추가, 클래스에 메서드 추가
  async headObject(bucket: string, key: string): Promise<boolean> {
    try { await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
    catch (e) { if ((e as Error).name === 'NotFound' || (e as Error).name === '404') return false; throw e; }
  }
```

- [ ] **Step 2: runUp 실패하는 테스트 작성**

```typescript
// test/cli-up.test.ts
import { runUp } from '../cli/commands/up';

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[][] = [];
  return {
    calls,
    api: {
      getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' }),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-1'] }),
      setDesired: async () => undefined,
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    exec: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return 0; },
    probeAuth: async () => 200,
    sleep: async () => undefined,
    saveState: () => undefined,
    log: () => undefined,
    timeoutMs: 1000,
    ...overrides,
  } as never;
}
const opts = { model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' };

test('스택·시딩이 준비돼 있으면 cdk/seed를 건너뛰고 기동만 한다', async () => {
  const d = deps();
  const r = await runUp(opts, d);
  expect(r.endpoint).toBe('http://alb');
  expect((d as never as { calls: string[][] }).calls).toEqual([]); // exec 호출 없음
});

test('스택이 없으면 cdk deploy를 minCapacity=0으로 실행한다', async () => {
  let created = false;
  const d = deps({
    api: {
      // 첫 조회는 null → deploy 후 재조회는 outputs
      getStackOutputs: async () => (created ? {
        EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' } : null),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-1'] }),
      setDesired: async () => undefined,
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    exec: async (cmd: string, args: string[]) => { created = true; (d as never as { calls: string[][] }).calls.push([cmd, ...args]); return 0; },
  });
  await runUp(opts, d);
  const flat = (d as never as { calls: string[][] }).calls.map((c) => c.join(' ')).join('\n');
  expect(flat).toContain('cdk deploy');
  expect(flat).toContain('minCapacity=0');
});

test('READY 전 유휴 강등(desired=0)을 감지하면 복구한다', async () => {
  let call = 0; const restored: number[] = [];
  const d = deps({
    api: {
      getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' }),
      getAsgName: async () => 'asg-1',
      // 1회차: 강등 상태(desired 0) → 복구 기대, 2회차: 정상
      getAsgStatus: async () => (call++ === 0 ? { desired: 0, instanceIds: [] } : { desired: 1, instanceIds: ['i-1'] }),
      setDesired: async (_a: string, n: number) => { restored.push(n); },
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    probeAuth: (() => { let n = 0; return async () => (n++ < 2 ? 0 : 200); })(),
  });
  await runUp(opts, d);
  expect(restored).toContain(1); // 최초 기동 1회 + 강등 복구 1회 이상
  expect(restored.filter((x) => x === 1).length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 3: 실행해 실패 확인 후 구현** — Run: `npx jest test/cli-up.test.ts` / Expected: FAIL → 구현:

```typescript
// cli/commands/up.ts
import { AwsApi } from '../aws';
import { stackNameFor } from '../../lib/naming';
import { TfState } from '../state';

export interface UpOpts { model: string; profile: string; region: string }
export interface UpDeps {
  api: Pick<AwsApi, 'getStackOutputs' | 'getAsgName' | 'getAsgStatus' | 'setDesired' | 'getSecret' | 'headObject'>;
  exec: (cmd: string, args: string[]) => Promise<number>;
  probeAuth: (url: string, key: string) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  saveState: (s: TfState) => void;
  log: (msg: string) => void;
  timeoutMs: number; // 기본 30분 (스펙 R8)
}

export async function runUp(opts: UpOpts, d: UpDeps): Promise<{ endpoint: string }> {
  const stackName = stackNameFor(opts.model, opts.profile);

  // ① 스택 보장 (GPU 0대로 생성 — 스펙 R7 선시딩 워크플로)
  let outputs = await d.api.getStackOutputs(stackName);
  if (!outputs) {
    d.log(`스택 생성 중: ${stackName} @ ${opts.region} (GPU 0대, 약 5분)`);
    const code = await d.exec('npx', ['cdk', 'deploy',
      '-c', `model=${opts.model}`, '-c', `profile=${opts.profile}`,
      '-c', `region=${opts.region}`, '-c', 'minCapacity=0',
      '--require-approval', 'never']);
    if (code !== 0) throw new Error('cdk deploy 실패 — 위 출력을 확인하세요');
    outputs = await d.api.getStackOutputs(stackName);
    if (!outputs) throw new Error('배포 후에도 스택 출력을 읽을 수 없습니다');
  }

  // ② 가중치 시딩 보장 (스펙 R8: 첫 기동은 선시딩 포함 약 20분)
  const modelKey = outputs.WeightsRepo.replace(/\//g, '_');
  if (!(await d.api.headObject(outputs.WeightsBucketName, `${modelKey}/.complete`))) {
    d.log('가중치 캐시 없음 — CPU 스팟으로 선시딩 시작 (GPU 비용 없음)');
    const code = await d.exec('scripts/seed-weights.sh', [stackName, opts.region]);
    if (code !== 0) throw new Error('선시딩 실패 — 시더 로그를 확인하세요');
  }

  // ③ 기동 + ④ READY 대기 (상시 프로브가 유휴 알람 발화를 막고, 강등 시 자동 복구)
  const asgName = await d.api.getAsgName(stackName);
  await d.api.setDesired(asgName, 1);
  d.log('스팟 확보 대기 중 — 캐시 부팅 기준 약 8분');
  const key = await d.api.getSecret(outputs.ApiKeySecretArn);
  const deadline = Date.now() + d.timeoutMs;
  let acquired = false;
  while (Date.now() < deadline) {
    const code = await d.probeAuth(`${outputs.EndpointUrl}/v1/models`, key);
    if (code === 200) {
      d.saveState({ model: opts.model, profile: opts.profile, region: opts.region });
      d.log(`READY — ${outputs.EndpointUrl}`);
      d.log('다음: tf connect claude');
      return { endpoint: outputs.EndpointUrl };
    }
    const st = await d.api.getAsgStatus(asgName);
    if (st.desired === 0) {           // 유휴 가드 강등 감지 → 복구 (스펙 교훈 반영)
      d.log('유휴 가드 강등 감지 — desired=1 복구');
      await d.api.setDesired(asgName, 1);
    }
    if (!acquired && st.instanceIds.length > 0) { acquired = true; d.log('스팟 확보 — 부팅 중'); }
    await d.sleep(15000);
  }
  throw new Error('타임아웃(30분) — 스팟 용량 부족 가능성. 다른 리전으로 tf up --region <r>을 시도하세요');
}
```

cli/program.ts에 등록:

```typescript
import { spawn } from 'child_process';
import { runUp } from './commands/up';
import { defaultProfile } from './catalog';
import { saveState } from './state';

function execInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 1));
  });
}

async function probeAuth(url: string, key: string): Promise<number> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    return r.status;
  } catch { return 0; }
}

program.command('up <model>')
  .description('스팟 LLM 기동 (스택·시딩 자동 준비)')
  .option('--profile <p>', '모델 프로파일 (기본: yaml 첫 프로파일)')
  .option('--region <r>', 'AWS 리전', 'ap-northeast-2')
  .action(async (model: string, o: { profile?: string; region: string }) => {
    const profile = o.profile ?? defaultProfile(MODELS_DIR, model);
    await runUp({ model, profile, region: o.region }, {
      api: new AwsApi(o.region), exec: execInherit, probeAuth,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      saveState, log: (m) => console.log(m), timeoutMs: 30 * 60 * 1000,
    });
  });
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `npm test` / Expected: 통과
- [ ] **Step 5: 커밋** — `git commit -am "feat: tf up — 스택·시딩 보장 후 기동, READY 대기와 강등 자동복구"`

---

### Task 8: `tf down [--purge]`

**Files:**
- Create: `cli/commands/down.ts`
- Modify: `cli/program.ts`
- Test: `test/cli-down.test.ts`

**Interfaces:**
- Consumes: `AwsApi`, `stackNameFor`, `loadState`
- Produces: `runDown(state, purge, deps): Promise<string>` — 결과 메시지. purge=true면 cdk destroy 후 가중치 버킷(Retain이라 스택 삭제에서 제외됨)을 비우고 삭제

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-down.test.ts
import { runDown } from '../cli/commands/down';

const state = { model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' };

test('down — desired=0, min=0', async () => {
  const set: Array<[string, number]> = [];
  const msg = await runDown(state, false, {
    api: { getStackOutputs: async () => ({ WeightsBucketName: 'bkt' }),
      getAsgName: async () => 'asg-1',
      setDesired: async (a: string, n: number) => { set.push([a, n]); },
      emptyAndDeleteBucket: async () => undefined },
    exec: async () => 0,
  } as never);
  expect(set).toEqual([['asg-1', 0]]);
  expect(msg).toContain('정지');
});

test('down --purge — destroy 후 가중치 버킷 삭제', async () => {
  const calls: string[] = [];
  const msg = await runDown(state, true, {
    api: { getStackOutputs: async () => ({ WeightsBucketName: 'bkt' }),
      getAsgName: async () => 'asg-1', setDesired: async () => undefined,
      emptyAndDeleteBucket: async (b: string) => { calls.push(`del:${b}`); } },
    exec: async (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(' ')); return 0; },
  } as never);
  expect(calls.some((c) => c.includes('cdk destroy'))).toBe(true);
  expect(calls).toContain('del:bkt');
  expect(msg).toContain('완전 삭제');
});
```

- [ ] **Step 2: 실행해 실패 확인** — Run: `npx jest test/cli-down.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현**

```typescript
// cli/commands/down.ts
import { AwsApi } from '../aws';
import { TfState } from '../state';
import { stackNameFor } from '../../lib/naming';

interface Deps {
  api: Pick<AwsApi, 'getStackOutputs' | 'getAsgName' | 'setDesired' | 'emptyAndDeleteBucket'>;
  exec: (cmd: string, args: string[]) => Promise<number>;
}

export async function runDown(state: TfState, purge: boolean, d: Deps): Promise<string> {
  const stackName = stackNameFor(state.model, state.profile);
  const outputs = await d.api.getStackOutputs(stackName);
  if (!outputs) return '스택 없음 — 이미 삭제됨';

  if (!purge) {
    const asgName = await d.api.getAsgName(stackName);
    await d.api.setDesired(asgName, 0);
    return `정지 완료 (GPU 비용 0) — 스택·가중치 캐시는 유지, 재기동은 tf up`;
  }
  const bucket = outputs.WeightsBucketName;
  const code = await d.exec('npx', ['cdk', 'destroy', '--force',
    '-c', `model=${state.model}`, '-c', `profile=${state.profile}`, '-c', `region=${state.region}`]);
  if (code !== 0) throw new Error('cdk destroy 실패');
  await d.api.emptyAndDeleteBucket(bucket); // 가중치 버킷은 Retain — 별도 정리
  return `완전 삭제 완료 — 스택과 가중치 캐시(${bucket})까지 제거됨`;
}
```

cli/program.ts 등록:

```typescript
import { runDown } from './commands/down';

program.command('down')
  .description('GPU 정지 (--purge: 스택·가중치 캐시까지 완전 삭제)')
  .option('--purge', '완전 삭제', false)
  .action(async (o: { purge: boolean }) => {
    const state = requireState();
    console.log(await runDown(state, o.purge, { api: new AwsApi(state.region), exec: execInherit }));
  });
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `npm test` / Expected: 통과
- [ ] **Step 5: 커밋** — `git commit -am "feat: tf down — 정지 및 --purge 완전 삭제 (스펙 잔존물 정책)"`

---

### Task 9: `tf connect claude [--print]`

**Files:**
- Create: `cli/commands/connect.ts`
- Modify: `cli/program.ts`
- Test: `test/cli-connect.test.ts`

**Interfaces:**
- Consumes: `AwsApi`, `loadModelProfile`(lib/model-profile.ts), `stackNameFor`, `loadState`
- Produces: `renderClaudeEnv(endpoint, key, servedModel): string` — export 구문 텍스트. 기본 동작은 `~/.token-forge/env.sh` 기록 + `source` 안내, `--print`는 stdout 출력만
- served model 이름은 스택과 동일 규칙: 프로파일의 `weightsRepo` (boot.sh `--served-model-name`과 일치)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// test/cli-connect.test.ts
import { renderClaudeEnv } from '../cli/commands/connect';

test('Claude Code 환경변수 3종을 export 형식으로 렌더링', () => {
  const out = renderClaudeEnv('http://alb', 'SECRET', 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8');
  expect(out).toContain('export ANTHROPIC_BASE_URL="http://alb"');
  expect(out).toContain('export ANTHROPIC_AUTH_TOKEN="SECRET"');
  expect(out).toContain('export ANTHROPIC_MODEL="Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"');
});
```

- [ ] **Step 2: 실행해 실패 확인** — Run: `npx jest test/cli-connect.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현**

```typescript
// cli/commands/connect.ts
export function renderClaudeEnv(endpoint: string, key: string, servedModel: string): string {
  return [
    `export ANTHROPIC_BASE_URL="${endpoint}"`,
    `export ANTHROPIC_AUTH_TOKEN="${key}"`,
    `export ANTHROPIC_MODEL="${servedModel}"`,
    '',
  ].join('\n');
}
```

cli/program.ts 등록:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import { renderClaudeEnv } from './commands/connect';
import { loadModelProfile } from '../lib/model-profile';
import { stackNameFor } from '../lib/naming';

program.command('connect <client>')
  .description('클라이언트 연결 설정 생성 (지원: claude)')
  .option('--print', '파일 기록 없이 stdout으로만 출력', false)
  .action(async (client: string, o: { print: boolean }) => {
    if (client !== 'claude') { console.error(`미지원 클라이언트: ${client} (지원: claude)`); process.exit(1); }
    const state = requireState();
    const api = new AwsApi(state.region);
    const outputs = await api.getStackOutputs(stackNameFor(state.model, state.profile));
    if (!outputs) { console.error('스택 없음 — 먼저 tf up을 실행하세요.'); process.exit(1); }
    const key = await api.getSecret(outputs.ApiKeySecretArn);
    const served = loadModelProfile(MODELS_DIR, state.model, state.profile).weightsRepo;
    const env = renderClaudeEnv(outputs.EndpointUrl, key, served);
    if (o.print) { console.log(env); return; }
    const file = path.join(os.homedir(), '.token-forge', 'env.sh');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, env, { mode: 0o600 }); // API 키 포함 — 소유자만 읽기
    console.log(`기록됨: ${file}`);
    console.log(`적용:   source ${file} && claude`);
  });
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `npm test` / Expected: 통과
- [ ] **Step 5: 커밋** — `git commit -am "feat: tf connect claude — Claude Code 원커맨드 연결 (env.sh 0600)"`

---

### Task 10: README 갱신 + 통합 검증 + PR

**Files:**
- Modify: `README.md` (배포 절 앞에 CLI 절 신설)

- [ ] **Step 1: README에 CLI 절 추가** — "## 배포" 제목 바로 앞에 삽입:

````markdown
## tf CLI (권장 인터페이스)

cdk 컨텍스트와 scripts/*.sh를 직접 다루는 대신 통합 CLI를 쓸 수 있다:

```bash
npm install && npm run build && npm link   # tf 명령 설치
tf model list                              # 검증된 모델 카탈로그
tf up qwen3-coder-30b --region ap-northeast-2   # 스택·시딩 자동 준비 후 기동
tf status                                  # 상태 확인
tf connect claude                          # Claude Code 연결 (source ~/.token-forge/env.sh)
tf down                                    # GPU 정지 (--purge: 완전 삭제)
```

첫 `up`은 선시딩 포함 약 20분, 이후에는 캐시 부팅으로 약 8분(스팟 즉시 배정 기준).
리전 자동 선택(배치점수 기반)은 로드맵 참조.
````

- [ ] **Step 2: 전체 검증**

Run: `npm test && npm run build && npx ts-node cli/tf.ts model list && npx ts-node cli/tf.ts --help`
Expected: 테스트 전체 통과(기존 48 + 신규 약 12), 카탈로그 3종 출력, 도움말에 up/down/status/model/connect 표시

- [ ] **Step 3: 스테일 산출물 정리 후 재확인** — Run: `find lib bin cli test \( -name '*.js' -o -name '*.d.ts' \) -delete && npm test` / Expected: 통과
- [ ] **Step 4: 커밋 + PR**

```bash
git add README.md && git commit -m "docs: README에 tf CLI 사용법 추가"
git push -u origin feat/tf-cli-phase1
gh pr create --title "feat: tf CLI 1단계 — up/down/status/model/connect (단일 리전)" \
  --body "스펙 파생 기능 요구 1·2 구현. 계획: docs/superpowers/plans/2026-08-23-tf-cli-phase1.md"
# CodeSolar 리뷰 Green까지 수정 후 머지
```

- [ ] **Step 5: (선택, 사용자 승인 필요) 실전 검증** — 기존 서울 qwen3-coder-30b 스택 대상 `tf up qwen3-coder-30b` 1회 완주 후 즉시 `tf down`. GPU 비용 발생하므로 실행 전 사용자 확인 필수 (CLAUDE.local.md 비용 규칙).

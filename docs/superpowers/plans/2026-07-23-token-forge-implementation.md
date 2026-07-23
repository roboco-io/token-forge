# token-forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cdk deploy -c model=solar-open2-250b -c profile=int4` 한 번으로 Solar-Open2-250B를 EC2 스팟(p5.48xlarge)에서 OpenAI 호환 엔드포인트로 서빙하는 CDK 템플릿을 완성한다.

**Architecture:** 단일 스택 `TokenForgeStack`이 VPC(퍼블릭 서브넷 전 AZ) + ALB + ASG(min1/max1, Spot) + S3 가중치 캐시 + Secrets Manager API 키 + SNS 알림을 구성한다. 모델별 설정은 `models/*.yaml` 프로파일로 외부화하고, 부팅 스크립트(user-data)가 S3 캐시→NVMe 로드 후 Upstage 포크 vLLM 컨테이너를 기동한다.

**Tech Stack:** AWS CDK v2 (TypeScript), js-yaml, Jest + ts-jest, bash (user-data/smoke test), vLLM Docker (`upstage/vllm-solar-open2`)

## Global Constraints

- 스펙 원문: `docs/superpowers/specs/2026-07-23-token-forge-design.md`
- CDK: `aws-cdk-lib ^2.190.0`, `constructs ^10.4.2`, CLI `aws-cdk ^2.1005.0`, Node 20+
- 배포 인터페이스: `cdk deploy -c model=solar-open2-250b -c profile=int4 -c region=us-east-2` (region 기본값 `us-east-2`, model 기본 `solar-open2-250b`, profile 기본 `int4`)
- ASG **min1/max1 고정**, 오토스케일링 없음. 스팟 기본, 온디맨드 폴백 없음
- 인스턴스: `p5.48xlarge` (int4/bf16 공통), vLLM 포트 **8000**, 헬스체크 경로 **`/health`**, health check grace period **20분**
- vLLM 이미지: `upstage/vllm-solar-open2:v0.22.0-solar-open2` (Upstage 포크 필수, 업스트림 미병합)
- 필수 vLLM 플래그: `--tensor-parallel-size 8 --enable-expert-parallel --moe-backend triton --reasoning-parser solar_open2 --tool-call-parser solar_open2 --enable-auto-tool-choice`
- 컨텍스트 길이 캡 기본 **131072** (1M 풀 컨텍스트 금지 — 메모리 제약)
- INT4 가중치: `nota-ai/Solar-Open2-250B-Nota-INT4`, BF16: `upstage/Solar-Open2-250B`. HF 토큰 불필요(gated 아님)
- 스코프 제외: 웹 UI, 멀티 테넌시, 오토스케일링, npm 발행, SageMaker, HTTPS 인증서(도메인 필요 — README에 향후 과제로 명시)
- 부팅 스크립트는 **멱등**이어야 함 (재실행 안전)

## File Structure

```
token-forge/
├─ bin/token-forge.ts            # CDK 앱 엔트리 (컨텍스트 파싱 → 스택 생성)
├─ lib/
│  ├─ model-profile.ts           # 프로파일 YAML 로더/검증
│  └─ token-forge-stack.ts       # 단일 스택 (네트워크·스토리지·컴퓨트·알림)
├─ models/solar-open2-250b.yaml  # 모델 프로파일 (int4 / bf16)
├─ assets/user-data/boot.sh      # 부팅 스크립트 (플레이스홀더 치환 방식)
├─ scripts/smoke-test.sh         # 배포 후 수동 검증
├─ test/
│  ├─ model-profile.test.ts
│  ├─ boot-script.test.ts
│  └─ token-forge-stack.test.ts
├─ package.json / tsconfig.json / jest.config.js / cdk.json / .gitignore
└─ README.md
```

---

### Task 1: CDK 프로젝트 스캐폴딩

**Files:**
- Create: `package.json`, `tsconfig.json`, `jest.config.js`, `cdk.json`, `.gitignore`
- Create: `bin/token-forge.ts`, `lib/token-forge-stack.ts`
- Test: `test/token-forge-stack.test.ts`

**Interfaces:**
- Produces: 빈 `TokenForgeStack` 클래스 (Task 5에서 props를 받도록 확장), `npm test` / `npx cdk synth` 동작하는 프로젝트 골격

- [ ] **Step 1: 설정 파일 생성**

`package.json`:
```json
{
  "name": "token-forge",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "cdk": "cdk"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.190.0",
    "constructs": "^10.4.2",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.10.0",
    "aws-cdk": "^2.1005.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2",
    "typescript": "~5.6.3"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["es2022"],
    "strict": true,
    "declaration": true,
    "noImplicitAny": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "typeRoots": ["./node_modules/@types"]
  },
  "exclude": ["node_modules", "cdk.out"]
}
```

`jest.config.js`:
```js
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
};
```

`cdk.json`:
```json
{
  "app": "npx ts-node --prefer-ts-exts bin/token-forge.ts",
  "context": {
    "@aws-cdk/aws-ec2:restrictDefaultSecurityGroup": true,
    "@aws-cdk/aws-iam:minimizePolicies": true
  }
}
```

`.gitignore`:
```
node_modules/
cdk.out/
*.js
*.d.ts
!jest.config.js
.DS_Store
```

- [ ] **Step 2: 앱/스택 스텁 작성**

`lib/token-forge-stack.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class TokenForgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
```

`bin/token-forge.ts`:
```ts
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TokenForgeStack } from '../lib/token-forge-stack';

const app = new cdk.App();
new TokenForgeStack(app, 'TokenForge');
```

- [ ] **Step 3: 의존성 설치**

Run: `npm install`
Expected: 오류 없이 완료 (`node_modules/` 생성)

- [ ] **Step 4: 스캐폴딩 검증 테스트 작성**

`test/token-forge-stack.test.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { TokenForgeStack } from '../lib/token-forge-stack';

test('stack synthesizes', () => {
  const app = new cdk.App();
  const stack = new TokenForgeStack(app, 'Test');
  expect(Template.fromStack(stack).toJSON()).toBeDefined();
});
```

- [ ] **Step 5: 테스트와 synth 실행**

Run: `npm test && npx cdk synth --quiet`
Expected: 테스트 1개 PASS, synth 오류 없음

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json jest.config.js cdk.json .gitignore bin lib test
git commit -m "chore: scaffold CDK TypeScript project"
```

---

### Task 2: 모델 프로파일 파서

**Files:**
- Create: `lib/model-profile.ts`
- Create: `test/fixtures/dummy-model.yaml`
- Test: `test/model-profile.test.ts`

**Interfaces:**
- Produces: `loadModelProfile(modelsDir: string, model: string, profile: string): ResolvedProfile`
- Produces: `interface ResolvedProfile { model: string; profile: string; vllmImage: string; weightsRepo: string; instanceType: string; vllmFlags: string; maxModelLen: number; }`

- [ ] **Step 1: 테스트 픽스처 작성**

`test/fixtures/dummy-model.yaml`:
```yaml
model: dummy-model
vllmImage: example/vllm:latest
profiles:
  int4:
    weightsRepo: example/dummy-int4
    instanceType: p5.48xlarge
    vllmFlags: "--tensor-parallel-size 8"
    maxModelLen: 131072
  broken:
    weightsRepo: example/dummy-broken
    instanceType: p5.48xlarge
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/model-profile.test.ts`:
```ts
import * as path from 'path';
import { loadModelProfile } from '../lib/model-profile';

const fixturesDir = path.join(__dirname, 'fixtures');

describe('loadModelProfile', () => {
  test('resolves a valid profile', () => {
    const p = loadModelProfile(fixturesDir, 'dummy-model', 'int4');
    expect(p).toEqual({
      model: 'dummy-model',
      profile: 'int4',
      vllmImage: 'example/vllm:latest',
      weightsRepo: 'example/dummy-int4',
      instanceType: 'p5.48xlarge',
      vllmFlags: '--tensor-parallel-size 8',
      maxModelLen: 131072,
    });
  });

  test('throws when model file is missing', () => {
    expect(() => loadModelProfile(fixturesDir, 'no-such-model', 'int4'))
      .toThrow(/Model profile not found/);
  });

  test('throws when profile name is missing, listing available ones', () => {
    expect(() => loadModelProfile(fixturesDir, 'dummy-model', 'fp8'))
      .toThrow(/Profile "fp8" not found.*int4/);
  });

  test('throws when a required field is missing', () => {
    expect(() => loadModelProfile(fixturesDir, 'dummy-model', 'broken'))
      .toThrow(/missing required field "vllmFlags"/);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest test/model-profile.test.ts`
Expected: FAIL — `Cannot find module '../lib/model-profile'`

- [ ] **Step 4: 구현**

`lib/model-profile.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ProfileVariant {
  weightsRepo: string;
  instanceType: string;
  vllmFlags: string;
  maxModelLen: number;
}

interface ModelProfileFile {
  model: string;
  vllmImage: string;
  profiles: Record<string, Partial<ProfileVariant>>;
}

export interface ResolvedProfile extends ProfileVariant {
  model: string;
  profile: string;
  vllmImage: string;
}

const REQUIRED_FIELDS: (keyof ProfileVariant)[] = [
  'weightsRepo', 'instanceType', 'vllmFlags', 'maxModelLen',
];

export function loadModelProfile(
  modelsDir: string, model: string, profile: string,
): ResolvedProfile {
  const filePath = path.join(modelsDir, `${model}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Model profile not found: ${filePath}`);
  }
  const doc = yaml.load(fs.readFileSync(filePath, 'utf8')) as ModelProfileFile;
  const variant = doc.profiles?.[profile];
  if (!variant) {
    const available = Object.keys(doc.profiles ?? {}).join(', ');
    throw new Error(`Profile "${profile}" not found in ${filePath}. Available: ${available}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (variant[field] === undefined) {
      throw new Error(`Profile "${profile}" in ${filePath} missing required field "${field}"`);
    }
  }
  return {
    model: doc.model,
    profile,
    vllmImage: doc.vllmImage,
    ...(variant as ProfileVariant),
  };
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest test/model-profile.test.ts`
Expected: 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/model-profile.ts test/model-profile.test.ts test/fixtures/dummy-model.yaml
git commit -m "feat: model profile YAML loader with validation"
```

---

### Task 3: Solar-Open2-250B 프로파일

**Files:**
- Create: `models/solar-open2-250b.yaml`
- Modify: `test/model-profile.test.ts` (실제 프로파일 검증 테스트 추가)

**Interfaces:**
- Consumes: `loadModelProfile` (Task 2)
- Produces: `models/solar-open2-250b.yaml` — `int4`(기본)·`bf16` 프로파일. Task 5의 스택 테스트와 Task 9의 bin 앱이 이 파일을 로드한다.

- [ ] **Step 1: 실패하는 테스트 추가**

`test/model-profile.test.ts` 하단에 추가:
```ts
describe('solar-open2-250b profile', () => {
  const modelsDir = path.join(__dirname, '..', 'models');
  const REQUIRED_FLAGS = [
    '--tensor-parallel-size 8',
    '--enable-expert-parallel',
    '--moe-backend triton',
    '--reasoning-parser solar_open2',
    '--tool-call-parser solar_open2',
    '--enable-auto-tool-choice',
  ];

  test.each(['int4', 'bf16'])('%s profile is valid', (profile) => {
    const p = loadModelProfile(modelsDir, 'solar-open2-250b', profile);
    expect(p.vllmImage).toBe('upstage/vllm-solar-open2:v0.22.0-solar-open2');
    expect(p.instanceType).toBe('p5.48xlarge');
    expect(p.maxModelLen).toBe(131072);
    for (const flag of REQUIRED_FLAGS) {
      expect(p.vllmFlags).toContain(flag);
    }
  });

  test('int4 uses Nota quantized weights', () => {
    const p = loadModelProfile(modelsDir, 'solar-open2-250b', 'int4');
    expect(p.weightsRepo).toBe('nota-ai/Solar-Open2-250B-Nota-INT4');
  });

  test('bf16 uses original weights', () => {
    const p = loadModelProfile(modelsDir, 'solar-open2-250b', 'bf16');
    expect(p.weightsRepo).toBe('upstage/Solar-Open2-250B');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/model-profile.test.ts`
Expected: 새 테스트 FAIL — `Model profile not found: .../models/solar-open2-250b.yaml`

- [ ] **Step 3: 프로파일 작성**

`models/solar-open2-250b.yaml`:
```yaml
# upstage/Solar-Open2-250B — Hybrid-Attention MoE 250B (활성 15B)
# vLLM은 Upstage 포크 필수 (업스트림 미병합, 2026-07 기준)
model: solar-open2-250b
vllmImage: upstage/vllm-solar-open2:v0.22.0-solar-open2
profiles:
  int4:
    # 공식 양자화 (llm-compressor 포맷, ~150GB) — 기본 프로파일
    weightsRepo: nota-ai/Solar-Open2-250B-Nota-INT4
    instanceType: p5.48xlarge
    vllmFlags: >-
      --tensor-parallel-size 8 --enable-expert-parallel --moe-backend triton
      --reasoning-parser solar_open2 --tool-call-parser solar_open2
      --enable-auto-tool-choice
    # 1M 풀 컨텍스트는 KV 캐시 메모리상 불가 — 128K 캡
    maxModelLen: 131072
  bf16:
    # 원본 가중치 (~501GB, safetensors 94개)
    weightsRepo: upstage/Solar-Open2-250B
    instanceType: p5.48xlarge
    vllmFlags: >-
      --tensor-parallel-size 8 --enable-expert-parallel --moe-backend triton
      --reasoning-parser solar_open2 --tool-call-parser solar_open2
      --enable-auto-tool-choice
    maxModelLen: 131072
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest test/model-profile.test.ts`
Expected: 전체 PASS (YAML `>-` 폴딩이 플래그를 한 줄로 합치는지 확인 — `\n` 포함되면 FAIL)

- [ ] **Step 5: Commit**

```bash
git add models/solar-open2-250b.yaml test/model-profile.test.ts
git commit -m "feat: solar-open2-250b model profile (int4/bf16)"
```

---

### Task 4: 부팅 스크립트 (user-data)

**Files:**
- Create: `assets/user-data/boot.sh`
- Test: `test/boot-script.test.ts`

**Interfaces:**
- Produces: `assets/user-data/boot.sh` — `__REGION__`, `__API_KEY_SECRET_ARN__`, `__WEIGHTS_BUCKET__`, `__WEIGHTS_REPO__`, `__VLLM_IMAGE__`, `__VLLM_FLAGS__`, `__MAX_MODEL_LEN__` 7개 플레이스홀더를 포함하는 멱등 bash 스크립트. Task 7이 이 플레이스홀더들을 치환해 Launch Template user-data로 주입한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/boot-script.test.ts`:
```ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const scriptPath = path.join(__dirname, '..', 'assets', 'user-data', 'boot.sh');

describe('boot.sh', () => {
  const PLACEHOLDERS = [
    '__REGION__', '__API_KEY_SECRET_ARN__', '__WEIGHTS_BUCKET__',
    '__WEIGHTS_REPO__', '__VLLM_IMAGE__', '__VLLM_FLAGS__', '__MAX_MODEL_LEN__',
  ];

  test('exists and passes bash syntax check', () => {
    execFileSync('bash', ['-n', scriptPath]); // 문법 오류 시 throw
  });

  test('contains every CDK substitution placeholder', () => {
    const body = fs.readFileSync(scriptPath, 'utf8');
    for (const ph of PLACEHOLDERS) {
      expect(body).toContain(ph);
    }
  });

  test('is defensive and restarts vLLM idempotently', () => {
    const body = fs.readFileSync(scriptPath, 'utf8');
    expect(body).toContain('set -euo pipefail');
    expect(body).toContain('docker rm -f vllm');   // 재실행 안전
    expect(body).toContain('--restart always');    // 컨테이너 자동 재기동
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/boot-script.test.ts`
Expected: FAIL — `ENOENT ... assets/user-data/boot.sh`

- [ ] **Step 3: 스크립트 작성**

`assets/user-data/boot.sh`:
```bash
#!/usr/bin/env bash
# token-forge 부팅 스크립트 — CDK가 __PLACEHOLDER__를 치환해 user-data로 주입.
# 멱등: 재실행해도 안전 (설치·다운로드·컨테이너 기동 모두 존재 확인 후 수행).
set -euo pipefail
exec > >(tee -a /var/log/token-forge-boot.log) 2>&1

REGION="__REGION__"
SECRET_ARN="__API_KEY_SECRET_ARN__"
BUCKET="__WEIGHTS_BUCKET__"
WEIGHTS_REPO="__WEIGHTS_REPO__"
VLLM_IMAGE="__VLLM_IMAGE__"
VLLM_FLAGS="__VLLM_FLAGS__"
MAX_MODEL_LEN="__MAX_MODEL_LEN__"

MODEL_KEY="${WEIGHTS_REPO//\//_}"
# DLAMI가 인스턴스 스토어 NVMe를 /opt/dlami/nvme에 RAID0으로 마운트해 준다
MODEL_DIR="/opt/dlami/nvme/models/${MODEL_KEY}"
mkdir -p "${MODEL_DIR}"

# --- s5cmd 설치 (멱등) ---
if ! command -v s5cmd >/dev/null 2>&1; then
  curl -fsSL https://github.com/peak/s5cmd/releases/download/v2.3.0/s5cmd_2.3.0_Linux-64bit.tar.gz \
    | tar -xz -C /usr/local/bin s5cmd
fi

# --- API 키 조회 ---
API_KEY=$(aws secretsmanager get-secret-value --region "${REGION}" \
  --secret-id "${SECRET_ARN}" --query SecretString --output text)

# --- 가중치 로드: S3 캐시 우선, 없으면 HF 다운로드 후 시딩 ---
if aws s3api head-object --bucket "${BUCKET}" --key "${MODEL_KEY}/.complete" \
    --region "${REGION}" >/dev/null 2>&1; then
  echo "S3 cache hit — loading weights with s5cmd"
  s5cmd cp "s3://${BUCKET}/${MODEL_KEY}/*" "${MODEL_DIR}/"
else
  echo "S3 cache miss — downloading from Hugging Face"
  python3 -m pip install --quiet "huggingface_hub[cli]"
  ok=""
  for attempt in 1 2 3; do
    if python3 -m huggingface_hub.commands.huggingface_cli \
        download "${WEIGHTS_REPO}" --local-dir "${MODEL_DIR}"; then
      ok=1; break
    fi
    echo "HF download attempt ${attempt} failed; retrying in 30s"
    sleep 30
  done
  if [ -z "${ok}" ]; then
    echo "HF download failed after 3 attempts — leaving instance unhealthy"
    exit 1
  fi
  echo "Seeding S3 cache"
  s5cmd cp "${MODEL_DIR}/" "s3://${BUCKET}/${MODEL_KEY}/"
  date > /tmp/.complete
  aws s3 cp /tmp/.complete "s3://${BUCKET}/${MODEL_KEY}/.complete" --region "${REGION}"
fi

# --- vLLM 컨테이너 기동 (멱등: 기존 컨테이너 제거 후 재기동) ---
docker rm -f vllm >/dev/null 2>&1 || true
# shellcheck disable=SC2086  # VLLM_FLAGS는 의도적으로 워드 스플릿
docker run -d --name vllm --restart always --gpus all \
  --shm-size 32g -p 8000:8000 \
  -v "${MODEL_DIR}:/model" \
  "${VLLM_IMAGE}" \
  --model /model \
  --served-model-name "${WEIGHTS_REPO}" \
  --max-model-len "${MAX_MODEL_LEN}" \
  --api-key "${API_KEY}" \
  ${VLLM_FLAGS}

echo "boot.sh finished — waiting for vLLM /health via ALB health check"
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest test/boot-script.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add assets/user-data/boot.sh test/boot-script.test.ts
git commit -m "feat: idempotent boot script (S3 cache -> NVMe -> vLLM container)"
```

---

### Task 5: 스택 — 네트워크·보안그룹·ALB + bin 배선

**Files:**
- Modify: `lib/token-forge-stack.ts` (전체 재작성)
- Modify: `bin/token-forge.ts` (전체 재작성 — 컨텍스트 파싱)
- Modify: `test/token-forge-stack.test.ts` (전체 재작성 — 헬퍼 + 네트워크 테스트)

**Interfaces:**
- Consumes: `loadModelProfile`, `ResolvedProfile` (Task 2), `models/solar-open2-250b.yaml` (Task 3)
- Produces: `interface TokenForgeStackProps extends cdk.StackProps { resolvedProfile: ResolvedProfile }`. 스택 내부 변수 `vpc`, `albSg`, `instanceSg`, `alb`는 Task 6~8이 같은 생성자 안에서 이어서 사용한다. 테스트 헬퍼 `makeTemplate(): Template`도 이후 태스크가 재사용.

- [ ] **Step 1: 실패하는 테스트 작성 (전체 재작성)**

`test/token-forge-stack.test.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import { loadModelProfile } from '../lib/model-profile';
import { TokenForgeStack } from '../lib/token-forge-stack';

function makeTemplate(): Template {
  const app = new cdk.App();
  const resolvedProfile = loadModelProfile(
    path.join(__dirname, '..', 'models'), 'solar-open2-250b', 'int4',
  );
  const stack = new TokenForgeStack(app, 'Test', {
    resolvedProfile,
    env: { account: '111111111111', region: 'us-east-2' },
  });
  return Template.fromStack(stack);
}

describe('network', () => {
  const template = makeTemplate();

  test('VPC has public subnets only, no NAT gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
    });
  });

  test('ALB is internet-facing', () => {
    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { Scheme: 'internet-facing' },
    );
  });

  test('instance SG allows 8000 only from ALB SG', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 8000,
      ToPort: 8000,
      IpProtocol: 'tcp',
      SourceSecurityGroupId: Match.anyValue(),
    });
    // 인스턴스 SG에 0.0.0.0/0 인바운드가 없어야 한다
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const instanceSg = Object.values(sgs).find((sg) =>
      JSON.stringify(sg).includes('token-forge instance'),
    );
    expect(JSON.stringify(instanceSg?.Properties?.SecurityGroupIngress ?? []))
      .not.toContain('0.0.0.0/0');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/token-forge-stack.test.ts`
Expected: FAIL — `resolvedProfile` prop이 없다는 타입 오류 또는 리소스 미존재

- [ ] **Step 3: 스택 구현 (전체 재작성)**

`lib/token-forge-stack.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { ResolvedProfile } from './model-profile';

export interface TokenForgeStackProps extends cdk.StackProps {
  resolvedProfile: ResolvedProfile;
}

export class TokenForgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TokenForgeStackProps) {
    super(scope, id, props);
    const profile = props.resolvedProfile;

    // --- 네트워크: 퍼블릭 서브넷 전 AZ (스팟 확보율 극대화), NAT 불필요 ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 99,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'token-forge ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'public HTTP');

    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'token-forge instance',
      allowAllOutbound: true,
    });
    instanceSg.addIngressRule(albSg, ec2.Port.tcp(8000), 'vLLM from ALB only');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: cdk.Duration.seconds(300), // 긴 생성 응답 대비
    });

    // 이후 태스크에서 사용 (컴파일러 경고 방지용 임시 참조 — Task 7에서 제거)
    void alb;
    void instanceSg;
    void profile;
  }
}
```

- [ ] **Step 4: bin 앱 배선 (전체 재작성)**

`bin/token-forge.ts`:
```ts
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { loadModelProfile } from '../lib/model-profile';
import { TokenForgeStack } from '../lib/token-forge-stack';

const app = new cdk.App();
const model = app.node.tryGetContext('model') ?? 'solar-open2-250b';
const profileName = app.node.tryGetContext('profile') ?? 'int4';
const region = app.node.tryGetContext('region') ?? 'us-east-2';

const resolvedProfile = loadModelProfile(
  path.join(__dirname, '..', 'models'), model, profileName,
);

new TokenForgeStack(app, `TokenForge-${model}-${profileName}`, {
  resolvedProfile,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest test/token-forge-stack.test.ts && npm run build`
Expected: network 테스트 3개 PASS, 컴파일 오류 없음

- [ ] **Step 6: Commit**

```bash
git add lib/token-forge-stack.ts bin/token-forge.ts test/token-forge-stack.test.ts
git commit -m "feat: VPC + ALB + security groups, context-driven app wiring"
```

---

### Task 6: 스택 — S3 가중치 캐시·Secrets Manager·IAM 역할

**Files:**
- Modify: `lib/token-forge-stack.ts` (생성자에 추가)
- Modify: `test/token-forge-stack.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: Task 5의 생성자 내부 변수들
- Produces: 생성자 내부 변수 `weightsBucket: s3.Bucket`, `apiKeySecret: secretsmanager.Secret`, `instanceRole: iam.Role` — Task 7(user-data 치환·Launch Template role)과 Task 9(출력)가 사용

- [ ] **Step 1: 실패하는 테스트 추가**

`test/token-forge-stack.test.ts` 하단에 추가:
```ts
describe('storage and security', () => {
  const template = makeTemplate();

  test('weights bucket is retained on stack delete', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('API key secret is auto-generated without punctuation', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({
        ExcludePunctuation: true,
        PasswordLength: 48,
      }),
    });
  });

  test('instance role has SSM core managed policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ec2.amazonaws.com' },
          }),
        ]),
      }),
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('AmazonSSMManagedInstanceCore')]),
          ]),
        }),
      ]),
    });
  });

  test('instance role can read the secret and read/write the bucket', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          }),
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject']),
          }),
        ]),
      }),
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/token-forge-stack.test.ts`
Expected: 새 테스트 4개 FAIL (리소스 미존재)

- [ ] **Step 3: 구현 — 생성자에 추가**

`lib/token-forge-stack.ts` import에 추가:
```ts
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
```

생성자에서 `void alb;` 세 줄 앞에 삽입:
```ts
    // --- 스토리지: 가중치 캐시. 재배포 시 재다운로드 방지 위해 Retain ---
    const weightsBucket = new s3.Bucket(this, 'WeightsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- 보안: vLLM --api-key용 시크릿 자동 생성 ---
    const apiKeySecret = new secretsmanager.Secret(this, 'ApiKeySecret', {
      description: 'token-forge vLLM API key',
      generateSecretString: {
        excludePunctuation: true, // 셸/헤더 안전 문자만
        passwordLength: 48,
      },
    });

    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    weightsBucket.grantReadWrite(instanceRole);
    apiKeySecret.grantRead(instanceRole);
```

같은 위치의 임시 참조 줄을 다음으로 교체:
```ts
    // 이후 태스크에서 사용 (Task 7에서 제거)
    void alb;
    void instanceSg;
    void profile;
    void weightsBucket;
    void apiKeySecret;
    void instanceRole;
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest test/token-forge-stack.test.ts`
Expected: 전체 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/token-forge-stack.ts test/token-forge-stack.test.ts
git commit -m "feat: weights bucket, API key secret, instance IAM role"
```

---

### Task 7: 스택 — Launch Template(Spot)·ASG·타깃 그룹

**Files:**
- Modify: `lib/token-forge-stack.ts` (생성자에 추가, 임시 `void` 참조 제거)
- Modify: `test/token-forge-stack.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: Task 5의 `vpc`/`instanceSg`/`alb`, Task 6의 `weightsBucket`/`apiKeySecret`/`instanceRole`, Task 4의 `boot.sh` 플레이스홀더 7종
- Produces: 생성자 내부 변수 `asg: autoscaling.AutoScalingGroup` — Task 8(알람 디멘션)이 사용

- [ ] **Step 1: 실패하는 테스트 추가**

`test/token-forge-stack.test.ts` 하단에 추가:
```ts
describe('compute', () => {
  const template = makeTemplate();

  test('launch template uses spot p5.48xlarge with IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        InstanceType: 'p5.48xlarge',
        InstanceMarketOptions: Match.objectLike({ MarketType: 'spot' }),
        MetadataOptions: Match.objectLike({ HttpTokens: 'required' }),
      }),
    });
  });

  test('user data has substituted placeholders and vLLM flags', () => {
    const lts = template.findResources('AWS::EC2::LaunchTemplate');
    const userData = JSON.stringify(Object.values(lts)[0]);
    expect(userData).not.toContain('__WEIGHTS_REPO__'); // 치환 완료
    expect(userData).toContain('nota-ai/Solar-Open2-250B-Nota-INT4');
    expect(userData).toContain('--tensor-parallel-size 8');
    expect(userData).toContain('upstage/vllm-solar-open2:v0.22.0-solar-open2');
  });

  test('ASG is fixed min1/max1 with 20min ELB grace period', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1',
      MaxSize: '1',
      HealthCheckType: 'ELB',
      HealthCheckGracePeriod: 1200,
    });
  });

  test('target group health-checks vLLM /health on 8000', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 8000,
      HealthCheckPath: '/health',
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/token-forge-stack.test.ts`
Expected: compute 테스트 4개 FAIL

- [ ] **Step 3: 구현 — 생성자에 추가**

`lib/token-forge-stack.ts` import에 추가:
```ts
import * as fs from 'fs';
import * as path from 'path';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
```

생성자에서 `void` 임시 참조 블록 전체를 **삭제**하고 그 자리에 삽입:
```ts
    // --- 컴퓨트: DLAMI(base GPU) + Spot Launch Template + ASG min1/max1 ---
    const machineImage = ec2.MachineImage.fromSsmParameter(
      '/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id',
      { os: ec2.OperatingSystemType.LINUX },
    );

    const bootScript = fs
      .readFileSync(path.join(__dirname, '..', 'assets', 'user-data', 'boot.sh'), 'utf8')
      .replace(/__REGION__/g, this.region)
      .replace(/__API_KEY_SECRET_ARN__/g, apiKeySecret.secretArn)
      .replace(/__WEIGHTS_BUCKET__/g, weightsBucket.bucketName)
      .replace(/__WEIGHTS_REPO__/g, profile.weightsRepo)
      .replace(/__VLLM_IMAGE__/g, profile.vllmImage)
      .replace(/__VLLM_FLAGS__/g, profile.vllmFlags)
      .replace(/__MAX_MODEL_LEN__/g, String(profile.maxModelLen));

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: new ec2.InstanceType(profile.instanceType),
      machineImage,
      userData: ec2.UserData.custom(bootScript),
      role: instanceRole,
      securityGroup: instanceSg,
      associatePublicIpAddress: true, // 퍼블릭 서브넷, NAT 없음
      requireImdsv2: true,
      spotOptions: {
        interruptionBehavior: ec2.SpotInstanceInterruption.TERMINATE,
      },
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(200, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
        }),
      }],
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1, // 스코프: 오토스케일링 없음
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        gracePeriod: cdk.Duration.minutes(20), // 모델 로드 ~15분 + 여유
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
      }),
      groupMetrics: [autoscaling.GroupMetrics.all()], // Task 8 알람에 필요
    });

    const listener = alb.addListener('Http', { port: 80, open: true });
    listener.addTargets('Vllm', {
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asg],
      healthCheck: {
        path: '/health', // vLLM은 --api-key 사용 시에도 /health는 무인증
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest && npm run build`
Expected: 전체 테스트 PASS, 컴파일 오류 없음
(참고: `HealthCheckType: 'ELB'` 단언이 실패하면 합성된 값이 `'EBS,EC2,ELB'` 형태일 수 있음 — 그 경우 단언을 `HealthCheckType: Match.stringLikeRegexp('ELB')`로 수정)

- [ ] **Step 5: Commit**

```bash
git add lib/token-forge-stack.ts test/token-forge-stack.test.ts
git commit -m "feat: spot launch template, min1/max1 ASG, ALB target wiring"
```

---

### Task 8: 스택 — 스팟 중단 알림·용량 부족 알람

**Files:**
- Modify: `lib/token-forge-stack.ts` (생성자에 추가)
- Modify: `test/token-forge-stack.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: Task 7의 `asg`
- Produces: 생성자 내부 변수 `alertTopic: sns.Topic`. 컨텍스트 `-c alertEmail=<addr>` 지정 시 이메일 구독 추가

- [ ] **Step 1: 실패하는 테스트 추가**

`test/token-forge-stack.test.ts` 하단에 추가:
```ts
describe('alerts', () => {
  const template = makeTemplate();

  test('EventBridge routes spot interruption warnings to SNS', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.ec2'],
        'detail-type': ['EC2 Spot Instance Interruption Warning'],
      },
    });
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  test('alarm fires when InService < 1 for 30 minutes', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'GroupInServiceInstances',
      Namespace: 'AWS/AutoScaling',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1,
      EvaluationPeriods: 6,
      Period: 300,
      TreatMissingData: 'breaching',
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/token-forge-stack.test.ts`
Expected: alerts 테스트 2개 FAIL

- [ ] **Step 3: 구현 — 생성자 끝(listener 블록 뒤)에 추가**

`lib/token-forge-stack.ts` import에 추가:
```ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
```

생성자 끝에 추가:
```ts
    // --- 알림: 스팟 중단 경고 + 30분 무용량 알람 → SNS ---
    const alertTopic = new sns.Topic(this, 'AlertTopic');
    const alertEmail = this.node.tryGetContext('alertEmail');
    if (alertEmail) {
      alertTopic.addSubscription(new subs.EmailSubscription(alertEmail));
    }

    new events.Rule(this, 'SpotInterruptionRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Spot Instance Interruption Warning'],
      },
      targets: [new targets.SnsTopic(alertTopic)],
    });

    const noCapacityAlarm = new cloudwatch.Alarm(this, 'NoCapacityAlarm', {
      alarmDescription: 'token-forge: no in-service instance for 30 minutes (spot quota/capacity?)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AutoScaling',
        metricName: 'GroupInServiceInstances',
        dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 6, // 5분 × 6 = 30분
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    noCapacityAlarm.addAlarmAction(new cwactions.SnsAction(alertTopic));
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest`
Expected: 전체 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/token-forge-stack.ts test/token-forge-stack.test.ts
git commit -m "feat: spot interruption SNS alert and 30min no-capacity alarm"
```

---

### Task 9: 스택 출력 + synth 종단 검증

**Files:**
- Modify: `lib/token-forge-stack.ts` (CfnOutput 추가)
- Modify: `test/token-forge-stack.test.ts` (출력 테스트 추가)

**Interfaces:**
- Consumes: Task 5의 `alb`, Task 6의 `apiKeySecret`/`weightsBucket`
- Produces: 스택 출력 `EndpointUrl`, `ApiKeySecretArn`, `WeightsBucketName` — README(Task 10)와 smoke-test 사용자가 참조

- [ ] **Step 1: 실패하는 테스트 추가**

`test/token-forge-stack.test.ts` 하단에 추가:
```ts
describe('outputs', () => {
  const template = makeTemplate();

  test.each(['EndpointUrl', 'ApiKeySecretArn', 'WeightsBucketName'])(
    'exposes %s output', (name) => {
      template.hasOutput(name, {});
    },
  );
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/token-forge-stack.test.ts`
Expected: outputs 테스트 3개 FAIL

- [ ] **Step 3: 구현 — 생성자 맨 끝에 추가**

```ts
    // --- 출력 ---
    new cdk.CfnOutput(this, 'EndpointUrl', {
      value: `http://${alb.loadBalancerDnsName}`,
      description: 'OpenAI-compatible endpoint base URL',
    });
    new cdk.CfnOutput(this, 'ApiKeySecretArn', {
      value: apiKeySecret.secretArn,
      description: 'Retrieve: aws secretsmanager get-secret-value --secret-id <arn>',
    });
    new cdk.CfnOutput(this, 'WeightsBucketName', { value: weightsBucket.bucketName });
```

- [ ] **Step 4: 통과 확인 + 실제 배포 인터페이스로 synth**

Run: `npx jest && npx cdk synth -c model=solar-open2-250b -c profile=int4 -c region=us-east-2 --quiet`
Expected: 전체 테스트 PASS, synth 성공. 이어서 `npx cdk synth -c model=solar-open2-250b -c profile=bf16 --quiet`도 성공, `npx cdk synth -c profile=fp8 2>&1 | grep 'Profile "fp8" not found'`가 매치되어야 함

- [ ] **Step 5: Commit**

```bash
git add lib/token-forge-stack.ts test/token-forge-stack.test.ts
git commit -m "feat: stack outputs and end-to-end synth verification"
```

---

### Task 10: 스모크 테스트 스크립트 + README

**Files:**
- Create: `scripts/smoke-test.sh`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 9의 출력 `EndpointUrl`/`ApiKeySecretArn`
- Produces: `scripts/smoke-test.sh <endpoint-url> <api-key>` — `/v1/models`·`/v1/chat/completions` 검증

- [ ] **Step 1: 스모크 테스트 작성**

`scripts/smoke-test.sh`:
```bash
#!/usr/bin/env bash
# 사용법: scripts/smoke-test.sh http://<alb-dns> <api-key>
# 실 배포 후 수동 실행 (비용상 CI 제외)
set -euo pipefail

ENDPOINT="${1:?usage: smoke-test.sh <endpoint-url> <api-key>}"
API_KEY="${2:?api key required (aws secretsmanager get-secret-value ...)}"
AUTH=(-H "Authorization: Bearer ${API_KEY}")

echo "==> GET /v1/models"
MODELS_JSON=$(curl -fsS "${AUTH[@]}" "${ENDPOINT}/v1/models")
MODEL_ID=$(echo "${MODELS_JSON}" | jq -re '.data[0].id')
echo "    model: ${MODEL_ID}"

echo "==> POST /v1/chat/completions"
REPLY=$(curl -fsS "${AUTH[@]}" -H 'Content-Type: application/json' \
  "${ENDPOINT}/v1/chat/completions" \
  -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}],\"max_tokens\":32}")
echo "${REPLY}" | jq -re '.choices[0].message.content'

echo "PASS: endpoint is serving ${MODEL_ID}"
```

- [ ] **Step 2: 문법·동작 확인**

Run: `bash -n scripts/smoke-test.sh && chmod +x scripts/smoke-test.sh && scripts/smoke-test.sh 2>&1 | grep -q 'usage:' || scripts/smoke-test.sh; echo "exit=$?"`
Expected: 문법 오류 없음, 인자 없이 실행 시 usage 메시지와 함께 종료 코드 1

- [ ] **Step 3: README 작성**

`README.md`:
````markdown
# token-forge

Hugging Face 오픈소스 LLM을 AWS **스팟 인스턴스 기본**으로 서빙하는 AWS CDK 템플릿.
초기 타겟: [upstage/Solar-Open2-250B](https://huggingface.co/upstage/Solar-Open2-250B).

## 사전 조건

- **p5 스팟 vCPU 쿼터 192개** — 대부분 계정 기본 0. Service Quotas에서
  "All P5 Spot Instance Requests" 상향 신청 필요.
- 비용 참고: p5.48xlarge 스팟 약 **$30~50/hr** (리전·시점 변동). 사용 후 `cdk destroy` 권장.
- Node 20+, AWS CDK CLI (`npm i -g aws-cdk`), 부트스트랩된 계정(`cdk bootstrap`).

## 배포

```bash
npm install
cdk deploy -c model=solar-open2-250b -c profile=int4 -c region=us-east-2
# 옵션: -c profile=bf16  -c alertEmail=you@example.com
```

첫 부팅은 HF 다운로드 + S3 시딩으로 오래 걸린다(INT4 ~150GB).
이후 재프로비저닝은 S3 캐시에서 s5cmd 로드로 단축(목표 ~15분).

## 사용

```bash
API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id <ApiKeySecretArn 출력값> --query SecretString --output text)
scripts/smoke-test.sh http://<EndpointUrl 출력값> "${API_KEY}"
```

OpenAI SDK: `base_url="http://<EndpointUrl>/v1"`, `api_key=${API_KEY}`.

## 새 모델 추가

`models/<model-name>.yaml` 1개 추가 → `cdk deploy -c model=<model-name> -c profile=<profile>`.
스키마는 `models/solar-open2-250b.yaml` 참고 (`vllmImage`, `profiles.<name>.{weightsRepo,instanceType,vllmFlags,maxModelLen}`).

## 트러블슈팅

| 증상 | 확인 |
|---|---|
| 30분 넘게 InService 0 (SNS 알람) | p5 스팟 쿼터/용량 부족. Service Quotas·다른 리전 검토 |
| 인스턴스가 계속 교체됨 | SSM 세션 접속 → `cat /var/log/token-forge-boot.log`, `docker logs vllm` (OOM 등) |
| 스팟 중단 알림 수신 | 정상 — ASG가 자동 재프로비저닝. S3 캐시로 ~15분 내 복구 |
| HF 다운로드 3회 실패 | 로그 확인 후 인스턴스 종료(ASG 교체) 또는 네트워크 점검 |

## 스코프 (YAGNI)

오토스케일링 없음(min1/max1), 웹 UI 없음, HTTPS는 도메인+ACM 필요로 향후 과제
(현재 HTTP + API 키 — 민감 데이터에는 사용 금지).
````

- [ ] **Step 4: 전체 회귀 확인**

Run: `npm test && npm run build`
Expected: 전체 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-test.sh README.md
git commit -m "docs: README with prerequisites/troubleshooting, smoke test script"
```

---

## 검증 요약 (스펙 대비 커버리지)

| 스펙 항목 | 태스크 |
|---|---|
| 프로파일 YAML + 파서 | 2, 3 |
| VPC 전 AZ 퍼블릭 / ALB / SG 8000 제한 | 5 |
| S3 캐시·Secrets Manager·IAM | 6 |
| Spot LT + ASG min1/max1 + grace 20분 + DLAMI | 7 |
| 부팅 스크립트 멱등(캐시→s5cmd/HF 3회 재시도→docker) | 4 |
| EventBridge 스팟 경고 / InService=0 30분 알람 | 8 |
| `cdk deploy -c ...` 인터페이스 + 출력 | 5, 9 |
| 스모크 테스트 / README(쿼터·비용·트러블슈팅) | 10 |

**실 배포 통합 테스트는 CI 제외** (스펙 §7) — Task 10의 smoke-test.sh를 수동 실행.



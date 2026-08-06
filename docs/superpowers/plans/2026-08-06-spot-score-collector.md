# 스팟 배치 점수 수집기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** p5.48xlarge 스팟 배치 점수를 1시간마다 수집해 DynamoDB에 90일 보존하는 별도 CDK 스택.

**Architecture:** EventBridge `rate(1 hour)` → inline Lambda(NODEJS_22_X)가 `GetSpotPlacementScores`를 리전 단위·AZ 단위로 2회 호출 → 결과를 DynamoDB(`scope` PK / `ts` SK, TTL `expireAt`)에 BatchWrite. 기존 서빙 스택과 완전 분리된 `TokenForge-SpotScoreCollector` 스택, `-c collector=1` 컨텍스트 게이트로 합성.

**Tech Stack:** AWS CDK v2(TypeScript), Lambda inline 코드(AWS SDK v3 — 런타임 내장), DynamoDB, EventBridge, jest + ts-jest.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-08-06-spot-score-collector-design.md`
- 수집 대상 초기값 `p5.48xlarge`, 리전 `us-east-1,us-east-2,us-west-2`, TTL 90일 — 전부 Lambda env로 주입 (`INSTANCE_TYPES`/`REGIONS`/`TTL_DAYS`)
- 스택명 `TokenForge-SpotScoreCollector`, 배포 리전 us-east-1
- 테이블 RemovalPolicy `DESTROY`
- 기존 서빙 스택 배포 UX(`-c model=... -c profile=...`) 절대 불변
- 커밋 메시지는 한국어, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 포함
- 주의: 스테일 `*.js`/`*.d.ts`가 ts-jest를 가리면 먼저 삭제 (CLAUDE.md)

---

### Task 1: SpotScoreCollectorStack + 단위 테스트

**Files:**
- Create: `lib/spot-score-collector-stack.ts`
- Test: `test/spot-score-collector-stack.test.ts`

**Interfaces:**
- Consumes: 없음 (독립 스택)
- Produces: `export class SpotScoreCollectorStack extends cdk.Stack` — 생성자 시그니처 `(scope: Construct, id: string, props?: cdk.StackProps)`. Task 2의 bin이 import.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/spot-score-collector-stack.test.ts`:

```typescript
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SpotScoreCollectorStack } from '../lib/spot-score-collector-stack';

function makeCollectorTemplate(): Template {
  const app = new cdk.App();
  const stack = new SpotScoreCollectorStack(app, 'TestCollector', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

test('테이블은 scope/ts 키 + TTL(expireAt) + 온디맨드 과금', () => {
  const t = makeCollectorTemplate();
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'scope', KeyType: 'HASH' },
      { AttributeName: 'ts', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    TimeToLiveSpecification: { AttributeName: 'expireAt', Enabled: true },
  });
});

test('테이블은 스택 삭제 시 함께 삭제된다(DESTROY)', () => {
  const t = makeCollectorTemplate();
  t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
});

test('1시간 간격 EventBridge 룰이 Lambda를 타깃으로 한다', () => {
  const t = makeCollectorTemplate();
  t.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(1 hour)',
    State: 'ENABLED',
    Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
  });
});

test('Lambda 런타임과 수집 파라미터 env 주입', () => {
  const t = makeCollectorTemplate();
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Timeout: 60,
    Environment: {
      Variables: Match.objectLike({
        INSTANCE_TYPES: 'p5.48xlarge',
        REGIONS: 'us-east-1,us-east-2,us-west-2',
        TTL_DAYS: '90',
      }),
    },
  });
});

test('역할에 GetSpotPlacementScores와 테이블 BatchWriteItem 권한', () => {
  const t = makeCollectorTemplate();
  t.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 'ec2:GetSpotPlacementScores', Effect: 'Allow' }),
        Match.objectLike({ Action: 'dynamodb:BatchWriteItem', Effect: 'Allow' }),
      ]),
    }),
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/spot-score-collector-stack.test.ts`
Expected: FAIL — `Cannot find module '../lib/spot-score-collector-stack'`

- [ ] **Step 3: 스택 구현**

`lib/spot-score-collector-stack.ts`:

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * 스팟 배치 점수 수집기 — 서빙 스택과 독립적으로 상시 가동되는 별도 스택.
 * 1시간마다 GetSpotPlacementScores(리전·AZ 단위)를 조회해 DynamoDB에 적재한다.
 * 설계: docs/superpowers/specs/2026-08-06-spot-score-collector-design.md
 */
export class SpotScoreCollectorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'ScoresTable', {
      partitionKey: { name: 'scope', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expireAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const collectorFn = new lambda.Function(this, 'CollectorFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      environment: {
        TABLE_NAME: table.tableName,
        INSTANCE_TYPES: 'p5.48xlarge',
        REGIONS: 'us-east-1,us-east-2,us-west-2',
        TTL_DAYS: '90',
      },
      code: lambda.Code.fromInline(`
const { EC2Client, GetSpotPlacementScoresCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
const ec2 = new EC2Client();
const ddb = new DynamoDBClient();

exports.handler = async () => {
  const instanceTypes = process.env.INSTANCE_TYPES.split(',');
  const regions = process.env.REGIONS.split(',');
  const ttlDays = parseInt(process.env.TTL_DAYS || '90', 10);
  const now = new Date();
  const ts = now.toISOString().slice(0, 19) + 'Z';
  const expireAt = Math.floor(now.getTime() / 1000) + ttlDays * 86400;

  const items = [];
  let failures = 0;
  // single=false: 리전 단위 점수, single=true: AZ 단위 점수
  for (const single of [false, true]) {
    try {
      const out = await ec2.send(new GetSpotPlacementScoresCommand({
        InstanceTypes: instanceTypes,
        TargetCapacity: 1,
        RegionNames: regions,
        SingleAvailabilityZone: single,
      }));
      for (const s of out.SpotPlacementScores ?? []) {
        const scope = single ? 'az#' + s.AvailabilityZoneId : 'region#' + s.Region;
        items.push({ PutRequest: { Item: {
          scope: { S: scope },
          ts: { S: ts },
          score: { N: String(s.Score) },
          instanceType: { S: instanceTypes.join(',') },
          expireAt: { N: String(expireAt) },
        } } });
      }
    } catch (e) {
      failures += 1;
      console.error('GetSpotPlacementScores failed (single=' + single + '):', e);
    }
  }
  if (failures === 2) throw new Error('both placement score calls failed');
  if (items.length === 0) { console.error('no scores returned'); return; }

  // BatchWriteItem은 25건 제한 — 청크 후 UnprocessedItems 1회 재시도
  for (let i = 0; i < items.length; i += 25) {
    let req = { [process.env.TABLE_NAME]: items.slice(i, i + 25) };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await ddb.send(new BatchWriteItemCommand({ RequestItems: req }));
      const un = (res.UnprocessedItems || {})[process.env.TABLE_NAME];
      if (!un || un.length === 0) { req = null; break; }
      req = { [process.env.TABLE_NAME]: un };
    }
    if (req) console.error('unprocessed items remain:', JSON.stringify(req));
  }
};
`),
    });

    table.grant(collectorFn, 'dynamodb:BatchWriteItem');
    collectorFn.addToRolePolicy(new iam.PolicyStatement({
      // 이 API는 리소스 수준 권한을 지원하지 않음
      actions: ['ec2:GetSpotPlacementScores'],
      resources: ['*'],
    }));

    new events.Rule(this, 'HourlyRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(collectorFn)],
    });

    new cdk.CfnOutput(this, 'ScoresTableName', { value: table.tableName });
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest test/spot-score-collector-stack.test.ts`
Expected: PASS 5건. 실패 시 스테일 `*.js` 산출물 먼저 의심(`find lib test -name '*.js' -delete` 후 재시도).

- [ ] **Step 5: 전체 테스트 + 타입 체크**

Run: `npm test && npm run build`
Expected: 기존 테스트 포함 전부 PASS, tsc 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add lib/spot-score-collector-stack.ts test/spot-score-collector-stack.test.ts
git commit -m "feat: 스팟 배치 점수 수집기 스택 (Lambda+DynamoDB, 1시간 주기, TTL 90일)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: bin 컨텍스트 게이트 + 문서

**Files:**
- Modify: `bin/token-forge.ts` (전체 23줄 — 컨텍스트 분기 추가)
- Modify: `CLAUDE.md` (명령어 섹션에 수집기 배포·삭제 추가)

**Interfaces:**
- Consumes: Task 1의 `SpotScoreCollectorStack` (`../lib/spot-score-collector-stack`)
- Produces: `npx cdk synth|deploy|destroy -c collector=1` CLI 계약

- [ ] **Step 1: bin 분기 구현**

`bin/token-forge.ts`의 `const app = new cdk.App();` 직후를 다음 구조로 변경
(기존 서빙 스택 로직은 else 블록으로 그대로 이동):

```typescript
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { loadModelProfile } from '../lib/model-profile';
import { TokenForgeStack } from '../lib/token-forge-stack';
import { SpotScoreCollectorStack } from '../lib/spot-score-collector-stack';

const app = new cdk.App();

if (app.node.tryGetContext('collector')) {
  // 수집기 전용 합성 — 서빙 스택과 상호 배타로 기존 UX를 보존한다
  new SpotScoreCollectorStack(app, 'TokenForge-SpotScoreCollector', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  });
} else {
  const model = app.node.tryGetContext('model') ?? 'solar-open2-250b';
  const profileName = app.node.tryGetContext('profile') ?? 'int4';
  const region = app.node.tryGetContext('region') ?? 'us-east-2';

  const resolvedProfile = loadModelProfile(
    path.join(__dirname, '..', 'models'), model, profileName,
  );

  // CloudFormation 스택 이름 제약(/^[A-Za-z][A-Za-z0-9-]*$/)에 맞게 정규화
  const stackName = `TokenForge-${model}-${profileName}`.replace(/[^A-Za-z0-9-]/g, '-');

  new TokenForgeStack(app, stackName, {
    resolvedProfile,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  });
}
```

- [ ] **Step 2: synth 양방향 수동 검증**

Run: `npx cdk synth -c collector=1 --quiet 2>&1 | tail -3 && npx cdk synth -c model=solar-open2-250b -c profile=int4 --quiet 2>&1 | tail -3`
Expected: 둘 다 에러 없이 종료. 첫 번째는 수집기 스택만, 두 번째는 기존 서빙 스택만 합성.

- [ ] **Step 3: CLAUDE.md 명령어 추가**

CLAUDE.md의 명령어 코드블록에서 `scripts/start.sh` 라인 위에 추가:

```bash
npx cdk deploy -c collector=1              # 스팟 배치점수 수집기 (별도 스택, 상시 가동)
npx cdk destroy -c collector=1             # 수집기 삭제 (수집 이력도 함께 삭제됨)
```

- [ ] **Step 4: 전체 테스트 확인**

Run: `npm test`
Expected: 전부 PASS (bin 변경이 기존 스택 테스트에 영향 없음 확인)

- [ ] **Step 5: 커밋**

```bash
git add bin/token-forge.ts CLAUDE.md
git commit -m "feat: -c collector=1 게이트로 수집기 스택 합성 분기 + 명령어 문서

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 배포 + 실측 검증

**Files:** 없음 (운영 검증)

**Interfaces:**
- Consumes: Task 2의 `npx cdk deploy -c collector=1`
- Produces: 가동 중인 `TokenForge-SpotScoreCollector` 스택 (월 $0.01 미만, GPU 무관)

- [ ] **Step 1: 배포**

Run: `npx cdk deploy -c collector=1 --require-approval never`
Expected: `TokenForge-SpotScoreCollector` CREATE_COMPLETE, 출력 `ScoresTableName` 확인

- [ ] **Step 2: Lambda 수동 1회 실행**

```bash
FN=$(aws cloudformation describe-stack-resources --stack-name TokenForge-SpotScoreCollector \
  --region us-east-1 --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)
aws lambda invoke --function-name "$FN" --region us-east-1 /dev/stdout
```

Expected: StatusCode 200, FunctionError 없음

- [ ] **Step 3: 적재 데이터 확인**

```bash
TABLE=$(aws cloudformation describe-stacks --stack-name TokenForge-SpotScoreCollector \
  --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='ScoresTableName'].OutputValue" --output text)
aws dynamodb scan --table-name "$TABLE" --region us-east-1 --max-items 25 \
  --query 'Items[].[scope.S, ts.S, score.N]' --output text | sort
```

Expected: `region#` 3건 + `az#` 여러 건, score 1~10, 동일 ts. `expireAt`이 약 90일 뒤 epoch초인지 1건 눈으로 확인.

- [ ] **Step 4: 완료 보고**

수집 시작 시각·테이블명·다음 자동 실행(1시간 뒤)을 사용자에게 보고.
GPU 인스턴스와 무관한 스택이므로 비용 가드 대상 아님을 명시.

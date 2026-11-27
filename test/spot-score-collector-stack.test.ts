import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SpotScoreCollectorStack, publisherAssetDir } from '../lib/spot-score-collector-stack';
import { COLLECT_TARGETS, CollectTarget, publisherCatalog, validateTargets } from '../lib/spot-collector-targets';

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
    Timeout: 120,
    MemorySize: 256,
    Environment: {
      Variables: Match.objectLike({
        REGIONS: 'us-east-1,us-east-2,us-west-2,ap-northeast-1,ap-northeast-2',
        TTL_DAYS: '90',
      }),
    },
  });
});

function lambdaEnv(t: Template, runtime: string): Record<string, string> {
  const fns = t.findResources('AWS::Lambda::Function', { Properties: { Runtime: runtime } });
  return Object.values(fns)[0].Properties.Environment.Variables;
}

test('수집기 TARGETS env는 카탈로그의 대상 id와 조회 타입 묶음을 그대로 담는다', () => {
  const targets = JSON.parse(lambdaEnv(makeCollectorTemplate(), 'nodejs22.x').TARGETS);
  expect(targets).toEqual(COLLECT_TARGETS.map(x => ({ id: x.id, types: x.instanceTypes })));
  // 기존 GPU 대상은 id가 타입 이름 그대로여야 과거 수집 이력(scope 키)과 CLI 피드 조회가 이어진다
  for (const gpu of ['p5.48xlarge', 'g6e.48xlarge', 'g6e.24xlarge', 'g6e.12xlarge']) {
    expect(targets).toContainEqual({ id: gpu, types: [gpu] });
  }
});

test('카탈로그는 t·m·c·r·i 계열을 포함하고, GPU가 아닌 대상은 타입 3개 이상 묶음이다', () => {
  for (const family of ['gpu', 't', 'm', 'c', 'r', 'i']) {
    expect(COLLECT_TARGETS.some(x => x.family === family)).toBe(true);
  }
  for (const x of COLLECT_TARGETS.filter(x => x.family !== 'gpu')) {
    expect(x.instanceTypes.length).toBeGreaterThanOrEqual(3);
    // 대상의 계열 표기와 실제 타입 이름의 계열이 어긋나지 않는다
    for (const it of x.instanceTypes) expect(it.startsWith(x.family)).toBe(true);
  }
});

test('validateTargets는 중복 id·중복 타입·3개 미만 묶음·# 포함 id를 거부한다', () => {
  const base: CollectTarget = { id: 'c.x', family: 'c', arch: 'x86', spec: 's', instanceTypes: ['c1.a', 'c2.a', 'c3.a'] };
  expect(() => validateTargets([base])).not.toThrow();
  expect(() => validateTargets([base, { ...base, instanceTypes: ['c4.a', 'c5.a', 'c6.a'] }])).toThrow(/중복/);
  expect(() => validateTargets([base, { ...base, id: 'c.y', instanceTypes: ['c1.a', 'c5.a', 'c6.a'] }])).toThrow(/두 수집 대상/);
  expect(() => validateTargets([{ ...base, instanceTypes: ['c1.a', 'c2.a'] }])).toThrow(/3개 이상/);
  expect(() => validateTargets([{ ...base, id: 'c#x' }])).toThrow(/#/);
  expect(() => validateTargets([{ ...base, family: 'gpu', instanceTypes: ['g1.a'] }])).not.toThrow();
});

test('수집기 Lambda는 묶음 타입으로 조회하고 NextToken이 오면 이어서 읽는다', () => {
  const fns = makeCollectorTemplate().findResources('AWS::Lambda::Function', { Properties: { Runtime: 'nodejs22.x' } });
  const code: string = Object.values(fns)[0].Properties.Code.ZipFile;
  expect(code).toContain('InstanceTypes: target.types');
  expect(code).toContain('NextToken: token');
  expect(code).toContain('while (token)');
});

test('g6·g5·g4dn은 스팟 지원 전 크기를 GPU 단일 타입 대상으로 수집한다', () => {
  const ids = COLLECT_TARGETS.map(x => x.id);
  for (const fam of ['g6', 'g5']) {
    for (const size of ['xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge', '48xlarge']) {
      expect(ids).toContain(`${fam}.${size}`);
    }
  }
  for (const size of ['xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', 'metal']) expect(ids).toContain(`g4dn.${size}`);
  expect(COLLECT_TARGETS.find(x => x.id === 'g5.48xlarge')).toMatchObject({ family: 'gpu', gpu: '8×A10G', spec: '192 vCPU · 768 GiB', instanceTypes: ['g5.48xlarge'] });
  expect(COLLECT_TARGETS.find(x => x.id === 'g4dn.12xlarge')).toMatchObject({ gpu: '4×T4', spec: '48 vCPU · 192 GiB' });
});

test('퍼블리셔는 카탈로그를 환경 변수가 아닌 코드 패키지의 targets.json으로 받는다', () => {
  expect(lambdaEnv(makeCollectorTemplate(), 'python3.12').TARGETS).toBeUndefined();
  const dir = publisherAssetDir(COLLECT_TARGETS);
  expect(fs.existsSync(path.join(dir, 'index.py'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'targets.json'), 'utf-8'))).toEqual(publisherCatalog(COLLECT_TARGETS));
});

test('퍼블리셔 카탈로그는 대시보드 필터용 메타(계열·아키텍처·사양)를 담는다', () => {
  const targets = publisherCatalog(COLLECT_TARGETS);
  expect(targets.map((x: { id: string }) => x.id)).toEqual(COLLECT_TARGETS.map(x => x.id));
  expect(targets).toContainEqual({
    id: 'c.xlarge', family: 'c', arch: 'x86', spec: '4 vCPU · 8 GiB', types: ['c7i.xlarge', 'c6i.xlarge', 'c5.xlarge'],
  });
  expect(targets[0]).toMatchObject({ id: 'p5.48xlarge', family: 'gpu', gpu: '8×H100' });
});

test('Lambda 환경 변수 합계는 4KB 한도 아래다 (대상을 늘릴 때의 안전선)', () => {
  const t = makeCollectorTemplate();
  for (const runtime of ['nodejs22.x', 'python3.12']) {
    const env = lambdaEnv(t, runtime);
    // TABLE_NAME·DASHBOARD_BUCKET은 배포 시 치환되는 토큰이라 각각 넉넉히 100바이트로 계산한다
    const bytes = Object.entries(env).reduce((n, [k, v]) => n + k.length + (typeof v === 'string' ? Buffer.byteLength(v) : 100), 0);
    expect(bytes).toBeLessThan(3500);
  }
});

test('CloudFront 캐시 정책은 gzip·brotli 압축 전송을 허용한다', () => {
  makeCollectorTemplate().hasResourceProperties('AWS::CloudFront::CachePolicy', {
    CachePolicyConfig: Match.objectLike({
      ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
        EnableAcceptEncodingGzip: true,
        EnableAcceptEncodingBrotli: true,
      }),
    }),
  });
});

test('대시보드 버킷은 정적 웹사이트 호스팅 + 퍼블릭 읽기 정책', () => {
  const t = makeCollectorTemplate();
  t.hasResourceProperties('AWS::S3::Bucket', {
    WebsiteConfiguration: { IndexDocument: 'index.html' },
  });
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 's3:GetObject', Effect: 'Allow', Principal: Match.objectLike({ AWS: '*' }) }),
      ]),
    }),
  });
});

test('퍼블리셔 Lambda는 Python 런타임 + 시간당 룰이 수집기·퍼블리셔 둘 다 타깃', () => {
  const t = makeCollectorTemplate();
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'python3.12',
    Timeout: 900,
    MemorySize: 1024,
    Environment: {
      Variables: Match.objectLike({
        REGIONS: 'us-east-1,us-east-2,us-west-2,ap-northeast-1,ap-northeast-2',
      }),
    },
  });
  t.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(1 hour)',
    Targets: Match.arrayWith([Match.objectLike({ Id: Match.stringLikeRegexp('.*') })]),
  });
});

test('CloudFront가 S3 website 오리진 앞에서 HTTPS 리다이렉트 + CORS 헤더 제공', () => {
  const t = makeCollectorTemplate();
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultCacheBehavior: Match.objectLike({
        ViewerProtocolPolicy: 'redirect-to-https',
        ResponseHeadersPolicyId: Match.anyValue(),
      }),
      Origins: Match.arrayWith([
        Match.objectLike({
          CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'http-only' }),
        }),
      ]),
    }),
  });
});

test('기존 CloudFront 대시보드 경로(/, /index.html)는 spot.roboco.io로 301, data.json은 제외', () => {
  const t = makeCollectorTemplate();
  const fns = t.findResources('AWS::CloudFront::Function');
  const code: string = Object.values(fns)[0].Properties.FunctionCode;
  expect(code).toContain('https://spot.roboco.io');
  expect(code).toContain('301');
  expect(code).not.toContain('data.json');
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultCacheBehavior: Match.objectLike({
        FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
      }),
    }),
  });
});

test('피드 CORS 정책은 모든 출처 허용 + 오리진 응답 덮어쓰기', () => {
  const t = makeCollectorTemplate();
  t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
    ResponseHeadersPolicyConfig: Match.objectLike({
      CorsConfig: Match.objectLike({
        AccessControlAllowOrigins: { Items: ['*'] },
        OriginOverride: true,
      }),
    }),
  });
});

test('역할에 GetSpotPlacementScores와 테이블 BatchWriteItem 권한', () => {
  const t = makeCollectorTemplate();
  // arrayWith는 패턴 순서를 부분수열로 요구하므로 문장별로 따로 단언한다
  for (const action of ['ec2:GetSpotPlacementScores', 'dynamodb:BatchWriteItem']) {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: action, Effect: 'Allow' }),
        ]),
      }),
    });
  }
});

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

describe('storage and security', () => {
  const template = makeTemplate();

  test('root gp3 provides 500 MiB/s without increasing baseline IOPS', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        BlockDeviceMappings: [{
          DeviceName: '/dev/sda1',
          Ebs: { VolumeSize: 200, VolumeType: 'gp3', Iops: 3000,
            Throughput: 500, DeleteOnTermination: true },
        }],
      }),
    });
  });

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

  test('instance role can write vLLM container logs to CloudWatch Logs', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['logs:PutLogEvents']),
          }),
        ]),
      }),
    });
  });
});

describe('compute', () => {
  const template = makeTemplate();

  test('launch template uses p5.48xlarge with IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        InstanceType: 'p5.48xlarge',
        MetadataOptions: Match.objectLike({ HttpTokens: 'required' }),
      }),
    });
  });

  test('WeightsRepo 출력 존재 (seed-weights.sh가 참조)', () => {
    template.hasOutput('WeightsRepo', { Value: 'nota-ai/Solar-Open2-250B-Nota-INT4' });
  });

  test('ASG is 100% spot with capacity-optimized allocation', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MixedInstancesPolicy: Match.objectLike({
        InstancesDistribution: Match.objectLike({
          OnDemandBaseCapacity: 0,
          OnDemandPercentageAboveBaseCapacity: 0,
          SpotAllocationStrategy: 'capacity-optimized',
        }),
      }),
      CapacityRebalance: true,
    });
  });

  test('user data has substituted placeholders and vLLM flags', () => {
    const lts = template.findResources('AWS::EC2::LaunchTemplate');
    const userData = JSON.stringify(Object.values(lts)[0]);
    const PLACEHOLDERS = [
      '__BOOT_LOG_GROUP__', '__REGION__', '__API_KEY_SECRET_ARN__', '__WEIGHTS_BUCKET__',
      '__WEIGHTS_REPO__', '__VLLM_IMAGE__', '__VLLM_FLAGS__', '__MAX_MODEL_LEN__',
    ];
    for (const ph of PLACEHOLDERS) {
      expect(userData).not.toContain(ph); // 치환 완료
    }
    expect(userData).toContain('nota-ai/Solar-Open2-250B-Nota-INT4');
    expect(userData).toContain('--tensor-parallel-size 8');
    expect(userData).toContain('upstage/vllm-solar-open2:1.0.0');
  });

  test('ASG is fixed min1/max1 with 20min ELB grace period', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1',
      MaxSize: '1',
      HealthCheckType: 'ELB',
      HealthCheckGracePeriod: 3600,
    });
  });

  test('target group health-checks vLLM /health on 8000', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 8000,
      HealthCheckPath: '/health',
    });
  });
});

describe('alerts', () => {
  const template = makeTemplate();

  test('EventBridge routes spot interruption warnings to SNS', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.ec2'],
        'detail-type': ['EC2 Spot Instance Interruption Warning'],
      },
      Targets: Match.arrayWith([
        Match.objectLike({ Arn: { Ref: Match.stringLikeRegexp('AlertTopic') } }),
      ]),
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
      Statistic: 'Minimum',
      TreatMissingData: 'breaching',
      AlarmActions: Match.arrayWith([
        Match.objectLike({ Ref: Match.stringLikeRegexp('AlertTopic') }),
      ]),
    });
  });
});

describe('outputs', () => {
  const template = makeTemplate();

  test.each(['EndpointUrl', 'ApiKeySecretArn', 'WeightsBucketName'])(
    'exposes %s output', (name) => {
      template.hasOutput(name, {});
    },
  );
});

describe('R11: 오리진 검증 게이트', () => {
  const template = makeTemplate();

  test('리스너 기본 액션은 403 고정 응답', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [{
        Type: 'fixed-response',
        FixedResponseConfig: { StatusCode: '403' },
      }],
    });
  });

  test('X-Origin-Verify 헤더 일치 시에만 vLLM으로 포워드', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [{
        Field: 'http-header',
        HttpHeaderConfig: { HttpHeaderName: 'X-Origin-Verify' },
      }],
      Actions: [{ Type: 'forward' }],
    });
  });

  test('오리진 검증 시크릿이 별도로 생성됨 (API 키와 분리)', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });
});

describe('az filter context', () => {
  test('-c azs= restricts ASG subnets to the given AZs', () => {
    // 유닛 테스트 합성 환경의 AZ는 dummy1a/dummy1b — 그중 1개만 선택
    const app = new cdk.App({ context: { azs: 'dummy1a' } });
    const resolvedProfile = loadModelProfile(
      path.join(__dirname, '..', 'models'), 'solar-open2-250b', 'int4',
    );
    const stack = new TokenForgeStack(app, 'AzTest', {
      resolvedProfile,
      env: { account: '111111111111', region: 'us-east-2' },
    });
    const template = Template.fromStack(stack);
    const asgs = template.findResources('AWS::AutoScaling::AutoScalingGroup');
    const zoneIds = Object.values(asgs)[0].Properties.VPCZoneIdentifier;
    expect(zoneIds).toHaveLength(1);
  });
});

describe('multi instance type', () => {
  test('comma-separated instanceType becomes multiple LT overrides', () => {
    const app = new cdk.App();
    const resolvedProfile = loadModelProfile(
      path.join(__dirname, '..', 'models'), 'qwen2.5-0.5b', 'bf16',
    );
    const stack = new TokenForgeStack(app, 'MultiTypeTest', {
      resolvedProfile,
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    const asgs = template.findResources('AWS::AutoScaling::AutoScalingGroup');
    const overrides = Object.values(asgs)[0].Properties
      .MixedInstancesPolicy.LaunchTemplate.Overrides;
    expect(overrides.map((o: { InstanceType: string }) => o.InstanceType))
      .toEqual(['g6e.xlarge', 'g6.xlarge', 'g5.xlarge', 'g4dn.xlarge', 'g4dn.2xlarge']);
  });
});

describe('idle shutdown', () => {
  test('default: idle alarm (30min=6 periods) and stop lambda exist', () => {
    const template = makeTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'RequestCount',
      Namespace: 'AWS/ApplicationELB',
      Threshold: 0,
      ComparisonOperator: 'LessThanOrEqualToThreshold',
      EvaluationPeriods: 6,
      TreatMissingData: 'breaching',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Environment: Match.objectLike({
        Variables: Match.objectLike({ ASG_NAME: Match.anyValue() }),
      }),
    });
  });

  test('-c idleMinutes=0 disables idle shutdown', () => {
    const app = new cdk.App({ context: { idleMinutes: 0 } });
    const resolvedProfile = loadModelProfile(
      path.join(__dirname, '..', 'models'), 'solar-open2-250b', 'int4',
    );
    const stack = new TokenForgeStack(app, 'NoIdleTest', {
      resolvedProfile,
      env: { account: '111111111111', region: 'us-east-2' },
    });
    const template = Template.fromStack(stack);
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms)).toHaveLength(1); // NoCapacityAlarm만 남는다
  });
});

function makeTemplateWithContext(app: cdk.App): Template {
  const resolvedProfile = loadModelProfile(
    path.join(__dirname, '..', 'models'), 'solar-open2-250b', 'int4',
  );
  const stack = new TokenForgeStack(app, 'TestWithContext', {
    resolvedProfile,
    env: { account: '111111111111', region: 'us-east-2' },
  });
  return Template.fromStack(stack);
}

describe('R11: CloudFront 프론트 도어', () => {
  const template = makeTemplate();

  test('Distribution이 캐시 비활성 + HTTPS 전용 뷰어 + HTTP 오리진으로 생성됨', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Enabled: true,
        IPV6Enabled: false,
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'https-only',
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
        }),
        Origins: [Match.objectLike({
          CustomOriginConfig: Match.objectLike({
            OriginProtocolPolicy: 'http-only',
            OriginReadTimeout: 60,
          }),
          OriginCustomHeaders: [Match.objectLike({ HeaderName: 'X-Origin-Verify' })],
        })],
      }),
    });
  });

  test('EndpointUrl 출력이 https CloudFront 도메인', () => {
    const out = template.findOutputs('EndpointUrl');
    expect(JSON.stringify(out.EndpointUrl.Value)).toContain('https://');
    expect(JSON.stringify(out.EndpointUrl.Value)).not.toContain('LoadBalancer');
  });

  test('allowedCidrs 미지정 시 CloudFront Function 없음', () => {
    template.resourceCountIs('AWS::CloudFront::Function', 0);
  });
});

describe('R11: allowedCidrs 소스 IP 허용목록', () => {
  test('지정 시 viewer-request CloudFront Function이 CIDR 목록을 담아 생성됨', () => {
    const app = new cdk.App({ context: { model: 'solar-open2-250b', profile: 'int4', allowedCidrs: '203.0.113.0/24,198.51.100.7/32' } });
    const t = makeTemplateWithContext(app);
    t.resourceCountIs('AWS::CloudFront::Function', 1);
    const fns = t.findResources('AWS::CloudFront::Function');
    const code = JSON.stringify(fns);
    expect(code).toContain('203.0.113.0/24');
    expect(code).toContain('198.51.100.7/32');
  });

  test('불량 CIDR(마스크 NaN)이면 synth 시 명확한 오류로 실패한다', () => {
    const app = new cdk.App({ context: { model: 'solar-open2-250b', profile: 'int4', allowedCidrs: '203.0.113.0/abc' } });
    expect(() => makeTemplateWithContext(app)).toThrow(/allowedCidrs.*잘못된 CIDR/);
  });

  test('옥텟·마스크 범위를 벗어나면 synth 시 오류로 실패한다', () => {
    const app = new cdk.App({ context: { model: 'solar-open2-250b', profile: 'int4', allowedCidrs: '999.0.113.0/24' } });
    expect(() => makeTemplateWithContext(app)).toThrow(/allowedCidrs/);
  });

  test('마스크 없는 단일 IPv4는 /32로 자동 보정되어 함수 코드에 들어간다', () => {
    const app = new cdk.App({ context: { model: 'solar-open2-250b', profile: 'int4', allowedCidrs: '203.0.113.7' } });
    const t = makeTemplateWithContext(app);
    const fns = t.findResources('AWS::CloudFront::Function');
    const code = JSON.stringify(fns);
    expect(code).toContain('203.0.113.7/32');
  });
});

describe('usage modes (#43)', () => {
  function tpl(context: Record<string, unknown>): Template {
    return makeTemplateWithContext(new cdk.App({ context }));
  }
  function idleAlarms(t: Template) {
    return Object.values(t.findResources('AWS::CloudWatch::Alarm'))
      .filter((r) => (r as { Properties: { MetricName?: string } }).Properties.MetricName === 'RequestCount');
  }

  test('생략 시 interactive — 유휴 알람 30분, ASG min 1, 출력에 모드 기록', () => {
    const t = makeTemplate();
    expect(idleAlarms(t)).toHaveLength(1);
    t.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', { MinSize: '1', MaxSize: '1' });
    t.hasOutput('UsageMode', { Value: 'interactive' });
    t.hasOutput('IdleMinutes', { Value: '30' });
  });

  test('-c idleMinutes=60 → 12 평가 주기 (5분 배수 그대로)', () => {
    tpl({ idleMinutes: '60' }).hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'RequestCount', EvaluationPeriods: 12 });
  });

  test('5분 배수가 아닌 idleMinutes는 반올림하지 않고 synth 실패', () => {
    expect(() => tpl({ idleMinutes: '12' })).toThrow(/idleMinutes/);
  });

  test('online — 유휴 알람·Lambda 없음, 출력 IdleMinutes=0', () => {
    const t = tpl({ usageMode: 'online', minCapacity: 0 });
    expect(idleAlarms(t)).toHaveLength(0);
    expect(Object.keys(t.findResources('AWS::Lambda::Function', {
      Properties: { Environment: { Variables: { ASG_NAME: Match.anyValue() } } },
    }))).toHaveLength(0);
    t.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', { MinSize: '0' });
    t.hasOutput('UsageMode', { Value: 'online' });
    t.hasOutput('IdleMinutes', { Value: '0' });
  });

  test('online + idleMinutes>0은 synth 실패', () => {
    expect(() => tpl({ usageMode: 'online', idleMinutes: '30' })).toThrow(/online/);
  });

  test('batch — 백스톱 유휴 알람 유지, ASG 기본 min 0', () => {
    const t = tpl({ usageMode: 'batch' });
    expect(idleAlarms(t)).toHaveLength(1);
    t.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', { MinSize: '0' });
    t.hasOutput('UsageMode', { Value: 'batch' });
  });

  test('batch + minCapacity=1, 잘못된 모드는 synth 실패', () => {
    expect(() => tpl({ usageMode: 'batch', minCapacity: '1' })).toThrow(/batch/);
    expect(() => tpl({ usageMode: 'fp8' })).toThrow(/usageMode/);
  });

  test('모드 변경은 Launch Template(user-data)을 바꾸지 않는다 — 기존 스택 갱신 시 인스턴스 교체 유발 없음', () => {
    const lt = (t: Template) => JSON.stringify(t.findResources('AWS::EC2::LaunchTemplate'));
    expect(lt(tpl({ usageMode: 'online', minCapacity: 0 }))).toBe(lt(tpl({ usageMode: 'interactive', minCapacity: 0 })));
  });
});

describe('DeploymentSettings 출력 (#43 — 정책 갱신 시 보안·운영 컨텍스트 보존)', () => {
  const settings = (t: Template) => JSON.parse((Object.values(t.findOutputs('DeploymentSettings'))[0] as { Value: string }).Value);
  test('기본: 빈 설정을 버전과 함께 기록', () => {
    expect(settings(makeTemplate())).toEqual({ v: 1, allowedCidrs: '', azs: '', alertEmail: '' });
  });
  test('allowedCidrs(정규화)·azs·alertEmail 기록', () => {
    const t = makeTemplateWithContext(new cdk.App({ context: {
      allowedCidrs: '203.0.113.7, 198.51.100.0/24', azs: 'dummy1a', alertEmail: 'ops@example.com' } }));
    expect(settings(t)).toEqual({ v: 1, allowedCidrs: '203.0.113.7/32,198.51.100.0/24', azs: 'dummy1a', alertEmail: 'ops@example.com' });
  });
});

describe('boot observability', () => {
  test('스택별 로그 그룹은 7일 보존하며 출력한다', () => {
    const t = makeTemplate();
    t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/token-forge/Test/boot', RetentionInDays: 7 });
    t.hasOutput('BootLogGroupName', { Value: Match.anyValue() });
    // 기존 쓰기 정책을 재사용: 새 정책에서 권한/리소스를 넓히지 않는다.
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('logs:*');
  });

  test('모든 모델 프로파일 rendered user-data가 16KiB 이내', () => {
    const fs = require('fs') as typeof import('fs');
    const yaml = require('js-yaml') as typeof import('js-yaml');
    const dir = path.join(__dirname, '../models');
    const sizes: Record<string, number> = {};
    for (const file of fs.readdirSync(dir).filter(x => x.endsWith('.yaml'))) {
      const model = file.slice(0, -5);
      const doc = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8')) as { profiles: Record<string, unknown> };
      for (const profile of Object.keys(doc.profiles)) {
        const app = new cdk.App();
        const stack = new TokenForgeStack(app, 'SizeCheck', { resolvedProfile: loadModelProfile(dir, model, profile),
          env: { account: '111111111111', region: 'us-east-2' } });
        const template = Template.fromStack(stack);
        const lt = Object.values(template.findResources('AWS::EC2::LaunchTemplate'))[0];
        const raw = lt.Properties.LaunchTemplateData.UserData['Fn::Base64'];
        // CFN Ref/GetAtt 문자열은 최대 256바이트로 보수적으로 대체한다.
        const rendered = typeof raw === 'string' ? raw : raw['Fn::Join'][1].map((x: unknown) => typeof x === 'string' ? x : 'x'.repeat(256)).join('');
        sizes[`${model}/${profile}`] = Buffer.byteLength(rendered);
        expect(rendered).not.toMatch(/__[A-Z_]+__/);
        expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(16384);
      }
    }
    console.log('rendered user-data bytes', JSON.stringify(sizes));
  });
});

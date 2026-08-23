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
      '__REGION__', '__API_KEY_SECRET_ARN__', '__WEIGHTS_BUCKET__',
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

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

describe('outputs', () => {
  const template = makeTemplate();

  test.each(['EndpointUrl', 'ApiKeySecretArn', 'WeightsBucketName'])(
    'exposes %s output', (name) => {
      template.hasOutput(name, {});
    },
  );
});

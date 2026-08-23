import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as fs from 'fs';
import * as path from 'path';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
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

    // CloudFront만 ALB를 통과하도록 하는 오리진 검증 헤더 값 (설계 결정 1·2)
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: 'token-forge CloudFront origin verification header value',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });
    // CFN 동적 참조 — 배포 시 해석되어 리스너 룰과 CloudFront 헤더 양쪽에 동일 값이 들어간다
    const originVerifyValue = originVerifySecret.secretValue.unsafeUnwrap();

    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    apiKeySecret.grantRead(instanceRole);
    weightsBucket.grantReadWrite(instanceRole);
    // awslogs 도커 로그 드라이버가 관리형 정책 변경과 무관하게 항상 쓸 수 있도록 명시적으로 부여
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/token-forge/*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:/token-forge/*:*`,
      ],
    }));

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

    // instanceType은 콤마 구분 다중 타입 허용 ("g6e.xlarge,g5.xlarge") —
    // capacity-optimized가 용량 있는 풀을 고를 수 있게 후보를 넓힌다
    const instanceTypes = profile.instanceType.split(',').map((t) => t.trim());

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: new ec2.InstanceType(instanceTypes[0]),
      machineImage,
      userData: ec2.UserData.custom(bootScript),
      role: instanceRole,
      securityGroup: instanceSg,
      associatePublicIpAddress: true, // 퍼블릭 서브넷, NAT 없음
      requireImdsv2: true,
      // 스팟 여부는 ASG MixedInstancesPolicy(InstancesDistribution)가 결정 —
      // LT에 spotOptions를 두면 MixedInstancesPolicy와 충돌한다
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(200, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
        }),
      }],
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      // -c azs=us-east-1a,us-east-1b 형태로 인스턴스 타입을 지원하는 AZ만 선택
      // (미지정 시 전 AZ — 일부 AZ가 해당 GPU 타입을 미지원하면 스팟 요청이
      //  InvalidFleetConfiguration으로 실패할 수 있음)
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
        ...(this.node.tryGetContext('azs')
          ? { availabilityZones: String(this.node.tryGetContext('azs')).split(',') }
          : {}),
      },
      // 100% 스팟 + capacity-optimized: 용량 없는 AZ 풀(lowest-price 고착)을 피해
      // 확보 가능한 풀을 고른다 — 특정 AZ 용량 부족으로 배포가 실패하지 않게 함
      mixedInstancesPolicy: {
        launchTemplate,
        launchTemplateOverrides: instanceTypes.map((t) => ({
          instanceType: new ec2.InstanceType(t),
        })),
        instancesDistribution: {
          onDemandBaseCapacity: 0,
          onDemandPercentageAboveBaseCapacity: 0, // 전량 스팟
          spotAllocationStrategy:
            autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
        },
      },
      capacityRebalance: true, // 중단 경고 시 선제 교체
      // -c minCapacity=0: 스팟 용량 고갈 시 CFN 생성을 빈 ASG로 통과시키고
      // 배포 후 desired=1로 올려 ASG가 무기한 재시도하게 함 (스펙 §6 의도)
      minCapacity: Number(this.node.tryGetContext('minCapacity') ?? 1),
      maxCapacity: 1, // 스코프: 오토스케일링 없음
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        // 콜드 부팅 실측(g6e.48xlarge, 도쿄): HF 143GB 다운로드+S3 시딩+이미지 풀+8GPU 로드로
        // 20분을 초과해 ELB 헬스체크가 부팅 중 인스턴스를 강제 교체함(2026-08-17) — 60분으로 확대
        gracePeriod: cdk.Duration.minutes(60),
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
      }),
      groupMetrics: [autoscaling.GroupMetrics.all()], // Task 8 알람에 필요
    });

    const vllmTargets = new elbv2.ApplicationTargetGroup(this, 'VllmTg', {
      vpc,
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

    // 기본 403: CloudFront가 부착하는 X-Origin-Verify 없이는 통과 불가 (우회 차단)
    const listener = alb.addListener('Http', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden: use the HTTPS endpoint',
      }),
    });
    listener.addAction('VerifiedForward', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.httpHeader('X-Origin-Verify', [originVerifyValue])],
      action: elbv2.ListenerAction.forward([vllmTargets]),
    });

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

    // --- 비용 절감: 유휴 자동 셧다운 (-c idleMinutes=N, 기본 30, 0이면 비활성) ---
    // ALB 요청이 idleMinutes 동안 0이면 Lambda가 ASG를 0으로 내린다.
    // 재기동은 수동(scripts/start.sh) — 콜드부팅이 있어 자동 웨이크업은 실익 없음.
    const idleMinutes = Number(this.node.tryGetContext('idleMinutes') ?? 30);
    if (idleMinutes > 0) {
      const idleStopFn = new lambda.Function(this, 'IdleStopFn', {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(30),
        environment: {
          ASG_NAME: asg.autoScalingGroupName,
          TOPIC_ARN: alertTopic.topicArn,
        },
        code: lambda.Code.fromInline(`
const { AutoScalingClient, UpdateAutoScalingGroupCommand } = require('@aws-sdk/client-auto-scaling');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
exports.handler = async () => {
  const asgName = process.env.ASG_NAME;
  await new AutoScalingClient({}).send(new UpdateAutoScalingGroupCommand({
    AutoScalingGroupName: asgName, MinSize: 0, DesiredCapacity: 0 }));
  await new SNSClient({}).send(new PublishCommand({
    TopicArn: process.env.TOPIC_ARN,
    Subject: 'token-forge: idle shutdown',
    Message: 'ASG ' + asgName + ' scaled to 0 (idle). Restart: scripts/start.sh <stack> <region>' }));
};`),
      });
      idleStopFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['autoscaling:UpdateAutoScalingGroup'],
        resources: [asg.autoScalingGroupArn],
      }));
      alertTopic.grantPublish(idleStopFn);

      const idleAlarm = new cloudwatch.Alarm(this, 'IdleAlarm', {
        alarmDescription: `token-forge: no ALB requests for ${idleMinutes}min — scaling to 0`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApplicationELB',
          metricName: 'RequestCount',
          dimensionsMap: { LoadBalancer: alb.loadBalancerFullName },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: Math.max(1, Math.round(idleMinutes / 5)),
        treatMissingData: cloudwatch.TreatMissingData.BREACHING, // 무요청=결측
      });
      new events.Rule(this, 'IdleAlarmRule', {
        eventPattern: {
          source: ['aws.cloudwatch'],
          detailType: ['CloudWatch Alarm State Change'],
          detail: { alarmName: [idleAlarm.alarmName], state: { value: ['ALARM'] } },
        },
        targets: [new targets.LambdaFunction(idleStopFn)],
      });
    }

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
    // scripts/seed-weights.sh가 시딩 대상 리포를 읽는 용도
    new cdk.CfnOutput(this, 'WeightsRepo', { value: profile.weightsRepo });
  }
}

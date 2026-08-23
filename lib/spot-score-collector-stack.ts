import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

const INSTANCE_TYPES = 'p5.48xlarge,g6e.48xlarge,g6e.24xlarge,g6e.12xlarge';
const REGIONS = 'us-east-1,us-east-2,us-west-2,ap-northeast-1,ap-northeast-2';

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
        INSTANCE_TYPES,
        REGIONS,
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
  let calls = 0;
  // 타입을 한 호출에 섞으면 "아무 타입이나" 기준의 합산 점수가 되므로 타입별로 분리 조회한다.
  // scope 키에 타입을 접두해 (scope, ts) 충돌을 막는다.
  for (const type of instanceTypes) {
    // single=false: 리전 단위 점수, single=true: AZ 단위 점수
    for (const single of [false, true]) {
      calls += 1;
      try {
        const out = await ec2.send(new GetSpotPlacementScoresCommand({
          InstanceTypes: [type],
          TargetCapacity: 1,
          RegionNames: regions,
          SingleAvailabilityZone: single,
        }));
        for (const s of out.SpotPlacementScores ?? []) {
          const scope = type + '#' + (single ? 'az#' + s.AvailabilityZoneId : 'region#' + s.Region);
          items.push({ PutRequest: { Item: {
            scope: { S: scope },
            ts: { S: ts },
            score: { N: String(s.Score) },
            instanceType: { S: type },
            expireAt: { N: String(expireAt) },
          } } });
        }
      } catch (e) {
        failures += 1;
        console.error('GetSpotPlacementScores failed (type=' + type + ', single=' + single + '):', e);
      }
    }
  }
  if (failures === calls) throw new Error('all placement score calls failed');
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

    const hourly = new events.Rule(this, 'HourlyRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(collectorFn)],
    });

    // --- 실시간 대시보드: S3 정적 호스팅 + 시간당 data.json 게시 ---
    const dashBucket = new s3.Bucket(this, 'DashboardBucket', {
      websiteIndexDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, 'DashboardHtml', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'assets', 'dashboard'))],
      destinationBucket: dashBucket,
      prune: false, // 퍼블리셔가 쓰는 data.json을 지우지 않도록
      cacheControl: [s3deploy.CacheControl.maxAge(cdk.Duration.minutes(5))],
    });

    // HTTPS 공개 제공용 CloudFront — S3 website 엔드포인트를 커스텀 오리진으로 사용
    // (website 엔드포인트는 OAC 미지원이라 버킷은 퍼블릭 유지, 오리진 프로토콜은 HTTP 고정)
    const dashCachePolicy = new cloudfront.CachePolicy(this, 'DashboardCachePolicy', {
      defaultTtl: cdk.Duration.minutes(5), // 오리진 Cache-Control 없을 때(예: index.html 직접 업로드분)
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.hours(1),
    });
    const dashCdn = new cloudfront.Distribution(this, 'DashboardCdn', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(dashBucket.bucketWebsiteDomainName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: dashCachePolicy,
        // data.json을 타 오리진에서 fetch로 쓸 수 있게 CORS 허용 (오픈 데이터 피드)
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
      },
      comment: 'token-forge spot dashboard + data feed',
    });

    const publisherFn = new lambda.Function(this, 'PublisherFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'assets', 'dashboard-publisher')),
      environment: {
        TABLE_NAME: table.tableName,
        DASHBOARD_BUCKET: dashBucket.bucketName,
        INSTANCE_TYPES,
        REGIONS,
      },
    });
    table.grantReadData(publisherFn);
    dashBucket.grantPut(publisherFn);
    publisherFn.addToRolePolicy(new iam.PolicyStatement({
      // 두 API 모두 리소스 수준 권한 미지원
      actions: ['ec2:DescribeSpotPriceHistory', 'ec2:DescribeAvailabilityZones'],
      resources: ['*'],
    }));
    hourly.addTarget(new targets.LambdaFunction(publisherFn));

    new cdk.CfnOutput(this, 'ScoresTableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'DashboardUrl', { value: dashBucket.bucketWebsiteUrl });
    new cdk.CfnOutput(this, 'DashboardCdnUrl', { value: 'https://' + dashCdn.distributionDomainName });
  }
}

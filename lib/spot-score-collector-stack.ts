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
import { COLLECT_TARGETS, validateTargets } from './spot-collector-targets';

const REGIONS = 'us-east-1,us-east-2,us-west-2,ap-northeast-1,ap-northeast-2';
// 대시보드 페이지 공개 주소 (GitHub Pages — .github/workflows/dashboard-pages.yml)
const DASHBOARD_URL = 'https://spot.roboco.io';

/**
 * 스팟 배치 점수 수집기 — 서빙 스택과 독립적으로 상시 가동되는 별도 스택.
 * 1시간마다 GetSpotPlacementScores(리전·AZ 단위)를 조회해 DynamoDB에 적재한다.
 * 수집 대상은 lib/spot-collector-targets.ts의 COLLECT_TARGETS가 기준이다.
 * 설계: docs/superpowers/specs/2026-08-06-spot-score-collector-design.md
 */
export class SpotScoreCollectorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    validateTargets(COLLECT_TARGETS);

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
      // 대상당 2회(리전·AZ 단위) 순차 조회 — 대상이 늘어도 여유가 있도록 120초
      timeout: cdk.Duration.seconds(120),
      environment: {
        TABLE_NAME: table.tableName,
        TARGETS: JSON.stringify(COLLECT_TARGETS.map(t => ({ id: t.id, types: t.instanceTypes }))),
        REGIONS,
        TTL_DAYS: '90',
      },
      code: lambda.Code.fromInline(`
const { EC2Client, GetSpotPlacementScoresCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
const ec2 = new EC2Client();
const ddb = new DynamoDBClient();

exports.handler = async () => {
  const targets = JSON.parse(process.env.TARGETS);
  const regions = process.env.REGIONS.split(',');
  const ttlDays = parseInt(process.env.TTL_DAYS || '90', 10);
  const now = new Date();
  const ts = now.toISOString().slice(0, 19) + 'Z';
  const expireAt = Math.floor(now.getTime() / 1000) + ttlDays * 86400;

  const items = [];
  let failures = 0;
  let calls = 0;
  // 대상(target)별로 분리 조회한다. GPU 대상은 타입 1개, 그 외는 같은 크기 3개 묶음이며
  // 묶음의 점수는 "묶음 중 아무 타입이나" 기준이다 (lib/spot-collector-targets.ts 참고).
  // scope 키에 대상 id를 접두해 (scope, ts) 충돌을 막는다.
  for (const target of targets) {
    const type = target.id;
    // single=false: 리전 단위 점수, single=true: AZ 단위 점수
    for (const single of [false, true]) {
      calls += 1;
      try {
        // 기본 응답은 상위 10건뿐이라 AZ 단위 조회에서 점수가 낮은 AZ가 빠진다 — 끝까지 페이지를 넘긴다
        let token;
        do {
          const out = await ec2.send(new GetSpotPlacementScoresCommand({
            InstanceTypes: target.types,
            TargetCapacity: 1,
            RegionNames: regions,
            SingleAvailabilityZone: single,
            MaxResults: 100,
            NextToken: token,
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
          token = out.NextToken;
        } while (token);
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
      // data.json은 수 MB의 JSON이라 압축 전송한다 (대상 4개일 때 1.57MB → gzip 약 0.11MB, 2026-11-18 실측).
      // 캐시 정책에서 Accept-Encoding을 켜야 CloudFront가 압축본을 만들어 캐시한다.
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    // 대시보드 페이지는 GitHub Pages(DASHBOARD_URL)로 이전 — 기존 CloudFront URL의 페이지 경로만
    // 301로 넘기고, data.json 등 나머지(구버전 CLI feedUrl 포함)는 그대로 S3에서 제공한다
    const dashRedirectFn = new cloudfront.Function(this, 'DashboardRedirectFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var uri = event.request.uri;
  if (uri === '/' || uri === '/index.html') {
    return { statusCode: 301, statusDescription: 'Moved Permanently',
      headers: { location: { value: '${DASHBOARD_URL}' } } };
  }
  return event.request;
}`),
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
        functionAssociations: [
          { function: dashRedirectFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      comment: 'token-forge spot dashboard + data feed',
    });

    const publisherFn = new lambda.Function(this, 'PublisherFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      // 대상 수에 비례해 스캔할 점수 항목과 가격 기록이 늘어난다 — Lambda 상한(15분)과 1 GiB로 여유를 둔다
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'assets', 'dashboard-publisher')),
      environment: {
        TABLE_NAME: table.tableName,
        DASHBOARD_BUCKET: dashBucket.bucketName,
        TARGETS: JSON.stringify(COLLECT_TARGETS.map(t => ({
          id: t.id, family: t.family, arch: t.arch, spec: t.spec, gpu: t.gpu, types: t.instanceTypes,
        }))),
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
    new cdk.CfnOutput(this, 'DashboardPagesUrl', { value: DASHBOARD_URL });
  }
}

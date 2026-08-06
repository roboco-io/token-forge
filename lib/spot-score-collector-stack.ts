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

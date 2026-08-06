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

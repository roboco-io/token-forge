#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { loadModelProfile } from '../lib/model-profile';
import { stackNameFor } from '../lib/naming';
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

  const stackName = stackNameFor(model, profileName);

  new TokenForgeStack(app, stackName, {
    resolvedProfile,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  });
}

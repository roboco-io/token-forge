#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { loadModelProfile } from '../lib/model-profile';
import { TokenForgeStack } from '../lib/token-forge-stack';

const app = new cdk.App();
const model = app.node.tryGetContext('model') ?? 'solar-open2-250b';
const profileName = app.node.tryGetContext('profile') ?? 'int4';
const region = app.node.tryGetContext('region') ?? 'us-east-2';

const resolvedProfile = loadModelProfile(
  path.join(__dirname, '..', 'models'), model, profileName,
);

// CloudFormation 스택 이름 제약(/^[A-Za-z][A-Za-z0-9-]*$/)에 맞게 정규화
const stackName = `TokenForge-${model}-${profileName}`.replace(/[^A-Za-z0-9-]/g, '-');

new TokenForgeStack(app, stackName, {
  resolvedProfile,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});

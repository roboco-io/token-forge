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

new TokenForgeStack(app, `TokenForge-${model}-${profileName}`, {
  resolvedProfile,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});

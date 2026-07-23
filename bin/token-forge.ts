#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TokenForgeStack } from '../lib/token-forge-stack';

const app = new cdk.App();
new TokenForgeStack(app, 'TokenForge');

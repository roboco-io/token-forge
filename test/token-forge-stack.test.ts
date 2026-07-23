import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { TokenForgeStack } from '../lib/token-forge-stack';

test('stack synthesizes', () => {
  const app = new cdk.App();
  const stack = new TokenForgeStack(app, 'Test');
  expect(Template.fromStack(stack).toJSON()).toBeDefined();
});

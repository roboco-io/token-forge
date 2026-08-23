import { mockClient } from 'aws-sdk-client-mock';
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { AutoScalingClient, SetDesiredCapacityCommand, UpdateAutoScalingGroupCommand, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { AwsApi } from '../cli/aws';

const cfnMock = mockClient(CloudFormationClient);
const asgMock = mockClient(AutoScalingClient);
const ec2Mock = mockClient(EC2Client);
const smMock = mockClient(SecretsManagerClient);
const s3Mock = mockClient(S3Client);
beforeEach(() => { cfnMock.reset(); asgMock.reset(); ec2Mock.reset(); smMock.reset(); s3Mock.reset(); });

test('getStackOutputs — 스택 출력 맵 반환, 미존재 시 null', async () => {
  cfnMock.on(DescribeStacksCommand, { StackName: 'S1' }).resolves({
    Stacks: [{ StackName: 'S1', CreationTime: new Date(), StackStatus: 'CREATE_COMPLETE',
      Outputs: [{ OutputKey: 'EndpointUrl', OutputValue: 'http://alb' }] }],
  });
  cfnMock.on(DescribeStacksCommand, { StackName: 'NOPE' })
    .rejects(new Error('Stack with id NOPE does not exist'));
  const api = new AwsApi('ap-northeast-2');
  expect(await api.getStackOutputs('S1')).toEqual({ EndpointUrl: 'http://alb' });
  expect(await api.getStackOutputs('NOPE')).toBeNull();
});

test('setDesired(0)은 MinSize도 0으로 내린다', async () => {
  asgMock.on(UpdateAutoScalingGroupCommand).resolves({});
  asgMock.on(SetDesiredCapacityCommand).resolves({});
  const api = new AwsApi('ap-northeast-2');
  await api.setDesired('my-asg', 0);
  expect(asgMock.commandCalls(UpdateAutoScalingGroupCommand)[0].args[0].input)
    .toMatchObject({ AutoScalingGroupName: 'my-asg', MinSize: 0, DesiredCapacity: 0 });
});

test('getAsgName — 스택 리소스에서 ASG PhysicalResourceId 반환', async () => {
  cfnMock.on(ListStackResourcesCommand, { StackName: 'S1' }).resolves({
    StackResourceSummaries: [
      { LogicalResourceId: 'ASG', ResourceType: 'AWS::AutoScaling::AutoScalingGroup', PhysicalResourceId: 'asg-xyz', ResourceStatus: 'CREATE_COMPLETE', LastUpdatedTimestamp: new Date() } as any,
    ],
  });
  const api = new AwsApi('ap-northeast-2');
  expect(await api.getAsgName('S1')).toBe('asg-xyz');
});

test('getAsgStatus — desired와 instanceIds 반환', async () => {
  asgMock.on(DescribeAutoScalingGroupsCommand, { AutoScalingGroupNames: ['asg-xyz'] }).resolves({
    AutoScalingGroups: [{
      AutoScalingGroupName: 'asg-xyz',
      DesiredCapacity: 2,
      Instances: [
        { InstanceId: 'i-001', AvailabilityZone: 'ap-ne-2a', LifecycleState: 'InService', HealthStatus: 'Healthy', ProtectedFromScaleIn: false } as any,
        { InstanceId: 'i-002', AvailabilityZone: 'ap-ne-2a', LifecycleState: 'InService', HealthStatus: 'Healthy', ProtectedFromScaleIn: false } as any,
      ],
    } as any],
  });
  const api = new AwsApi('ap-northeast-2');
  expect(await api.getAsgStatus('asg-xyz')).toEqual({
    desired: 2,
    instanceIds: ['i-001', 'i-002'],
  });
});

test('getInstanceType — EC2 인스턴스 타입 반환', async () => {
  ec2Mock.on(DescribeInstancesCommand, { InstanceIds: ['i-001'] }).resolves({
    Reservations: [{ Instances: [{ InstanceType: 'g6e.xlarge' }] }],
  });
  const api = new AwsApi('ap-northeast-2');
  expect(await api.getInstanceType('i-001')).toBe('g6e.xlarge');
});

test('getSecret — Secrets Manager 시크릿 문자열 반환', async () => {
  smMock.on(GetSecretValueCommand, { SecretId: 'arn:aws:secretsmanager:...' }).resolves({
    SecretString: 'my-secret-value',
  });
  const api = new AwsApi('ap-northeast-2');
  expect(await api.getSecret('arn:aws:secretsmanager:...')).toBe('my-secret-value');
});

test('emptyAndDeleteBucket — 2페이지 삭제 후 DeleteBucket 호출', async () => {
  s3Mock.on(ListObjectsV2Command, { Bucket: 'my-bucket' })
    .resolvesOnce({ Contents: [{ Key: 'a' }, { Key: 'b' }], IsTruncated: true })
    .resolvesOnce({ Contents: [{ Key: 'c' }], IsTruncated: false });
  s3Mock.on(DeleteObjectsCommand).resolves({});
  s3Mock.on(DeleteBucketCommand).resolves({});
  const api = new AwsApi('ap-northeast-2');
  await api.emptyAndDeleteBucket('my-bucket');
  const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
  expect(deleteCalls).toHaveLength(2);
  expect(deleteCalls[0].args[0].input.Delete?.Objects?.map((o) => o.Key)).toEqual(['a', 'b']);
  expect(deleteCalls[1].args[0].input.Delete?.Objects?.map((o) => o.Key)).toEqual(['c']);
  expect(s3Mock.commandCalls(DeleteBucketCommand)).toHaveLength(1);
});

test('emptyAndDeleteBucket — DeleteErrors 있으면 throw', async () => {
  s3Mock.on(ListObjectsV2Command).resolves({
    Contents: [{ Key: 'locked' }],
    IsTruncated: false,
  });
  s3Mock.on(DeleteObjectsCommand).resolves({
    Errors: [{ Key: 'locked', Code: 'AccessDenied', Message: 'Access Denied' }],
  });
  const api = new AwsApi('ap-northeast-2');
  await expect(api.emptyAndDeleteBucket('my-bucket')).rejects.toThrow(/버킷.*삭제 실패.*locked.*AccessDenied/);
});

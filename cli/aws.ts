import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { AutoScalingClient, SetDesiredCapacityCommand, UpdateAutoScalingGroupCommand, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';

export class AwsApi {
  private cfn: CloudFormationClient;
  private asg: AutoScalingClient;
  private ec2: EC2Client;
  private sm: SecretsManagerClient;
  private s3: S3Client;

  constructor(region: string) {
    this.cfn = new CloudFormationClient({ region });
    this.asg = new AutoScalingClient({ region });
    this.ec2 = new EC2Client({ region });
    this.sm = new SecretsManagerClient({ region });
    this.s3 = new S3Client({ region });
  }

  async getStackOutputs(stackName: string): Promise<Record<string, string> | null> {
    try {
      const out = await this.cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const outputs: Record<string, string> = {};
      for (const o of out.Stacks?.[0]?.Outputs ?? []) outputs[o.OutputKey!] = o.OutputValue!;
      return outputs;
    } catch (e) {
      if (e instanceof Error && e.message.includes('does not exist')) return null;
      throw e;
    }
  }

  async getAsgName(stackName: string): Promise<string> {
    const out = await this.cfn.send(new ListStackResourcesCommand({ StackName: stackName }));
    const asg = out.StackResourceSummaries?.find(
      (r) => r.ResourceType === 'AWS::AutoScaling::AutoScalingGroup');
    if (!asg?.PhysicalResourceId) throw new Error(`스택 ${stackName}에서 ASG를 찾을 수 없습니다`);
    return asg.PhysicalResourceId;
  }

  async setDesired(asgName: string, n: number): Promise<void> {
    if (n === 0) {
      await this.asg.send(new UpdateAutoScalingGroupCommand(
        { AutoScalingGroupName: asgName, MinSize: 0, DesiredCapacity: 0 }));
    } else {
      await this.asg.send(new SetDesiredCapacityCommand(
        { AutoScalingGroupName: asgName, DesiredCapacity: n }));
    }
  }

  async getAsgStatus(asgName: string): Promise<{ desired: number; instanceIds: string[] }> {
    const out = await this.asg.send(new DescribeAutoScalingGroupsCommand(
      { AutoScalingGroupNames: [asgName] }));
    const g = out.AutoScalingGroups?.[0];
    if (!g) throw new Error(`ASG ${asgName} 없음`);
    return { desired: g.DesiredCapacity ?? 0, instanceIds: (g.Instances ?? []).map((i) => i.InstanceId!) };
  }

  async getInstanceType(instanceId: string): Promise<string> {
    const out = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    return out.Reservations?.[0]?.Instances?.[0]?.InstanceType ?? 'unknown';
  }

  async getSecret(arn: string): Promise<string> {
    const out = await this.sm.send(new GetSecretValueCommand({ SecretId: arn }));
    return out.SecretString!;
  }

  async emptyAndDeleteBucket(bucket: string): Promise<void> {
    for (;;) {
      const list = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length === 0) break;
      await this.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      if (!list.IsTruncated) break;
    }
    await this.s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
}

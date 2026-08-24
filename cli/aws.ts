import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { AutoScalingClient, SetDesiredCapacityCommand, UpdateAutoScalingGroupCommand, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { EC2Client, DescribeInstancesCommand, DescribeInstanceTypesCommand, DescribeSpotPriceHistoryCommand, GetSpotPlacementScoresCommand } from '@aws-sdk/client-ec2';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ServiceQuotasClient, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';

export class AwsApi {
  private cfn: CloudFormationClient;
  private asg: AutoScalingClient;
  private ec2: EC2Client;
  private sm: SecretsManagerClient;
  private s3: S3Client;
  private sq: ServiceQuotasClient;

  constructor(region: string) {
    this.cfn = new CloudFormationClient({ region });
    this.asg = new AutoScalingClient({ region });
    this.ec2 = new EC2Client({ region });
    this.sm = new SecretsManagerClient({ region });
    this.s3 = new S3Client({ region });
    this.sq = new ServiceQuotasClient({ region });
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

  async getAsgStatus(asgName: string): Promise<{ desired: number; instanceIds: string[]; inServiceIds: string[] }> {
    const out = await this.asg.send(new DescribeAutoScalingGroupsCommand(
      { AutoScalingGroupNames: [asgName] }));
    const g = out.AutoScalingGroups?.[0];
    if (!g) throw new Error(`ASG ${asgName} 없음`);
    const instances = g.Instances ?? [];
    return {
      desired: g.DesiredCapacity ?? 0,
      instanceIds: instances.map((i) => i.InstanceId!),
      inServiceIds: instances.filter((i) => i.LifecycleState === 'InService').map((i) => i.InstanceId!),
    };
  }

  async getInstanceType(instanceId: string): Promise<string> {
    const out = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    return out.Reservations?.[0]?.Instances?.[0]?.InstanceType ?? 'unknown';
  }

  async getSecret(arn: string): Promise<string> {
    const out = await this.sm.send(new GetSecretValueCommand({ SecretId: arn }));
    return out.SecretString!;
  }

  async putSecret(arn: string, value: string): Promise<void> {
    await this.sm.send(new PutSecretValueCommand({ SecretId: arn, SecretString: value }));
  }

  async emptyAndDeleteBucket(bucket: string): Promise<void> {
    for (;;) {
      const list = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length === 0) break;
      const result = await this.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      if ((result.Errors ?? []).length > 0) {
        const errors = result.Errors!.map((e) => `${e.Key}: ${e.Code}`).join(', ');
        throw new Error(`버킷 ${bucket} 객체 삭제 실패: ${errors}`);
      }
      if (!list.IsTruncated) break;
    }
    await this.s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  }

  async headObject(bucket: string, key: string): Promise<boolean> {
    try { await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
    catch (e) { if ((e as Error).name === 'NotFound' || (e as Error).name === '404') return false; throw e; }
  }

  /** 스팟 vCPU 쿼터 — G·VT: L-3819A6DF, P: L-7212CCBC (스펙 R10 파생 입력) */
  async getSpotVcpuQuota(family: 'g' | 'p'): Promise<number> {
    const code = family === 'p' ? 'L-7212CCBC' : 'L-3819A6DF';
    const out = await this.sq.send(new GetServiceQuotaCommand({ ServiceCode: 'ec2', QuotaCode: code }));
    return out.Quota?.Value ?? 0;
  }

  async getVcpuCount(instanceType: string): Promise<number> {
    const out = await this.ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as never] }));
    const v = out.InstanceTypes?.[0]?.VCpuInfo?.DefaultVCpus;
    if (!v) throw new Error(`인스턴스 타입 정보 없음: ${instanceType}`);
    return v;
  }

  async getCurrentSpotPrice(instanceType: string): Promise<number | null> {
    const out = await this.ec2.send(new DescribeSpotPriceHistoryCommand({
      InstanceTypes: [instanceType as never], ProductDescriptions: ['Linux/UNIX'], MaxResults: 20,
    }));
    const prices = (out.SpotPriceHistory ?? []).map((h) => Number(h.SpotPrice)).filter((n) => !Number.isNaN(n));
    return prices.length ? Math.min(...prices) : null;
  }

  /** 피드 미커버 리전의 실시간 폴백 (스펙 R10 실패 경로 ①) */
  async getPlacementScore(instanceTypes: string[], region: string): Promise<number | null> {
    const out = await this.ec2.send(new GetSpotPlacementScoresCommand({
      InstanceTypes: instanceTypes as never, TargetCapacity: 1,
      SingleAvailabilityZone: false, RegionNames: [region],
    }));
    const hit = (out.SpotPlacementScores ?? []).find((s) => s.Region === region);
    return hit?.Score ?? null;
  }
}

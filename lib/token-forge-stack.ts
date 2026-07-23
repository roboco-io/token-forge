import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { ResolvedProfile } from './model-profile';

export interface TokenForgeStackProps extends cdk.StackProps {
  resolvedProfile: ResolvedProfile;
}

export class TokenForgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TokenForgeStackProps) {
    super(scope, id, props);
    const profile = props.resolvedProfile;

    // --- 네트워크: 퍼블릭 서브넷 전 AZ (스팟 확보율 극대화), NAT 불필요 ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 99,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'token-forge ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'public HTTP');

    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'token-forge instance',
      allowAllOutbound: true,
    });
    instanceSg.addIngressRule(albSg, ec2.Port.tcp(8000), 'vLLM from ALB only');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      idleTimeout: cdk.Duration.seconds(300), // 긴 생성 응답 대비
    });

    // 이후 태스크에서 사용 (컴파일러 경고 방지용 임시 참조 — Task 7에서 제거)
    void alb;
    void instanceSg;
    void profile;
  }
}

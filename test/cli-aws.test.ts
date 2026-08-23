import { mockClient } from 'aws-sdk-client-mock';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { AutoScalingClient, SetDesiredCapacityCommand, UpdateAutoScalingGroupCommand } from '@aws-sdk/client-auto-scaling';
import { AwsApi } from '../cli/aws';

const cfnMock = mockClient(CloudFormationClient);
const asgMock = mockClient(AutoScalingClient);
beforeEach(() => { cfnMock.reset(); asgMock.reset(); });

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

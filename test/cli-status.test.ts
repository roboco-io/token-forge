import { runStatus } from '../cli/commands/status';

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec' }),
    getAsgName: async () => 'asg-1',
    getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-123'] }),
    getInstanceType: async () => 'g6e.12xlarge',
    ...overrides,
  } as never;
}
const state = { model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' };

test('가동 중이면 인스턴스 타입과 READY 표시', async () => {
  const lines = await runStatus({ api: fakeApi(), state, probe: async () => 200 });
  expect(lines.join('\n')).toContain('g6e.12xlarge');
  expect(lines.join('\n')).toContain('READY');
});

test('스택 없으면 안내', async () => {
  const lines = await runStatus({ api: fakeApi({ getStackOutputs: async () => null }), state, probe: async () => 0 });
  expect(lines.join('\n')).toContain('스택 없음');
});

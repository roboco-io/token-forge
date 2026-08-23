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

test('무인증 프로브가 401이어도 READY로 표시 (vLLM --api-key 기동 시 정상 응답)', async () => {
  const lines = await runStatus({ api: fakeApi(), state, probe: async () => 401 });
  expect(lines.join('\n')).toContain('READY');
});

test('프로브가 403이면 차단됨(allowedCidrs)으로 표시하고 READY/부팅 중과 구분한다', async () => {
  const lines = await runStatus({ api: fakeApi(), state, probe: async () => 403 });
  expect(lines.join('\n')).toContain('차단됨');
  expect(lines.join('\n')).toContain('allowedCidrs');
  expect(lines.join('\n')).not.toContain('READY');
});

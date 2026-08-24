import { runRotateKey } from '../cli/commands/rotate';

function makeDeps(desired: number, instanceIds: string[]) {
  const puts: [string, string][] = [];
  const logs: string[] = [];
  const deps = {
    api: {
      getStackOutputs: async () => ({ ApiKeySecretArn: 'arn:key', EndpointUrl: 'https://x' }),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => ({ desired, instanceIds, inServiceIds: instanceIds }),
      putSecret: async (arn: string, v: string) => { puts.push([arn, v]); },
    },
    genKey: () => 'NEWKEY48',
    log: (m: string) => { logs.push(m); },
  };
  return { deps, puts, logs };
}
const STATE = { model: 'm', profile: 'p', region: 'r' };

test('회전: 새 키를 ApiKeySecretArn에 저장', async () => {
  const { deps, puts } = makeDeps(0, []);
  await runRotateKey(STATE, deps as never);
  expect(puts).toEqual([['arn:key', 'NEWKEY48']]);
});

test('정지 상태면 다음 기동부터 적용 안내', async () => {
  const { deps, logs } = makeDeps(0, []);
  await runRotateKey(STATE, deps as never);
  expect(logs.join('\n')).toContain('다음 기동부터 적용');
});

test('가동 중이면 재기동 필요 + 기존 키 유효 안내 (설계 결정 5)', async () => {
  const { deps, logs } = makeDeps(1, ['i-1']);
  await runRotateKey(STATE, deps as never);
  const text = logs.join('\n');
  expect(text).toContain('tkf down');
  expect(text).toContain('기존 키');
  expect(text).toContain('tkf connect claude');
});

test('스택 없으면 오류', async () => {
  const { deps } = makeDeps(0, []);
  (deps.api as { getStackOutputs: unknown }).getStackOutputs = async () => null;
  await expect(runRotateKey(STATE, deps as never)).rejects.toThrow('스택');
});

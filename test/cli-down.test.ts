import { runDown } from '../cli/commands/down';

const state = { model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' };

test('down — desired=0, min=0', async () => {
  const set: Array<[string, number]> = [];
  const msg = await runDown(state, false, {
    api: { getStackOutputs: async () => ({ WeightsBucketName: 'bkt' }),
      getAsgName: async () => 'asg-1',
      setDesired: async (a: string, n: number) => { set.push([a, n]); },
      emptyAndDeleteBucket: async () => undefined },
    exec: async () => 0,
  } as never);
  expect(set).toEqual([['asg-1', 0]]);
  expect(msg).toContain('정지');
});

test('down --purge — destroy 후 가중치 버킷 삭제', async () => {
  const calls: string[] = [];
  const msg = await runDown(state, true, {
    api: { getStackOutputs: async () => ({ WeightsBucketName: 'bkt' }),
      getAsgName: async () => 'asg-1', setDesired: async () => undefined,
      emptyAndDeleteBucket: async (b: string) => { calls.push(`del:${b}`); } },
    exec: async (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(' ')); return 0; },
  } as never);
  expect(calls.some((c) => c.includes('cdk destroy'))).toBe(true);
  expect(calls).toContain('del:bkt');
  expect(msg).toContain('완전 삭제');
});

test('리전 오버라이드 상태로도 정지 동작 동일', async () => {
  const calls: string[] = [];
  const api = {
    getAsgName: async () => 'asg-x',
    setDesired: async (a: string, n: number) => { calls.push(`${a}:${n}`); },
    getStackOutputs: async () => ({ WeightsBucketName: 'bkt' }), emptyAndDeleteBucket: async () => {},
  };
  const msg = await runDown({ model: 'm', profile: 'p', region: 'us-west-2' }, false,
    { api: api as never, exec: async () => 0 });
  expect(calls).toEqual(['asg-x:0']);
  expect(msg).toContain('정지');
});

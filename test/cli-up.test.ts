import { runUp } from '../cli/commands/up';

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[][] = [];
  return {
    calls,
    api: {
      getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' }),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-1'] }),
      setDesired: async () => undefined,
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    exec: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return 0; },
    probeAuth: async () => 200,
    sleep: async () => undefined,
    saveState: () => undefined,
    log: () => undefined,
    timeoutMs: 1000,
    ...overrides,
  } as never;
}
const opts = { model: 'qwen3-coder-30b', profile: 'fp8', region: 'ap-northeast-2' };

test('스택·시딩이 준비돼 있으면 cdk/seed를 건너뛰고 기동만 한다', async () => {
  const d = deps();
  const r = await runUp(opts, d);
  expect(r.endpoint).toBe('http://alb');
  expect((d as never as { calls: string[][] }).calls).toEqual([]); // exec 호출 없음
});

test('스택이 없으면 cdk deploy를 minCapacity=0으로 실행한다', async () => {
  let created = false;
  const d = deps({
    api: {
      // 첫 조회는 null → deploy 후 재조회는 outputs
      getStackOutputs: async () => (created ? {
        EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' } : null),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-1'] }),
      setDesired: async () => undefined,
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    exec: async (cmd: string, args: string[]) => { created = true; (d as never as { calls: string[][] }).calls.push([cmd, ...args]); return 0; },
  });
  await runUp(opts, d);
  const flat = (d as never as { calls: string[][] }).calls.map((c) => c.join(' ')).join('\n');
  expect(flat).toContain('cdk deploy');
  expect(flat).toContain('minCapacity=0');
});

test('READY 전 유휴 강등(desired=0)을 감지하면 복구한다', async () => {
  let call = 0; const restored: number[] = [];
  const d = deps({
    api: {
      getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' }),
      getAsgName: async () => 'asg-1',
      // 1회차: 강등 상태(desired 0) → 복구 기대, 2회차: 정상
      getAsgStatus: async () => (call++ === 0 ? { desired: 0, instanceIds: [] } : { desired: 1, instanceIds: ['i-1'] }),
      setDesired: async (_a: string, n: number) => { restored.push(n); },
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    probeAuth: (() => { let n = 0; return async () => (n++ < 2 ? 0 : 200); })(),
  });
  await runUp(opts, d);
  expect(restored).toContain(1); // 최초 기동 1회 + 강등 복구 1회 이상
  expect(restored.filter((x) => x === 1).length).toBeGreaterThanOrEqual(2);
});

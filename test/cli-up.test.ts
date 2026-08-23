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

test('스택 보장 직후 saveState를 먼저 호출한다 (이후 단계 실패해도 tkf down이 대상을 찾도록)', async () => {
  const saved: unknown[] = [];
  const d = deps({
    api: {
      getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' }),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-1'] }),
      setDesired: async () => undefined,
      getSecret: async () => 'KEY',
      headObject: async () => { throw new Error('시딩 확인 실패'); }, // ②에서 실패 유도
    },
    saveState: (s: unknown) => saved.push(s),
  });
  await expect(runUp(opts, d)).rejects.toThrow('시딩 확인 실패');
  expect(saved.length).toBeGreaterThanOrEqual(1); // ① 직후 저장됨
});

test('READY 폴링 타임아웃 시 desired=0으로 되돌리고 에러 메시지에 명시한다', async () => {
  const restored: number[] = [];
  const d = deps({
    api: {
      getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' }),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-1'] }),
      setDesired: async (_a: string, n: number) => { restored.push(n); },
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    probeAuth: async () => 0, // 절대 READY 안 됨
    timeoutMs: 10, // 즉시 타임아웃 (실제 30분 대기 없음)
  });
  await expect(runUp(opts, d)).rejects.toThrow('용량을 0으로 되돌렸습니다');
  expect(restored).toContain(0);
});

test('타임아웃 후 setDesired(0) 자체가 실패하면 desired=1 잔존 사실을 메시지에 포함한다', async () => {
  const d = deps({
    api: {
      getStackOutputs: async () => ({ EndpointUrl: 'http://alb', ApiKeySecretArn: 'arn:sec',
        WeightsBucketName: 'bkt', WeightsRepo: 'Org/Repo' }),
      getAsgName: async () => 'asg-1',
      getAsgStatus: async () => ({ desired: 1, instanceIds: ['i-1'] }),
      setDesired: async (_a: string, n: number) => { if (n === 0) throw new Error('AWS API 오류'); },
      getSecret: async () => 'KEY',
      headObject: async () => true,
    },
    probeAuth: async () => 0,
    timeoutMs: 10,
  });
  await expect(runUp(opts, d)).rejects.toThrow('desired=1이 남아있을 수 있습니다');
});

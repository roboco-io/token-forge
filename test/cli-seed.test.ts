import { runSeed, mkSeedEnsure, SeedDeps } from '../cli/commands/seed';
import { Candidate } from '../cli/placement/engine';

const cands: Candidate[] = [
  { region: 'ap-northeast-1', score: 8, scoreSource: 'feed48h', rttMs: 35, price: 2.7, cached: true },
  { region: 'us-east-1', score: 5, scoreSource: 'realtime', rttMs: 180, price: 2.3, cached: false },
  { region: 'us-west-2', score: 3, scoreSource: 'feed48h', rttMs: 200, price: 1.9, cached: false },
];

function makeDeps(overrides: Partial<SeedDeps> = {}): SeedDeps {
  return {
    gather: async () => ({ cands, notices: [] }),
    thresholds: { score: 1, rttMs: 30 },
    k: 2,
    ensure: async () => {},
    select: async (choices: { region: string; label: string; checked: boolean }[]) =>
      choices.filter((c) => c.checked).map((c) => c.region),
    log: () => {},
    ...overrides,
  };
}

test('--region 지정 시 select 미호출 + ensure 1회', async () => {
  const select = jest.fn();
  const ensure = jest.fn(async () => {});
  const gather = jest.fn(async () => ({ cands, notices: [] }));
  const result = await runSeed(
    { model: 'qwen3-coder-30b', profile: 'int4', region: 'ap-northeast-2' },
    makeDeps({ select, ensure, gather }),
  );
  expect(select).not.toHaveBeenCalled();
  expect(gather).not.toHaveBeenCalled();
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(ensure).toHaveBeenCalledWith('ap-northeast-2');
  expect(result).toEqual(['ap-northeast-2']);
});

test('리전 생략 시 기본 체크가 서열 상위 K개', async () => {
  let capturedChoices: { region: string; label: string; checked: boolean }[] = [];
  const select = jest.fn(async (choices: { region: string; label: string; checked: boolean }[]) => {
    capturedChoices = choices;
    return choices.filter((c) => c.checked).map((c) => c.region);
  });
  await runSeed({ model: 'qwen3-coder-30b', profile: 'int4' }, makeDeps({ select, k: 2 }));
  expect(select).toHaveBeenCalledTimes(1);
  // 서열: ap-northeast-1(8) > us-east-1(5) > us-west-2(3) — 상위 2개만 checked
  expect(capturedChoices.map((c) => ({ region: c.region, checked: c.checked }))).toEqual([
    { region: 'ap-northeast-1', checked: true },
    { region: 'us-east-1', checked: true },
    { region: 'us-west-2', checked: false },
  ]);
});

test('select가 일부만 반환하면 그 리전들만 순차 ensure', async () => {
  const order: string[] = [];
  const ensureTracking = jest.fn(async (region: string) => { order.push(region); });
  const result = await runSeed(
    { model: 'qwen3-coder-30b', profile: 'int4' },
    makeDeps({ ensure: ensureTracking, select: async () => ['us-west-2', 'ap-northeast-1'] }),
  );
  expect(ensureTracking).toHaveBeenCalledTimes(2);
  expect(order).toEqual(['us-west-2', 'ap-northeast-1']);
  expect(result).toEqual(['us-west-2', 'ap-northeast-1']);
});

test('선택 0개면 ensure 미호출 + 종료 메시지', async () => {
  const ensure = jest.fn(async () => {});
  const log = jest.fn();
  const result = await runSeed(
    { model: 'qwen3-coder-30b', profile: 'int4' },
    makeDeps({ ensure, select: async () => [], log }),
  );
  expect(ensure).not.toHaveBeenCalled();
  expect(result).toEqual([]);
  expect(log.mock.calls.some((c) => String(c[0]).includes('선택된 리전이 없습니다'))).toBe(true);
});

test('시딩 전 리전당 비용 고지', async () => {
  const log = jest.fn();
  await runSeed({ model: 'qwen3-coder-30b', profile: 'int4', region: 'ap-northeast-2' }, makeDeps({ log }));
  expect(log.mock.calls.some((c) => String(c[0]).includes('리전당 비용'))).toBe(true);
});

// 회귀 방지: program.ts가 실제 ensureStackReady 배선을 직접 조립하다가 real saveState를
// 주입한 사고(Critical 리뷰)를 재발시키지 않도록, mkSeedEnsure 자체가 no-op을 강제하는지
// 실제 ensureStackReady 경로를 태워 검증한다 (배선이 program.ts 밖으로 나오므로 테스트로 갭이 닫힘).
test('mkSeedEnsure는 주입된 saveState를 호출하지 않는다 (배포 추적 오염 방지)', async () => {
  const saveState = jest.fn();
  const log = jest.fn();
  const exec = jest.fn(async () => 0);
  const api = {
    getStackOutputs: jest.fn(async () => ({ WeightsRepo: 'org/model', WeightsBucketName: 'bucket' })),
    headObject: jest.fn(async () => true), // 이미 캐시됨 — 생성/시딩 분기 모두 스킵
  };
  const mkDeps = () => ({ api, exec, log, saveState } as never);
  const ensure = mkSeedEnsure('qwen3-coder-30b', 'int4', mkDeps);
  await ensure('ap-northeast-2');
  expect(api.getStackOutputs).toHaveBeenCalledTimes(1);
  expect(api.headObject).toHaveBeenCalledTimes(1);
  expect(exec).not.toHaveBeenCalled(); // 캐시 히트 — 생성/시딩 exec 불필요
  expect(saveState).not.toHaveBeenCalled(); // 핵심: 주입된 saveState가 실행되지 않아야 함
});

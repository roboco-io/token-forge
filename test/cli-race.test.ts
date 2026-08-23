import { runRace, RaceEntrant, RaceDeps } from '../cli/commands/race';

const entrants: RaceEntrant[] = [
  { region: 'ap-northeast-1', asgName: 'asg-1', endpointUrl: 'http://e1' },
  { region: 'ap-northeast-2', asgName: 'asg-2', endpointUrl: 'http://e2' },
];

// inServiceByRegion 생략 시 instanceIds와 동일(launching=InService로 간주) — 기존 테스트 하위호환
function makeDeps(
  instancesByRegion: Record<string, string[][]>,
  desiredSeq: Record<string, number[]> = {},
  inServiceByRegion?: Record<string, string[][]>,
) {
  const calls: string[] = [];
  const probed: string[] = [];
  const apiFor = (region: string) => ({
    setDesired: async (asg: string, n: number) => { calls.push(`${region}:desired=${n}`); },
    getAsgStatus: async () => {
      const instanceIds = (instancesByRegion[region] ?? [[]]).length > 1
        ? instancesByRegion[region].shift()! : (instancesByRegion[region] ?? [[]])[0];
      const svc = inServiceByRegion?.[region];
      const inServiceIds = svc
        ? (svc.length > 1 ? svc.shift()! : svc[0])
        : instanceIds;
      return {
        desired: (desiredSeq[region] ?? [1]).length > 1 ? desiredSeq[region].shift()! : (desiredSeq[region] ?? [1])[0],
        instanceIds,
        inServiceIds,
      };
    },
  });
  const deps: RaceDeps = { apiFor, probe: async (u: string) => { probed.push(u); return 0; },
    sleep: async () => {}, log: () => {}, timeoutMs: 60_000 };
  return { calls, probed, deps };
}

test('전 후보 desired=1 → 첫 확보 리전이 승자, 패자는 즉시 desired=0', async () => {
  // apne1은 2번째 폴링에서 확보, apne2는 계속 미확보
  const { calls, deps } = makeDeps({ 'ap-northeast-1': [[], ['i-1'], ['i-1']], 'ap-northeast-2': [[]] });
  const winner = await runRace(entrants, deps);
  expect(winner.region).toBe('ap-northeast-1');
  expect(calls.slice(0, 2)).toEqual(['ap-northeast-1:desired=1', 'ap-northeast-2:desired=1']); // 동시 시작
  expect(calls).toContain('ap-northeast-2:desired=0'); // 패자 취소
  expect(calls.filter((c) => c === 'ap-northeast-1:desired=0')).toHaveLength(0); // 승자는 취소 안 함
});

test('레이스 중 유휴 가드 강등 감지 시 복구 + 전 후보 핑', async () => {
  const { calls, probed, deps } = makeDeps(
    { 'ap-northeast-1': [[], [], ['i-1']], 'ap-northeast-2': [[]] },
    { 'ap-northeast-2': [0, 1, 1] }, // 첫 폴링에서 desired=0 (강등)
  );
  await runRace(entrants, deps);
  expect(calls.filter((c) => c === 'ap-northeast-2:desired=1').length).toBeGreaterThanOrEqual(2); // 시작 + 복구
  expect(probed).toContain('http://e1/v1/models'); // 유휴 알람 발화 차단용 핑
  expect(probed).toContain('http://e2/v1/models');
});

test('타임아웃 시 전 후보 desired=0 후 오류', async () => {
  const calls: string[] = [];
  const zeroDeps: RaceDeps = {
    apiFor: () => ({ setDesired: async (a: string, n: number) => { calls.push(`${n}`); },
      getAsgStatus: async () => ({ desired: 1, instanceIds: [], inServiceIds: [] }) }),
    probe: async () => 0, log: () => {},
    sleep: async () => {}, timeoutMs: 0,
  };
  await expect(runRace(entrants, zeroDeps)).rejects.toThrow('레이스 타임아웃');
  expect(calls.filter((c) => c === '0')).toHaveLength(2); // 두 후보 모두 취소
});

test('타임아웃 시 일부 리전 취소 실패하면 오류 메시지에 해당 리전과 대처법 포함', async () => {
  const failDeps: RaceDeps = {
    apiFor: (region: string) => ({
      setDesired: async (_asg: string, n: number) => {
        if (region === 'ap-northeast-2' && n === 0) throw new Error('throttled');
      },
      getAsgStatus: async () => ({ desired: 1, instanceIds: [], inServiceIds: [] }),
    }),
    probe: async () => 0, log: () => {},
    sleep: async () => {}, timeoutMs: 0,
  };
  await expect(runRace(entrants, failDeps)).rejects.toThrow(/ap-northeast-2.*되돌리기 실패.*tkf down --region/);
});

test('launching(instanceIds에는 있으나 InService 아님)만으로는 승자 판정하지 않음', async () => {
  // apne1은 2번째 폴링에서 launching(instanceIds에만 등장)했다가 실패해 사라짐 — 끝까지 InService 안 됨
  // apne2는 3번째 폴링에서 InService — InService 기준이면 apne2가 승자여야 함
  const { calls, deps } = makeDeps(
    { 'ap-northeast-1': [[], ['i-launch'], []], 'ap-northeast-2': [[], [], ['i-2']] },
    {},
    { 'ap-northeast-1': [[], [], []], 'ap-northeast-2': [[], [], ['i-2']] },
  );
  const winner = await runRace(entrants, deps);
  expect(winner.region).toBe('ap-northeast-2');
  expect(calls).toContain('ap-northeast-1:desired=0'); // 패자(launching만 있던 apne1) 취소
});

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

test('레이스 시작 시 일부 리전 desired=1 실패 → 고지 후 나머지 리전만으로 레이스 계속', async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: RaceDeps = {
    apiFor: (region: string) => ({
      setDesired: async (_asg: string, n: number) => {
        if (region === 'ap-northeast-1' && n === 1) throw new Error('capacity error');
        calls.push(`${region}:desired=${n}`);
      },
      getAsgStatus: async () => {
        if (region === 'ap-northeast-1') throw new Error('시작 실패 리전은 폴링 대상에서 제외돼야 함');
        return { desired: 1, instanceIds: ['i-2'], inServiceIds: ['i-2'] };
      },
    }),
    probe: async (u: string) => {
      if (u.includes('e1')) throw new Error('시작 실패 리전은 핑 대상에서 제외돼야 함');
      return 0;
    },
    sleep: async () => {}, log: (m: string) => logs.push(m),
    timeoutMs: 60_000,
  };
  const winner = await runRace(entrants, deps);
  expect(winner.region).toBe('ap-northeast-2'); // 성공한 리전만으로 레이스 진행 → 자연스레 승자
  expect(logs.some((l) => l.includes('ap-northeast-1') && l.includes('기동 설정 실패'))).toBe(true);
  expect(calls).not.toContain('ap-northeast-1:desired=0'); // 애초에 desired=1 아니므로 취소 대상 아님
});

test('레이스 시작 시 전 리전 desired=1 실패 → 오류(정리 호출 없음)', async () => {
  const calls: string[] = [];
  const deps: RaceDeps = {
    apiFor: (region: string) => ({
      setDesired: async () => { calls.push(region); throw new Error(`${region} capacity error`); },
      getAsgStatus: async () => { throw new Error('호출되면 안 됨 — 폴링 진입 전에 중단돼야 함'); },
    }),
    probe: async () => { throw new Error('호출되면 안 됨'); },
    sleep: async () => {}, log: () => {},
    timeoutMs: 60_000,
  };
  await expect(runRace(entrants, deps)).rejects.toThrow(/레이스 시작 실패/);
  expect(calls).toEqual(['ap-northeast-1', 'ap-northeast-2']); // 시작 시도(desired=1)만, 취소(desired=0) 없음
});

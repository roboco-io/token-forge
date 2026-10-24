import { resolveUsagePolicy, policyContextArgs, policyMatchesOutputs } from '../lib/usage-mode';

describe('resolveUsagePolicy — 모드 기본값', () => {
  test('생략 시 interactive, 유휴 30분, min 1 (기존 동작 호환)', () => {
    expect(resolveUsagePolicy()).toEqual({ mode: 'interactive', idleMinutes: 30, minCapacity: 1, readyMinCapacity: 0 });
    expect(resolveUsagePolicy({ usageMode: '' })).toMatchObject({ mode: 'interactive', idleMinutes: 30 });
  });
  test('batch: 백스톱 30분, min 0, READY 후에도 min 0', () => {
    expect(resolveUsagePolicy({ usageMode: 'batch' })).toEqual({ mode: 'batch', idleMinutes: 30, minCapacity: 0, readyMinCapacity: 0 });
  });
  test('online: 유휴 종료 없음, READY 후 min 1', () => {
    expect(resolveUsagePolicy({ usageMode: 'online' })).toEqual({ mode: 'online', idleMinutes: 0, minCapacity: 1, readyMinCapacity: 1 });
  });
  test('알 수 없는 모드는 거부', () => {
    expect(() => resolveUsagePolicy({ usageMode: 'int4' })).toThrow(/usageMode/);
  });
});

describe('resolveUsagePolicy — 명시값 우선순위와 검증', () => {
  test('명시 idleMinutes가 모드 기본값보다 우선 (문자열 컨텍스트도 해석)', () => {
    expect(resolveUsagePolicy({ idleMinutes: '60' }).idleMinutes).toBe(60);
    expect(resolveUsagePolicy({ usageMode: 'batch', idleMinutes: 120 }).idleMinutes).toBe(120);
  });
  test('interactive의 idleMinutes=0은 기존처럼 비활성', () => {
    expect(resolveUsagePolicy({ idleMinutes: 0 }).idleMinutes).toBe(0);
    expect(resolveUsagePolicy({ idleMinutes: '0' }).idleMinutes).toBe(0);
  });
  test.each(['12', 3, '7.5', '-5', 'abc', '1e2', 1445, '2000'])('5분 배수·5-1440 밖 또는 비정수 %p는 거부 (반올림 금지)', (v) => {
    expect(() => resolveUsagePolicy({ idleMinutes: v })).toThrow(/idleMinutes/);
  });
  test('online에 유휴 종료를 명시하면 거부, 0은 허용', () => {
    expect(() => resolveUsagePolicy({ usageMode: 'online', idleMinutes: 30 })).toThrow(/online/);
    expect(resolveUsagePolicy({ usageMode: 'online', idleMinutes: 0 }).idleMinutes).toBe(0);
  });
  test('batch에 idleMinutes=0(백스톱 해제)은 거부', () => {
    expect(() => resolveUsagePolicy({ usageMode: 'batch', idleMinutes: 0 })).toThrow(/batch/);
  });
  test('batch에 minCapacity=1은 거부, minCapacity는 0/1만', () => {
    expect(() => resolveUsagePolicy({ usageMode: 'batch', minCapacity: 1 })).toThrow(/batch/);
    expect(() => resolveUsagePolicy({ minCapacity: 2 })).toThrow(/minCapacity/);
    expect(resolveUsagePolicy({ usageMode: 'online', minCapacity: '0' }).minCapacity).toBe(0);
  });
});

describe('CLI ↔ CDK 정책 일치', () => {
  test.each([
    [{}], [{ usageMode: 'batch' }], [{ usageMode: 'online' }], [{ idleMinutes: 60 }], [{ idleMinutes: 0 }],
  ])('policyContextArgs를 다시 해석하면 같은 정책 (%p)', (input) => {
    const p = resolveUsagePolicy({ ...input, minCapacity: 0 });
    const args = policyContextArgs(p);
    const ctx: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) { const [k, v] = args[i + 1].split('='); ctx[k] = v; }
    expect(resolveUsagePolicy({ ...ctx, minCapacity: 0 })).toEqual(p);
  });
  test('출력 비교 — 같으면 true, 다르거나 구버전(출력 없음)이면 false', () => {
    const p = resolveUsagePolicy({ usageMode: 'online' });
    expect(policyMatchesOutputs(p, { UsageMode: 'online', IdleMinutes: '0' })).toBe(true);
    expect(policyMatchesOutputs(p, { UsageMode: 'interactive', IdleMinutes: '30' })).toBe(false);
    expect(policyMatchesOutputs(resolveUsagePolicy(), {})).toBe(false);
  });
});

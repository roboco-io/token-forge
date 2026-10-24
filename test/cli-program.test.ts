import { buildProgram } from '../cli/program';

test('프로그램 이름은 tkf, --version 옵션이 등록돼 있다', () => {
  const program = buildProgram();
  expect(program.name()).toBe('tkf');
  // program.version() getter는 commander 버전에 따라 동작이 달라 옵션 등록 여부로 검증
  expect(program.options.some((o: any) => o.long === '--version')).toBe(true);
});

test('run 명령: 필수 --region, -- 뒤 가변 명령 인자, 타임아웃 옵션 등록', () => {
  const run = buildProgram().commands.find((c) => c.name() === 'run')!;
  expect(run).toBeDefined();
  const longs = run.options.map((o: any) => o.long);
  expect(longs).toEqual(expect.arrayContaining(['--region', '--profile', '--idle-minutes', '--boot-timeout', '--timeout']));
  expect(run.options.find((o: any) => o.long === '--region')!.mandatory).toBe(true);
  expect((run as any).registeredArguments.map((a: any) => a.variadic)).toEqual([false, true]);
});

test('up 명령: --usage-mode, --idle-minutes 등록', () => {
  const up = buildProgram().commands.find((c) => c.name() === 'up')!;
  expect(up.options.map((o: any) => o.long)).toEqual(expect.arrayContaining(['--usage-mode', '--idle-minutes']));
});

test('parseMinutes — 정수 범위만 허용', () => {
  const { parseMinutes } = require('../cli/program');
  expect(parseMinutes('--timeout', '0', 0)).toBe(0);
  expect(parseMinutes('--boot-timeout', '45', 1)).toBe(45);
  for (const bad of ['0', '1.5', '-1', 'x', '99999']) expect(() => parseMinutes('--boot-timeout', bad, 1)).toThrow(/boot-timeout/);
});

test('run 파싱: -- 뒤 옵션 모양 인자도 명령 배열로 보존', async () => {
  const program = buildProgram();
  const run = program.commands.find((c) => c.name() === 'run')!;
  let got: unknown[] = [];
  run.action((model: string, command: string[], o: { region: string; timeout: string }) => { got = [model, command, o.region, o.timeout]; });
  await program.parseAsync(['node', 'tkf', 'run', 'qwen3-coder-30b', '--region', 'ap-northeast-2', '--', 'python', '-v', '--region', 'x y']);
  expect(got).toEqual(['qwen3-coder-30b', ['python', '-v', '--region', 'x y'], 'ap-northeast-2', '120']);
});

describe('spawnJob — 실제 자식 프로세스 (AWS 무관)', () => {
  const { spawnJob } = require('../cli/program');
  test('인자 배열·env 전달, 종료 코드 보존 (셸 해석 없음)', async () => {
    const j = spawnJob(process.execPath, ['-e', 'process.exit(process.argv[1] === "a b; echo x" && process.env.TKF_MODEL === "M" ? 7 : 1)', 'a b; echo x'], { TKF_MODEL: 'M' });
    expect(await j.done).toEqual({ code: 7, signal: null });
  });
  test('없는 명령은 error(ENOENT)로 reject', async () => {
    await expect(spawnJob('tkf-no-such-cmd-43', [], {}).done).rejects.toThrow(/ENOENT/);
  });
  test('kill(SIGTERM)으로 종료', async () => {
    const j = spawnJob(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {});
    setTimeout(() => j.kill('SIGTERM'), 100);
    expect(await j.done).toEqual({ code: null, signal: 'SIGTERM' });
  });
});

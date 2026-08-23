import { buildProgram } from '../cli/program';

test('프로그램 이름은 tf, --version 옵션이 등록돼 있다', () => {
  const program = buildProgram();
  expect(program.name()).toBe('tf');
  // program.version() getter는 commander 버전에 따라 동작이 달라 옵션 등록 여부로 검증
  expect(program.options.some((o: any) => o.long === '--version')).toBe(true);
});

import { renderClaudeEnv } from '../cli/commands/connect';

test('Claude Code 환경변수 3종을 export 형식으로 렌더링', () => {
  const out = renderClaudeEnv('http://alb', 'SECRET', 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8');
  expect(out).toContain('export ANTHROPIC_BASE_URL="http://alb"');
  expect(out).toContain('export ANTHROPIC_AUTH_TOKEN="SECRET"');
  expect(out).toContain('export ANTHROPIC_MODEL="Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"');
});

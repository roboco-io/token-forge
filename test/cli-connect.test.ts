import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { renderClaudeEnv } from '../cli/commands/connect';

test('Claude Code 환경변수 3종을 export 형식으로 렌더링', () => {
  const out = renderClaudeEnv('http://alb', 'SECRET', 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8');
  expect(out).toContain('export ANTHROPIC_BASE_URL="http://alb"');
  expect(out).toContain('export ANTHROPIC_AUTH_TOKEN="SECRET"');
  expect(out).toContain('export ANTHROPIC_MODEL="Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"');
});

test('기존 644 파일도 chmodSync 후 0600으로 보장', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-connect-'));
  const file = path.join(tmpdir, 'env.sh');
  try {
    // 기존 644 권한 파일 생성
    fs.writeFileSync(file, 'old content');
    fs.chmodSync(file, 0o644);
    expect((fs.statSync(file).mode & 0o777)).toBe(0o644);

    // connect 시뮬레이션: writeFileSync + chmodSync
    const env = renderClaudeEnv('http://alb', 'SECRET', 'model');
    fs.writeFileSync(file, env, { mode: 0o600 });
    fs.chmodSync(file, 0o600); // 기존 파일도 0600으로 보장

    expect((fs.statSync(file).mode & 0o777)).toBe(0o600);
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const scriptPath = path.join(__dirname, '..', 'assets', 'user-data', 'boot.sh');

describe('boot.sh', () => {
  const PLACEHOLDERS = [
    '__REGION__', '__API_KEY_SECRET_ARN__', '__WEIGHTS_BUCKET__',
    '__WEIGHTS_REPO__', '__VLLM_IMAGE__', '__VLLM_FLAGS__', '__MAX_MODEL_LEN__',
  ];

  test('exists and passes bash syntax check', () => {
    execFileSync('bash', ['-n', scriptPath]); // 문법 오류 시 throw
  });

  test('contains every CDK substitution placeholder', () => {
    const body = fs.readFileSync(scriptPath, 'utf8');
    for (const ph of PLACEHOLDERS) {
      expect(body).toContain(ph);
    }
  });

  test('is defensive and restarts vLLM idempotently', () => {
    const body = fs.readFileSync(scriptPath, 'utf8');
    expect(body).toContain('set -euo pipefail');
    expect(body).toContain('docker rm -f vllm');   // 재실행 안전
    expect(body).toContain('--restart always');    // 컨테이너 자동 재기동
  });
});

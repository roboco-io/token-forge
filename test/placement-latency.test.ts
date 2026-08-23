import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { measureRtt, getRtt } from '../cli/placement/latency';

const NOW = new Date('2026-08-23T12:00:00Z');

describe('measureRtt', () => {
  test('3회 측정의 중앙값, 대상은 ec2.<region>.amazonaws.com:443', async () => {
    const calls: string[] = [];
    const results = [80, 30, 50];
    const connect = async (host: string, port: number) => { calls.push(`${host}:${port}`); return results.shift()!; };
    expect(await measureRtt('ap-northeast-1', connect)).toBe(50);
    expect(calls).toEqual(Array(3).fill('ec2.ap-northeast-1.amazonaws.com:443'));
  });
});

describe('getRtt (24h 캐시)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tflat-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('캐시 미스 → 측정 후 저장', async () => {
    const connect = async () => 42;
    expect(await getRtt('us-east-1', { connect, dir, now: () => NOW })).toBe(42);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'latency.json'), 'utf8'));
    expect(cache['us-east-1'].rttMs).toBe(42);
  });

  test('24시간 내 캐시는 재측정하지 않음', async () => {
    fs.writeFileSync(path.join(dir, 'latency.json'),
      JSON.stringify({ 'us-east-1': { rttMs: 99, measuredAt: '2026-08-23T00:00:00Z' } }));
    let called = 0;
    const connect = async () => { called++; return 1; };
    expect(await getRtt('us-east-1', { connect, dir, now: () => NOW })).toBe(99);
    expect(called).toBe(0);
  });

  test('24시간 지난 캐시는 재측정', async () => {
    fs.writeFileSync(path.join(dir, 'latency.json'),
      JSON.stringify({ 'us-east-1': { rttMs: 99, measuredAt: '2026-08-20T00:00:00Z' } }));
    const connect = async () => 7;
    expect(await getRtt('us-east-1', { connect, dir, now: () => NOW })).toBe(7);
  });
});

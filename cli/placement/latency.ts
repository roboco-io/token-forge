// cli/placement/latency.ts — 후보 리전 레이턴시: EC2 엔드포인트 TCP RTT (스펙 R10 입력)
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

export type Connector = (host: string, port: number, timeoutMs: number) => Promise<number>;

/** TCP 연결 수립까지의 시간(ms). 실패·타임아웃은 reject */
export const tcpConnector: Connector = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = net.connect({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(Date.now() - start); });
    sock.once('timeout', () => { sock.destroy(); reject(new Error(`${host} 연결 타임아웃`)); });
    sock.once('error', (e) => { sock.destroy(); reject(e); });
  });

/** 3회 측정 후 중앙값 (스펙: TCP 연결 시간 3회 측정 후 중앙값) */
export async function measureRtt(region: string, connect: Connector): Promise<number> {
  const host = `ec2.${region}.amazonaws.com`;
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) samples.push(await connect(host, 443, 5000));
  samples.sort((a, b) => a - b);
  return samples[1];
}

interface LatencyCache { [region: string]: { rttMs: number; measuredAt: string } }

/** 24h 로컬 캐시 우선, 미스·만료 시 측정 후 저장 */
export async function getRtt(region: string, d: { connect: Connector; dir: string; now: () => Date }): Promise<number> {
  const file = path.join(d.dir, 'latency.json');
  let cache: LatencyCache = {};
  if (fs.existsSync(file)) {
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      cache = {}; // 손상된 캐시 파일 — 캐시 미스로 처리해 측정을 계속 진행 (스펙: RTT 측정 봉쇄 금지)
    }
  }
  const hit = cache[region];
  if (hit && d.now().getTime() - new Date(hit.measuredAt).getTime() < 24 * 3600 * 1000) return hit.rttMs;
  const rttMs = await measureRtt(region, d.connect);
  cache[region] = { rttMs, measuredAt: d.now().toISOString() };
  fs.mkdirSync(d.dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  return rttMs;
}

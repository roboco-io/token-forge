// 사용 모드(#43) 오프라인 합성 검증 — AWS 호출 없이 cdk synth만 실행한다.
// 사용법: npx ts-node scripts/verify-usage-mode-synth.ts
// 리포지토리의 cdk.context.json(계정 AZ 캐시)을 건드리지 않도록 임시 디렉터리에 별도 cdk.json과
// 더미 AZ 컨텍스트를 만들고, 각 케이스마다 새 출력 디렉터리를 써서 이전 템플릿 재사용을 막는다.
// cdk 호출 인자는 배열로 전달하고(셸 단어 분리 없음) 종료 코드와 템플릿 값을 케이스별로 확인한다.
// cdk.json의 app은 cdk CLI가 셸로 실행하는 문자열이므로 경로를 POSIX 작은따옴표로 인용한다(macOS/Linux 전용).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const CDK = path.join(ROOT, 'node_modules', '.bin', 'cdk');
const ACCOUNT = '111111111111';
const REGION = 'us-east-2';
const STACK = 'TokenForge-qwen3-coder-30b-fp8';

interface Expect { mode: string; idle: string; min: string; idleAlarms: number; periods?: number; settings?: Record<string, unknown> }
const EMPTY_SETTINGS = { v: 1, allowedCidrs: '', azs: '', alertEmail: '' };
/** POSIX 셸 작은따옴표 인용 — 공백·$·따옴표가 있는 경로도 한 인자로 유지 */
const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const OK: Array<[string[], Expect]> = [
  [[], { mode: 'interactive', idle: '30', min: '1', idleAlarms: 1, periods: 6 }],
  [['-c', 'usageMode=interactive', '-c', 'minCapacity=0'], { mode: 'interactive', idle: '30', min: '0', idleAlarms: 1, periods: 6 }],
  [['-c', 'idleMinutes=60'], { mode: 'interactive', idle: '60', min: '1', idleAlarms: 1, periods: 12 }],
  [['-c', 'idleMinutes=0'], { mode: 'interactive', idle: '0', min: '1', idleAlarms: 0 }], // 합성만 — 배포하지 않음
  [['-c', 'usageMode=batch'], { mode: 'batch', idle: '30', min: '0', idleAlarms: 1, periods: 6 }],
  [['-c', 'usageMode=online', '-c', 'minCapacity=0'], { mode: 'online', idle: '0', min: '0', idleAlarms: 0 }],
  [['-c', 'usageMode=online'], { mode: 'online', idle: '0', min: '1', idleAlarms: 0 }],
  [['-c', 'usageMode=online', '-c', 'minCapacity=0', '-c', 'allowedCidrs=203.0.113.7,198.51.100.0/24', '-c', `azs=${REGION}a`,
    '-c', 'alertEmail=ops@example.com'],
  { mode: 'online', idle: '0', min: '0', idleAlarms: 0,
    settings: { v: 1, allowedCidrs: '203.0.113.7/32,198.51.100.0/24', azs: `${REGION}a`, alertEmail: 'ops@example.com' } }],
];
const BAD: Array<[string[], RegExp]> = [
  [['-c', 'usageMode=online', '-c', 'idleMinutes=30'], /idleMinutes: online/],
  [['-c', 'usageMode=batch', '-c', 'minCapacity=1'], /minCapacity: batch/],
  [['-c', 'usageMode=batch', '-c', 'idleMinutes=0'], /idleMinutes: batch/],
  [['-c', 'idleMinutes=12'], /idleMinutes\(interactive\)/],
  [['-c', 'usageMode=bogus'], /usageMode: 알 수 없는 값/],
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tkf-synth-'));
fs.writeFileSync(path.join(work, 'cdk.json'), JSON.stringify({
  app: ['npx', '--prefix', ROOT, 'ts-node', '--project', path.join(ROOT, 'tsconfig.json'), '--prefer-ts-exts',
    path.join(ROOT, 'bin', 'token-forge.ts')].map((a) => (a === 'npx' ? a : sq(a))).join(' '),
}));
fs.writeFileSync(path.join(work, 'cdk.context.json'), JSON.stringify({
  [`availability-zones:account=${ACCOUNT}:region=${REGION}`]: [`${REGION}a`, `${REGION}b`, `${REGION}c`],
}));
const env = { ...process.env, AWS_EC2_METADATA_DISABLED: 'true', CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: REGION };

function synth(extra: string[]): { status: number | null; out: string; template?: string } {
  const outDir = fs.mkdtempSync(path.join(work, 'out-'));
  const r = spawnSync(CDK, ['synth', '-c', 'model=qwen3-coder-30b', '-c', 'profile=fp8', ...extra,
    '--no-lookups', '-o', outDir, '--quiet'], { cwd: work, env, encoding: 'utf8' });
  const file = path.join(outDir, `${STACK}.template.json`);
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, template: r.status === 0 && fs.existsSync(file) ? file : undefined };
}

let failures = 0;
const fail = (msg: string) => { failures += 1; console.error(`FAIL ${msg}`); };

for (const [args, exp] of OK) {
  const label = args.join(' ') || '(기본)';
  const r = synth(args);
  if (r.status !== 0 || !r.template) { fail(`${label}: exit=${r.status}\n${r.out.slice(-800)}`); continue; }
  const t = JSON.parse(fs.readFileSync(r.template, 'utf8'));
  const res = Object.values(t.Resources) as Array<{ Type: string; Properties: Record<string, unknown> }>;
  const asg = res.find((x) => x.Type === 'AWS::AutoScaling::AutoScalingGroup')!.Properties;
  const idle = res.filter((x) => x.Type === 'AWS::CloudWatch::Alarm' && x.Properties.MetricName === 'RequestCount');
  const got = { mode: t.Outputs.UsageMode.Value, idle: t.Outputs.IdleMinutes.Value, min: asg.MinSize, max: asg.MaxSize,
    idleAlarms: idle.length, periods: idle[0]?.Properties.EvaluationPeriods,
    settings: t.Outputs.DeploymentSettings ? JSON.parse(t.Outputs.DeploymentSettings.Value) : undefined };
  const ok = got.mode === exp.mode && got.idle === exp.idle && got.min === exp.min && got.max === '1' &&
    got.idleAlarms === exp.idleAlarms && (exp.periods === undefined || got.periods === exp.periods) &&
    JSON.stringify(got.settings) === JSON.stringify(exp.settings ?? EMPTY_SETTINGS);
  if (ok) console.log(`ok   ${label} → ${JSON.stringify(got)}`); else fail(`${label}: 기대 ${JSON.stringify(exp)} / 실제 ${JSON.stringify(got)}`);
}
for (const [args, re] of BAD) {
  const label = args.join(' ');
  const r = synth(args);
  if (r.status === 0) fail(`${label}: 거부되어야 하는데 exit=0`);
  else if (!re.test(r.out)) fail(`${label}: exit=${r.status}이지만 기대 오류(${re}) 없음\n${r.out.slice(-800)}`);
  else console.log(`ok   ${label} → 거부(exit=${r.status})`);
}

fs.rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? `PASS ${OK.length + BAD.length} cases` : `FAILED ${failures} case(s)`);
process.exit(failures === 0 ? 0 : 1);

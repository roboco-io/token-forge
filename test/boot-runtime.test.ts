import { bootReport } from '../cli/commands/boot-report';
import { spawn, spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
const source = fs.readFileSync(path.join(__dirname, '../assets/user-data/boot.sh'), 'utf8');
function harness(extra: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-runtime-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fake'), `#!${python}
import os,sys,time,json
from pathlib import Path
p=Path(os.environ['FIXTURE']); cmd=Path(sys.argv[0]).name; a=sys.argv[1:]
def mark(n): (p/n).touch()
def gate(n):
 for i in range(1000):
  if (p/n).exists(): return
  time.sleep(.01)
 sys.exit(23)
def work(name,other):
 mark(name)
 if os.environ.get('GATE')=='1': gate(other)
 if os.environ.get('ORPHAN')==name:
  import subprocess
  child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
  (p/'child').write_text(str(child.pid)); sys.exit(0)
 if os.environ.get('FAIL')==name:
  if os.environ.get('BLOCK'): gate('child')
  sys.exit(7)
 if os.environ.get('HOLD')==name: gate('release')
 if os.environ.get('BLOCK')==name:
  import subprocess
  child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
  (p/'child').write_text(str(child.pid)); time.sleep(60)
if cmd=='python3':
 if a[:2]==['-m','pip']: sys.exit(0)
 os.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}]+a)
if cmd=='aws':
 if a[0]=='secretsmanager': print(('-' if os.environ.get('DASH_KEY') else '')+'DO_NOT_LOG_SECRET')
 elif a[:2]==['s3api','head-object']: sys.exit(1 if os.environ.get('MISS') else 0)
 elif a[:2]==['logs','create-log-stream']:
  if os.environ.get('STREAM_LOST') and not (p/'stream-created').exists():
   mark('stream-created'); sys.exit(255)
  if os.environ.get('STREAM_EXISTS') or os.environ.get('STREAM_LOST'):
   print('An error occurred (ResourceAlreadyExistsException) when calling the CreateLogStream operation: DO_NOT_LOG_SECRET',file=sys.stderr); sys.exit(254)
  if os.environ.get('STREAM_DENIED'):
   print('An error occurred (AccessDeniedException) when calling the CreateLogStream operation: DO_NOT_LOG_SECRET',file=sys.stderr); sys.exit(254)
 elif a[:2]==['logs','put-log-events']:
  f=a[a.index('--cli-input-json')+1][7:]; (p/'upload.json').write_text(Path(f).read_text())
  with (p/'uploads.jsonl').open('a') as capture: capture.write(Path(f).read_text()+'\\n')
  if os.environ.get('HOLD_UPLOAD'): gate('release-upload')
  if os.environ.get('UPLOAD_HANG'):
   import subprocess
   child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
   (p/'upload-child').write_text(str(child.pid))
   (p/'upload-pid').write_text(str(os.getpid())); time.sleep(60)
  if os.environ.get('UPLOAD_FAIL'): sys.exit(9)
  print(json.dumps({'rejectedLogEventsInfo':{'tooNewLogEventStartIndex':0}} if os.environ.get('REJECT') else {}))
 elif a[:2]==['s3','cp']: mark('complete')
if cmd=='s5cmd': work('weights','image')
if cmd=='huggingface-cli':
 mark('hf')
 with (p/'hf-attempts').open('a') as f: f.write('x')
 sys.exit(1 if os.environ.get('HF_FAIL') else 0)
if cmd=='docker':
 if a[:2]==['image','inspect']: sys.exit(0 if os.environ.get('LOCAL') else 1)
 if a[0]=='pull': work('image','weights')
 if a[0]=='run':
  if os.environ.get('DASH_KEY'):
   import argparse
   parser=argparse.ArgumentParser(add_help=False); parser.add_argument('--api-key',nargs='+')
   parsed,_=parser.parse_known_args(a); assert parsed.api_key[0]=='-DO_NOT_LOG_SECRET'
  mark('container'); print('DO_NOT_LOG_SECRET'); sys.exit(1 if os.environ.get('RUN_FAIL') else 0)
if cmd=='curl': sys.exit(1 if os.environ.get('HEALTH_FAIL') else 0)
if cmd=='sleep': time.sleep(.01)
`, { mode: 0o755 });
  for (const name of ['aws', 'docker', 's5cmd', 'huggingface-cli', 'curl', 'python3', 'sleep']) fs.symlinkSync('fake', path.join(bin, name));
  // 기존 스크립트의 RED도 root 권한 없이 같은 실행 경로로 관찰한다.
  fs.writeFileSync(path.join(dir, 'boot.sh'), source.replace('/var/log/token-forge-boot.log', `${dir}/boot.log`).replace('/opt/dlami/nvme/models', `${dir}/models`).replace('/tmp/.complete', `${dir}/complete-marker`));
  if (extra.LOG_FAIL) fs.mkdirSync(path.join(dir, 'events.jsonl'));
  if (extra.UNEXPECTED || extra.SHORT_JOIN) fs.writeFileSync(path.join(bin, 'sitecustomize.py'), `
import subprocess, threading, os
join = threading.Thread.join
def short_join(self, timeout=None):
 return join(self, .1 if timeout == 18 and os.environ.get('SHORT_JOIN') else timeout)
threading.Thread.join = short_join
original = subprocess.Popen
def injected(args, *a, **kw):
 if args[-1] == 'start_container' and os.environ.get('UNEXPECTED'): raise OSError('DO_NOT_LOG_SECRET')
 return original(args, *a, **kw)
subprocess.Popen = injected
`);
  const p = spawn('bash', [path.join(dir, 'boot.sh')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: dir, PYTHONPATH: extra.UNEXPECTED || extra.SHORT_JOIN ? bin : '',
    TKF_BOOT_DIR: dir, TKF_MODEL_ROOT: `${dir}/models`, TKF_BOOT_TIMEOUT: '4', TKF_HEALTH_TIMEOUT: '.3', TKF_RETRY_DELAY: '0', ...extra } });
  let output = ''; p.stdout.on('data', x => output += x); p.stderr.on('data', x => output += x);
  const done = new Promise<number | null>(resolve => p.on('close', resolve));
  const events = () => fs.existsSync(`${dir}/events.jsonl`) ? fs.readFileSync(`${dir}/events.jsonl`, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
  return { dir, p, done, events, output: () => output, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('실제 shell: image와 weights가 gate를 서로 해제한 뒤 READY', async () => {
  const h = harness({ GATE: '1' });
  try {
    expect(await h.done).toBe(0);
    expect(h.events()).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'boot', status: 'ready' })]));
    expect(h.output()).not.toContain('DO_NOT_LOG_SECRET');
    const upload = JSON.parse(fs.readFileSync(`${h.dir}/upload.json`, 'utf8'));
    expect(upload.logEvents.length).toBeGreaterThan(5);
    const stamps = upload.logEvents.map((x: { timestamp: number }) => x.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(JSON.stringify(upload)).not.toContain('DO_NOT_LOG_SECRET');
  } finally { h.clean(); }
}, 15000);

async function waitFile(file: string) {
  for (let i = 0; i < 1000; i++) {
    if (fs.existsSync(file)) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('fixture gate not reached');
}
function noLongerExecuting(pid: number) {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.error) throw result.error;
  // The process may be reaped between kill(0) and ps. Do not hide permission/tool errors.
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return true;
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
  // A zombie has exited; only its parent (or init after reparenting) can reap it.
  return result.stdout.trim().startsWith('Z');
}

// A retained zombie cannot run, but kill(pid, 0) still finds its process-table entry.
test('cleanup liveness distinguishes running, zombie and reaped processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-liveness-'));
  const parent = spawn(python, ['-c', `
import os,time
from pathlib import Path
p=Path(${JSON.stringify(dir)})
child=os.fork()
if child==0:
 while not (p/'exit-child').exists(): time.sleep(.01)
 os._exit(0)
(p/'child').write_text(str(child))
deadline=time.monotonic()+5
while not (p/'reap').exists() and time.monotonic()<deadline: time.sleep(.01)
os.waitpid(child,0)
`]);
  const done = new Promise(resolve => parent.on('close', resolve));
  try {
    await waitFile(`${dir}/child`);
    const pid = Number(fs.readFileSync(`${dir}/child`, 'utf8'));
    expect(noLongerExecuting(pid)).toBe(false);
    fs.writeFileSync(`${dir}/exit-child`, '');
    let state = '';
    for (let i = 0; i < 100; i++) {
      state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (state.startsWith('Z')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    expect(state).toMatch(/^Z/);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(noLongerExecuting(pid)).toBe(true);
    fs.writeFileSync(`${dir}/reap`, '');
    await done;
    expect(noLongerExecuting(pid)).toBe(true);
  } finally {
    fs.writeFileSync(`${dir}/exit-child`, '');
    fs.writeFileSync(`${dir}/reap`, '');
    await done;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

test.each(['image', 'weights'])('%s 실패 시 다른 준비 그룹과 손자 정리', async fail => {
  const block = fail === 'image' ? 'weights' : 'image';
  const h = harness({ FAIL: fail, BLOCK: block, GATE: '1' });
  try {
    expect(await h.done).toBe(1);
    expect(fs.existsSync(`${h.dir}/container`)).toBe(false);
    expect(h.events().some(e => e.status === 'ready')).toBe(false);
    expect(fs.existsSync(`${h.dir}/child`)).toBe(true);
    if (fs.existsSync(`${h.dir}/child`)) {
      const pid = Number(fs.readFileSync(`${h.dir}/child`, 'utf8'));
      for (let i = 0; i < 30 && !noLongerExecuting(pid); i++) await new Promise(r => setTimeout(r, 20));
      expect(noLongerExecuting(pid)).toBe(true);
    }
  } finally { h.clean(); }
}, 15000);

test.each(['SIGINT', 'SIGTERM'] as const)('%s 취소 시 손자까지 종료', async signal => {
  const h = harness({ BLOCK: 'weights' });
  try {
    await waitFile(`${h.dir}/child`);
    const pid = Number(fs.readFileSync(`${h.dir}/child`, 'utf8'));
    h.p.kill(signal);
    const code = await h.done;
    if (code !== (signal === 'SIGINT' ? 130 : 143)) console.error(h.output());
    expect(code).toBe(signal === 'SIGINT' ? 130 : 143);
    for (let i = 0; i < 30 && !noLongerExecuting(pid); i++) await new Promise(r => setTimeout(r, 20));
    expect(noLongerExecuting(pid)).toBe(true);
    expect(h.events()).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'boot', status: 'cancelled' })]));
  } finally { h.clean(); }
}, 15000);

test.each([
  [{ LOCAL: '1' }, 'ready'],
  [{ MISS: '1' }, 'ready'],
  [{ MISS: '1', HF_FAIL: '1' }, 'failed'],
  [{ HEALTH_FAIL: '1' }, 'timeout'],
  [{ RUN_FAIL: '1' }, 'failed'],
  [{ TKF_BOOT_MODE: 'serial' }, 'ready'],
  [{ UPLOAD_FAIL: '1' }, 'ready'],
  [{ REJECT: '1' }, 'ready'],
  [{ UPLOAD_HANG: '1' }, 'ready'],
  [{ RUN_FAIL: '1', UPLOAD_FAIL: '1' }, 'failed'],
  [{ BLOCK: 'weights', TKF_BOOT_TIMEOUT: '.4' }, 'timeout'],
] as Array<[Record<string, string>, string]>)('캐시/실패/직렬/전송: %j', async (env, status) => {
  const h = harness(env);
  try {
    expect(await h.done).toBe(status === 'ready' ? 0 : 1);
    expect(h.events()).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'boot', status })]));
    expect(h.output()).not.toContain('DO_NOT_LOG_SECRET');
    if (env.LOCAL) expect(fs.existsSync(`${h.dir}/image`)).toBe(false);
    if (env.MISS && !env.HF_FAIL) {
      expect(fs.existsSync(`${h.dir}/complete`)).toBe(true);
      expect(h.events()).toContainEqual(expect.objectContaining({ phase: 'weights', cache: 'miss' }));
    }
    if (env.HF_FAIL) {
      expect(fs.existsSync(`${h.dir}/complete`)).toBe(false);
      expect(fs.readFileSync(`${h.dir}/hf-attempts`, 'utf8')).toBe('xxx');
    }
    if (env.UPLOAD_FAIL || env.REJECT || env.UPLOAD_HANG) expect(h.events()).toContainEqual(expect.objectContaining({ phase: 'upload', status: 'failed' }));
    if (env.UPLOAD_HANG) {
      expect(noLongerExecuting(Number(fs.readFileSync(`${h.dir}/upload-pid`, 'utf8')))).toBe(true);
      expect(noLongerExecuting(Number(fs.readFileSync(`${h.dir}/upload-child`, 'utf8')))).toBe(true);
    }
    if (env.HEALTH_FAIL) expect(h.events()).toContainEqual(expect.objectContaining({ phase: 'container', status: 'complete' }));
  } finally { h.clean(); }
}, 15000);


test('진행 중 배치 전송과 READY가 겹쳐도 최종 배치를 다시 전송', async () => {
  const h = harness({ HOLD: 'weights', HOLD_UPLOAD: '1', TKF_BOOT_TIMEOUT: '12' });
  try {
    await waitFile(`${h.dir}/upload.json`);
    fs.writeFileSync(`${h.dir}/release`, '');
    for (let i = 0; i < 200 && !h.events().some(e => e.phase === 'boot' && e.status === 'ready'); i++)
      await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(`${h.dir}/release-upload`, '');
    expect(await h.done).toBe(0);
    const upload = JSON.parse(fs.readFileSync(`${h.dir}/upload.json`, 'utf8'));
    expect(upload.logEvents.map((e: { message: string }) => JSON.parse(e.message)))
      .toContainEqual(expect.objectContaining({ phase: 'boot', status: 'ready' }));
  } finally { h.clean(); }
}, 20000);


test.each(['STREAM_EXISTS', 'STREAM_LOST', 'STREAM_DENIED'])('스트림 오류 분류: %s', async mode => {
  const h = harness({ [mode]: '1' });
  try {
    expect(await h.done).toBe(0);
    expect(h.events()).toContainEqual(expect.objectContaining({ phase: 'upload', status: mode !== 'STREAM_DENIED' ? 'complete' : 'failed' }));
    expect(fs.existsSync(`${h.dir}/upload.json`)).toBe(mode !== 'STREAM_DENIED');
    expect(h.output()).not.toContain('DO_NOT_LOG_SECRET');
  } finally { h.clean(); }
}, 15000);

test('긴 부팅: 여러 전송의 CW 보고서와 host 보고서가 일치하고 자기 전송 없음', async () => {
  const h = harness({ HOLD: 'weights', TKF_BOOT_TIMEOUT: '25' });
  try {
    await waitFile(`${h.dir}/uploads.jsonl`);
    await new Promise(r => setTimeout(r, 5500));
    const before = fs.readFileSync(`${h.dir}/uploads.jsonl`, 'utf8').trim().split('\n');
    expect(before).toHaveLength(1);
    fs.writeFileSync(`${h.dir}/release`, '');
    expect(await h.done).toBe(0);
    const batches = fs.readFileSync(`${h.dir}/uploads.jsonl`, 'utf8').trim().split('\n').map(x => JSON.parse(x));
    expect(batches.length).toBeGreaterThan(1);
    const remote = batches.flatMap(b => b.logEvents);
    expect(remote.map(e => JSON.parse(e.message)).some(e => e.phase === 'upload')).toBe(false);
    const cw = bootReport(JSON.stringify({ events: remote })).boots[0];
    const host = bootReport(fs.readFileSync(`${h.dir}/events.jsonl`, 'utf8')).boots[0];
    expect(cw.status).toBe('ready'); expect(host.status).toBe('ready');
    expect(cw.observedHostToReadyMs).toBe(host.observedHostToReadyMs);
    const missing = remote.filter(e => JSON.parse(e.message).seq !== 2);
    expect(bootReport(JSON.stringify({ events: missing })).boots[0].status).toBe('incomplete');
  } finally { h.clean(); }
}, 30000);

test('실패 이벤트에 확인한 cache와 안전한 exit code 유지', async () => {
  const h = harness({ FAIL: 'image', GATE: '1' });
  try {
    expect(await h.done).toBe(1);
    expect(h.events()).toContainEqual(expect.objectContaining({ phase: 'image', status: 'failed', cache: 'miss', exit_code: 7 }));
  } finally { h.clean(); }
}, 15000);

test.each([{ TKF_BOOT_MODE: 'serial' }, { LOCAL: '1' }] as Record<string, string>[])('준비 취소 뒤 supervisor/손자 종료: %j', async env => {
  const h = harness({ ...env, BLOCK: 'weights' });
  try {
    await waitFile(`${h.dir}/child`); const pid = Number(fs.readFileSync(`${h.dir}/child`, 'utf8'));
    h.p.kill('SIGTERM'); expect(await h.done).toBe(143);
    for (let i = 0; i < 30 && !noLongerExecuting(pid); i++) await new Promise(r => setTimeout(r, 20));
    expect(noLongerExecuting(pid)).toBe(true); expect(noLongerExecuting(h.p.pid!)).toBe(true);
  } finally { h.clean(); }
}, 15000);

test('unexpected subprocess 예외 원문과 secret 비노출', async () => {
  const h = harness({ UNEXPECTED: '1' });
  try {
    expect(await h.done).toBe(1);
    expect(h.output()).not.toContain('DO_NOT_LOG_SECRET'); expect(h.output()).not.toContain('Traceback');
    expect(h.events()).toContainEqual(expect.objectContaining({ phase: 'boot', status: 'failed' }));
    expect(fs.readFileSync(`${h.dir}/uploads.jsonl`, 'utf8')).not.toContain('DO_NOT_LOG_SECRET');
  } finally { h.clean(); }
}, 15000);

test('로컬 로그 쓰기 실패는 고정 진단을 내고 serving과 원격 이벤트 유지', async () => {
  const h = harness({ LOG_FAIL: '1' });
  try {
    expect(await h.done).toBe(0);
    expect(h.output()).toContain('TKF_LOCAL_LOG_WRITE_FAILED'); expect(h.output()).not.toContain('Traceback');
    const batches = fs.readFileSync(`${h.dir}/uploads.jsonl`, 'utf8').trim().split('\n').map(x => JSON.parse(x));
    expect(bootReport(JSON.stringify({ events: batches.flatMap(b => b.logEvents) })).boots[0].status).toBe('ready');
  } finally { h.clean(); }
}, 15000);


test.each([{ ORPHAN: 'weights', TKF_BOOT_MODE: 'serial' }, { ORPHAN: 'weights', LOCAL: '1' }] as Record<string, string>[])('준비 helper가 먼저 종료해도 손자를 정리: %j', async env => {
  const h = harness(env);
  try {
    expect(await h.done).toBe(0); const pid = Number(fs.readFileSync(`${h.dir}/child`, 'utf8'));
    for (let i = 0; i < 30 && !noLongerExecuting(pid); i++) await new Promise(r => setTimeout(r, 20));
    expect(noLongerExecuting(pid)).toBe(true);
  } finally { h.clean(); }
}, 15000);

test('종료 join deadline에서 uploader 그룹/손자를 죽이고 회수', async () => {
  const h = harness({ HOLD: 'weights', UPLOAD_HANG: '1', SHORT_JOIN: '1', TKF_BOOT_TIMEOUT: '15' });
  try {
    await waitFile(`${h.dir}/upload-child`); fs.writeFileSync(`${h.dir}/release`, '');
    expect(await h.done).toBe(0);
    expect(noLongerExecuting(Number(fs.readFileSync(`${h.dir}/upload-pid`, 'utf8')))).toBe(true);
    const pid = Number(fs.readFileSync(`${h.dir}/upload-child`, 'utf8'));
    for (let i = 0; i < 30 && !noLongerExecuting(pid); i++) await new Promise(r => setTimeout(r, 20));
    expect(noLongerExecuting(pid)).toBe(true);
    expect(h.events()).toContainEqual(expect.objectContaining({ phase: 'upload', status: 'timeout' }));
  } finally { h.clean(); }
}, 20000);

test('하이픈으로 시작하는 API 키도 옵션이 아닌 값으로 전달한다', async () => {
  const h = harness({ DASH_KEY: '1' });
  try {
    expect(await h.done).toBe(0);
    expect(h.events()).toContainEqual(expect.objectContaining({ phase: 'boot', status: 'ready' }));
    expect(h.output()).not.toContain('DO_NOT_LOG_SECRET');
  } finally { h.clean(); }
}, 15000);

test('vLLM 시작 인자의 비밀은 기록하지 않고 compile 로그는 유지한다', async () => {
  const h = harness({ LOCAL: '1' });
  try {
    expect(await h.done).toBe(0);
    const config = `${h.dir}/vllm-logging.json`;
    expect(fs.existsSync(config)).toBe(true);
    const r = spawnSync(python, ['-c', `import json,logging,logging.config,sys
logging.config.dictConfig(json.load(open(sys.argv[1])))
for name in ['vllm.entrypoints.serve.utils.api_utils','vllm.entrypoints.openai.api_server','vllm.entrypoints.utils']:
 logging.getLogger(name).info('DO_NOT_LOG_SECRET')
logging.getLogger('vllm.compilation.backends').info('compile-cache-observed')`, config], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('DO_NOT_LOG_SECRET');
    expect(r.stdout + r.stderr).toContain('compile-cache-observed');
  } finally { h.clean(); }
}, 15000);

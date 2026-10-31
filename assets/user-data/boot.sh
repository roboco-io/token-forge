#!/usr/bin/env bash
# CDK placeholder 계약: 기존 7개 + __BOOT_LOG_GROUP__.
set -euo pipefail
umask 077
REGION="__REGION__"
SECRET_ARN="__API_KEY_SECRET_ARN__"
BUCKET="__WEIGHTS_BUCKET__"
WEIGHTS_REPO="__WEIGHTS_REPO__"
VLLM_IMAGE="__VLLM_IMAGE__"
VLLM_FLAGS="__VLLM_FLAGS__"
MAX_MODEL_LEN="__MAX_MODEL_LEN__"

BOOT_LOG_GROUP="__BOOT_LOG_GROUP__"
export REGION SECRET_ARN BUCKET WEIGHTS_REPO VLLM_IMAGE VLLM_FLAGS MAX_MODEL_LEN BOOT_LOG_GROUP
MODEL_KEY="${WEIGHTS_REPO//\//_}"
MODEL_DIR="${TKF_MODEL_ROOT:-/opt/dlami/nvme/models}/${MODEL_KEY}"
export MODEL_KEY MODEL_DIR
prepare_weights() {
  mkdir -p "${MODEL_DIR}"
  if ! command -v s5cmd >/dev/null 2>&1; then
    curl -fsSL https://github.com/peak/s5cmd/releases/download/v2.3.0/s5cmd_2.3.0_Linux-64bit.tar.gz \
      | tar -xz -C /usr/local/bin s5cmd
  fi
# --- 가중치 로드: S3 캐시 우선, 없으면 HF 다운로드 후 시딩 ---
if aws s3api head-object --bucket "${BUCKET}" --key "${MODEL_KEY}/.complete" \
    --region "${REGION}" >/dev/null 2>&1; then
  echo hit > "${CACHE_FILE}"
  s5cmd cp "s3://${BUCKET}/${MODEL_KEY}/*" "${MODEL_DIR}/"
else
  echo miss > "${CACHE_FILE}"
  python3 -m pip install --quiet "huggingface_hub[cli]>=0.30,<1.0"
  ok=""
  for attempt in 1 2 3; do
    if huggingface-cli download "${WEIGHTS_REPO}" --local-dir "${MODEL_DIR}"; then
      ok=1; break
    fi
    echo "HF download attempt ${attempt} failed; retrying in 30s"
    sleep "${TKF_RETRY_DELAY:-30}"
  done
  if [ -z "${ok}" ]; then
    echo "HF download failed after 3 attempts — leaving instance unhealthy"
    exit 1
  fi
  echo "Seeding S3 cache"
  s5cmd cp "${MODEL_DIR}/" "s3://${BUCKET}/${MODEL_KEY}/"
  date > "${CACHE_FILE}.complete"
  aws s3 cp "${CACHE_FILE}.complete" "s3://${BUCKET}/${MODEL_KEY}/.complete" --region "${REGION}"
fi

}
prepare_image() {
  if docker image inspect "${VLLM_IMAGE}" >/dev/null 2>&1; then
    echo hit > "${IMAGE_CACHE_FILE}"
  else
    echo miss > "${IMAGE_CACHE_FILE}"
    docker pull "${VLLM_IMAGE}"
  fi
}
start_container() {
  LOG_CONFIG="${TKF_BOOT_DIR:-/run/token-forge}/vllm-logging.json"
  mkdir -p "$(dirname "$LOG_CONFIG")"
  # vLLM 0.27.1 logs api_key in INFO non-default arguments. Keep compiler telemetry.
  cat > "$LOG_CONFIG" <<'LOGCFG'
{"version":1,"disable_existing_loggers":false,"formatters":{"plain":{"format":"%(levelname)s [%(name)s] %(message)s"}},"handlers":{"console":{"class":"logging.StreamHandler","formatter":"plain","stream":"ext://sys.stdout"}},"loggers":{"vllm":{"handlers":["console"],"level":"INFO","propagate":false},"vllm.entrypoints.serve.utils.api_utils":{"level":"WARNING"},"vllm.entrypoints.openai.api_server":{"level":"WARNING"},"vllm.entrypoints.utils":{"level":"WARNING"}}}
LOGCFG
  API_KEY=$(aws secretsmanager get-secret-value --region "${REGION}" \
    --secret-id "${SECRET_ARN}" --query SecretString --output text)
docker rm -f vllm >/dev/null 2>&1 || true
# shellcheck disable=SC2086  # VLLM_FLAGS는 의도적으로 워드 스플릿
docker run -d --name vllm --restart always --gpus all \
  -v "$LOG_CONFIG:/etc/token-forge-vllm-logging.json:ro" \
  -e VLLM_LOGGING_CONFIG_PATH=/etc/token-forge-vllm-logging.json \
  --shm-size 32g -p 8000:8000 \
  -v "${MODEL_DIR}:/model" \
  --log-driver awslogs \
  --log-opt awslogs-region="${REGION}" \
  --log-opt awslogs-group=/token-forge/vllm \
  --log-opt awslogs-create-group=true \
  "${VLLM_IMAGE}" \
  --model /model \
  --served-model-name "${WEIGHTS_REPO}" \
  --max-model-len "${MAX_MODEL_LEN}" \
  --api-key="${API_KEY}" \
  ${VLLM_FLAGS}

}
export -f prepare_weights prepare_image start_container
# 표준 라이브러리만 사용. 별도 호스트 helper/에이전트 설치 없음.
exec python3 - <<'PYBOOT'
import json, math, os, signal, subprocess, sys, tempfile, threading, time, uuid
from pathlib import Path

origin = time.monotonic()
boot_id = str(uuid.uuid4())
root = Path(os.environ.get('TKF_BOOT_DIR', '/var/log/token-forge'))
try: root.mkdir(parents=True, exist_ok=True)
except OSError: pass
work = tempfile.TemporaryDirectory(prefix='tkf-boot-')
os.environ['CACHE_FILE'] = work.name + '/weights'
os.environ['IMAGE_CACHE_FILE'] = work.name + '/image'
records, active, starts = [], {}, {}
cache_seen = {}
telemetry_seq = 0
log_failed = False
lock, wake, stop = threading.Lock(), threading.Event(), threading.Event()
cancel = 0
upload_lock, upload_abort = threading.Lock(), threading.Event()
upload_process = None

def event(phase, status, cache=None, exit_code=None):
    global telemetry_seq, log_failed
    with lock:
        now = time.monotonic()
        e = dict(v=1, boot_id=boot_id, seq=len(records), timestamp_ms=int(time.time()*1000),
                 elapsed_ms=round((now-origin)*1000), phase=phase, status=status)
        if phase == 'upload':
            e.update(stream='telemetry', seq=telemetry_seq)
            telemetry_seq += 1
        if status == 'start': starts[phase] = now
        elif phase in starts: e['duration_ms'] = round((now-starts[phase])*1000)
        cache = cache or cache_seen.get(phase)
        if cache in ('hit', 'miss'): e['cache'] = cache
        if exit_code is not None: e['exit_code'] = exit_code
        if phase != 'upload': records.append(e)
        try:
            with (root/'events.jsonl').open('a') as f: f.write(json.dumps(e)+'\n')
        except OSError:
            if not log_failed:
                try: print('TKF_LOCAL_LOG_WRITE_FAILED', file=sys.stderr, flush=True)
                except OSError: pass
                log_failed = True
    # stdout 역시 고정 필드만. 명령 출력/인자/키는 기록하지 않는다.
    try: print(json.dumps(e), flush=True)
    except OSError: pass

def limit(name, default):
    n = float(os.environ.get(name, default))
    if not math.isfinite(n) or n <= 0 or n > 1800: raise ValueError()
    return n

def group_kill(p, sig):
    for attempt in range(20):
        try:
            os.killpg(p.pid, sig)
            return
        except ProcessLookupError: return
        except PermissionError:
            # macOS는 zombie-only 그룹에 ESRCH 대신 EPERM을 반환할 수 있다.
            # 리더를 reap한 뒤 재확인한다. 실제 권한 오류는 숨기지 않는다.
            p.poll()
            time.sleep(.01)
    raise PermissionError('process group cleanup failed')

def cleanup():
    for p in active.values(): group_kill(p, signal.SIGTERM)
    if active: time.sleep(.1)
    for p in active.values():
        group_kill(p, signal.SIGKILL)
        p.wait()
    active.clear()

def launch(phase, command):
    event(phase, 'start')
    active[phase] = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True)

def observe_cache():
    for phase in ('weights', 'image'):
        file = Path(work.name)/phase
        if phase not in cache_seen and file.exists():
            value = file.read_text().strip()
            if value in ('hit', 'miss'):
                event(phase, 'cache', value)
                cache_seen[phase] = value

def await_jobs(deadline):
    while active:
        observe_cache()
        if cancel: raise InterruptedError()
        if time.monotonic() >= deadline: raise TimeoutError()
        for phase, p in list(active.items()):
            code = p.poll()
            if code is None: continue
            group_kill(p, signal.SIGKILL)  # 종료한 리더가 남긴 자손도 정리
            p.wait()
            del active[phase]
            observe_cache()
            event(phase, 'complete' if code == 0 else 'failed', exit_code=code)
            if code != 0: raise RuntimeError()
        if active: time.sleep(.05)

def aws_logs(args):
    global upload_process
    with upload_lock:
        if upload_abort.is_set(): raise RuntimeError()
        p = subprocess.Popen(['aws', 'logs']+args+['--region', os.environ['REGION'],
            '--cli-connect-timeout', '2', '--cli-read-timeout', '3'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
            env={**os.environ, 'AWS_MAX_ATTEMPTS':'1', 'AWS_PAGER':''})
        upload_process = p
    try:
        out, err = p.communicate(timeout=4)
        if p.returncode != 0:
            # CLI 오류 원문은 출력하지 않는다. 이 작업의 정확한 오류 코드만 허용한다.
            if args[0] == 'create-log-stream' and b'An error occurred (ResourceAlreadyExistsException) when calling the CreateLogStream operation:' in err:
                return {}
            raise RuntimeError()
        return json.loads(out or '{}')
    finally:
        with upload_lock:
            group_kill(p, signal.SIGKILL)
            p.wait()
            upload_process = None

def uploader():
    cursor, created = 0, False
    while True:
        wake.wait(5); wake.clear()
        with lock: batch = records[cursor:]
        if batch:
            ok = False
            for attempt in range(2):
                try:
                    if not created:
                        aws_logs(['create-log-stream', '--log-group-name', os.environ['BOOT_LOG_GROUP'],
                                  '--log-stream-name', boot_id])
                        created = True
                    # 작은 배치: 최대 수십 이벤트. 시계가 24h 이상 튀면 각 이벤트를 별도 배치로 전송.
                    ordered = sorted(batch, key=lambda e:e['timestamp_ms'])
                    chunks = [ordered] if ordered[-1]['timestamp_ms']-ordered[0]['timestamp_ms'] < 86400000 else [[e] for e in ordered]
                    for chunk in chunks:
                        payload = dict(logGroupName=os.environ['BOOT_LOG_GROUP'], logStreamName=boot_id,
                            logEvents=[dict(timestamp=e['timestamp_ms'], message=json.dumps(e)) for e in chunk])
                        file = Path(work.name)/'upload.json'; file.write_text(json.dumps(payload))
                        result = aws_logs(['put-log-events', '--cli-input-json', 'file://'+str(file)])
                        if result.get('rejectedLogEventsInfo') or result.get('rejectedEntityInfo'): raise RuntimeError()
                    ok = True
                    break
                except Exception: pass
            # 전송 상태는 별도 순번의 호스트 전용 기록: core 큐에 넣지 않는다.
            cursor += len(batch)
            event('upload', 'complete' if ok else 'failed')
        if stop.is_set():
            with lock: pending = cursor < len(records)
            if not pending or upload_abort.is_set(): return
            wake.set()  # 주기 배치 도중 생성된 READY/실패 이벤트를 최종 flush

def on_signal(sig, frame):
    global cancel
    cancel = sig
signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)
event('boot', 'start')
thread = threading.Thread(target=uploader); thread.start()
code = 1
try:
    deadline = origin + limit('TKF_BOOT_TIMEOUT', '1800')
    health_limit = limit('TKF_HEALTH_TIMEOUT', '1200')
    mode = os.environ.get('TKF_BOOT_MODE', 'parallel')
    if mode not in ('serial', 'parallel'): raise ValueError()
    for phase, fn in [('weights', 'prepare_weights'), ('image', 'prepare_image')]:
        launch(phase, ['bash', '-euo', 'pipefail', '-c', fn])
        if mode == 'serial': await_jobs(deadline)
    await_jobs(deadline)
    observe_cache()
    launch('container', ['bash', '-euo', 'pipefail', '-c', 'start_container'])
    await_jobs(deadline)
    event('health', 'start')
    health_deadline = min(deadline, time.monotonic()+health_limit)
    while True:
        if cancel: raise InterruptedError()
        if time.monotonic() >= health_deadline: raise TimeoutError()
        # curl은 본문/헤더를 출력하지 않으며 /health에는 인증키를 보내지 않는다.
        p = subprocess.Popen(['curl', '-fsS', '--max-time', '2', '-o', '/dev/null',
            'http://127.0.0.1:8000/health'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        active['probe'] = p
        while p.poll() is None:
            if cancel: raise InterruptedError()
            if time.monotonic() >= health_deadline: raise TimeoutError()
            time.sleep(.05)
        group_kill(p, signal.SIGKILL); p.wait(); del active['probe']
        if p.returncode == 0:
            event('health', 'ready'); event('boot', 'ready'); code = 0; break
        time.sleep(min(.2, max(0, health_deadline-time.monotonic())))
except BaseException as error:
    status = 'cancelled' if cancel else 'timeout' if isinstance(error, TimeoutError) else 'failed'
    for phase in list(active):
        if phase != 'probe': event(phase, status)
    if 'health' in starts: event('health', status)
    event('boot', status)
    code = 128+cancel if cancel else 1
finally:
    cleanup()
    # READY는 먼저 기록된다. 업로드는 추론 기동 성공/원래 실패 코드를 덮지 않는다.
    stop.set(); wake.set(); thread.join(timeout=18)
    if thread.is_alive():
        with upload_lock:
            upload_abort.set()
            if upload_process is not None: group_kill(upload_process, signal.SIGKILL)
        wake.set(); thread.join()  # 새 subprocess 금지 + 현재 그룹 종료 후 스레드 회수
        event('upload', 'timeout')
    work.cleanup()
raise SystemExit(code)
PYBOOT

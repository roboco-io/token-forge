#!/usr/bin/env bash
# token-forge 부팅 스크립트 — CDK가 __PLACEHOLDER__를 치환해 user-data로 주입.
# 멱등: 재실행해도 안전 (설치·다운로드·컨테이너 기동 모두 존재 확인 후 수행).
set -euo pipefail
exec > >(tee -a /var/log/token-forge-boot.log) 2>&1

REGION="__REGION__"
SECRET_ARN="__API_KEY_SECRET_ARN__"
BUCKET="__WEIGHTS_BUCKET__"
WEIGHTS_REPO="__WEIGHTS_REPO__"
VLLM_IMAGE="__VLLM_IMAGE__"
VLLM_FLAGS="__VLLM_FLAGS__"
MAX_MODEL_LEN="__MAX_MODEL_LEN__"

MODEL_KEY="${WEIGHTS_REPO//\//_}"
# DLAMI가 인스턴스 스토어 NVMe를 /opt/dlami/nvme에 RAID0으로 마운트해 준다
MODEL_DIR="/opt/dlami/nvme/models/${MODEL_KEY}"
mkdir -p "${MODEL_DIR}"

# --- s5cmd 설치 (멱등) ---
if ! command -v s5cmd >/dev/null 2>&1; then
  curl -fsSL https://github.com/peak/s5cmd/releases/download/v2.3.0/s5cmd_2.3.0_Linux-64bit.tar.gz \
    | tar -xz -C /usr/local/bin s5cmd
fi

# --- API 키 조회 ---
API_KEY=$(aws secretsmanager get-secret-value --region "${REGION}" \
  --secret-id "${SECRET_ARN}" --query SecretString --output text)

# --- 가중치 로드: S3 캐시 우선, 없으면 HF 다운로드 후 시딩 ---
if aws s3api head-object --bucket "${BUCKET}" --key "${MODEL_KEY}/.complete" \
    --region "${REGION}" >/dev/null 2>&1; then
  echo "S3 cache hit — loading weights with s5cmd"
  s5cmd cp "s3://${BUCKET}/${MODEL_KEY}/*" "${MODEL_DIR}/"
else
  echo "S3 cache miss — downloading from Hugging Face"
  python3 -m pip install --quiet "huggingface_hub[cli]>=0.30,<1.0"
  ok=""
  for attempt in 1 2 3; do
    if huggingface-cli download "${WEIGHTS_REPO}" --local-dir "${MODEL_DIR}"; then
      ok=1; break
    fi
    echo "HF download attempt ${attempt} failed; retrying in 30s"
    sleep 30
  done
  if [ -z "${ok}" ]; then
    echo "HF download failed after 3 attempts — leaving instance unhealthy"
    exit 1
  fi
  echo "Seeding S3 cache"
  s5cmd cp "${MODEL_DIR}/" "s3://${BUCKET}/${MODEL_KEY}/"
  date > /tmp/.complete
  aws s3 cp /tmp/.complete "s3://${BUCKET}/${MODEL_KEY}/.complete" --region "${REGION}"
fi

# --- vLLM 컨테이너 기동 (멱등: 기존 컨테이너 제거 후 재기동) ---
docker rm -f vllm >/dev/null 2>&1 || true
# shellcheck disable=SC2086  # VLLM_FLAGS는 의도적으로 워드 스플릿
docker run -d --name vllm --restart always --gpus all \
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
  --api-key "${API_KEY}" \
  ${VLLM_FLAGS}

echo "boot.sh finished — waiting for vLLM /health via ALB health check"

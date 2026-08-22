#!/usr/bin/env bash
# 가중치 선시딩(웜업) — GPU를 켜기 전에 저가 CPU 인스턴스로 HF → S3 캐시를 채운다.
# 새 모델 온보딩 권장 순서:
#   1) cdk deploy -c model=<m> -c profile=<p> -c region=<r> -c minCapacity=0  # GPU 0대로 스택 생성
#   2) scripts/seed-weights.sh <stack-name> <region>                          # CPU 스팟이 S3 시딩 후 자동 종료
#   3) scripts/start.sh <stack-name> <region>                                 # GPU는 S3 캐시로 ~15분 내 서비스
# 사용법: seed-weights.sh <stack-name> <region> [instance-type]
#   instance-type은 NVMe 인스턴스 스토어 필수 (기본 c6id.4xlarge: 950GB NVMe, 스팟 ~$0.2/h)
set -euo pipefail

STACK="${1:?사용법: seed-weights.sh <stack-name> <region> [instance-type]}"
REGION="${2:?리전을 지정하세요}"
ITYPE="${3:-c6id.4xlarge}"

outputs=$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query 'Stacks[0].Outputs' --output json)
BUCKET=$(echo "${outputs}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='WeightsBucketName'))")
REPO=$(echo "${outputs}" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='WeightsRepo'))")
MODEL_KEY="${REPO//\//_}"

if aws s3api head-object --bucket "${BUCKET}" --key "${MODEL_KEY}/.complete" --region "${REGION}" >/dev/null 2>&1; then
  echo "OK: 이미 시딩 완료 — s3://${BUCKET}/${MODEL_KEY}"
  exit 0
fi

# 서빙 스택의 인스턴스 프로파일 재사용 (가중치 버킷 rw 권한 보유 — 별도 IAM 불필요)
IPROFILE=$(aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
  --query "StackResources[?ResourceType=='AWS::IAM::InstanceProfile'].PhysicalResourceId | [0]" --output text)
AMI=$(aws ssm get-parameter --region "${REGION}" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text)

UD=$(mktemp)
cat > "${UD}" <<EOF
#!/bin/bash
set -e
exec > /var/log/seed.log 2>&1
dnf install -y python3-pip xfsprogs
pip3 install -q 'huggingface_hub[cli,hf_transfer]'
curl -sL https://github.com/peak/s5cmd/releases/download/v2.2.2/s5cmd_2.2.2_Linux-64bit.tar.gz \
  | tar xz -C /usr/local/bin s5cmd
# 미사용 NVMe 인스턴스 스토어를 찾아 마운트
DEV=\$(lsblk -dno NAME,MOUNTPOINT /dev/nvme*n1 | awk '\$2=="" {print "/dev/"\$1; exit}')
mkfs.xfs -f "\${DEV}" && mkdir -p /mnt/w && mount "\${DEV}" /mnt/w
export HF_HUB_ENABLE_HF_TRANSFER=1
huggingface-cli download '${REPO}' --local-dir /mnt/w/m
rm -rf /mnt/w/m/.cache
s5cmd cp /mnt/w/m/ 's3://${BUCKET}/${MODEL_KEY}/'
date -u +%Y-%m-%dT%H:%M:%SZ > /tmp/.complete
aws s3 cp /tmp/.complete 's3://${BUCKET}/${MODEL_KEY}/.complete' --region '${REGION}'
shutdown -h now
EOF

echo "시더 기동: ${ITYPE} 스팟 (리포 ${REPO} → s3://${BUCKET}/${MODEL_KEY})"
IID=$(aws ec2 run-instances --region "${REGION}" --image-id "${AMI}" --instance-type "${ITYPE}" \
  --iam-instance-profile "Name=${IPROFILE}" \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time}' \
  --instance-initiated-shutdown-behavior terminate \
  --user-data "file://${UD}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=token-forge-seeder-${MODEL_KEY}}]" \
  --query 'Instances[0].InstanceId' --output text) || {
    echo "스팟 확보 실패 — 온디맨드로 재시도"
    IID=$(aws ec2 run-instances --region "${REGION}" --image-id "${AMI}" --instance-type "${ITYPE}" \
      --iam-instance-profile "Name=${IPROFILE}" \
      --instance-initiated-shutdown-behavior terminate \
      --user-data "file://${UD}" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=token-forge-seeder-${MODEL_KEY}}]" \
      --query 'Instances[0].InstanceId' --output text)
  }
rm -f "${UD}"
echo "시더 인스턴스: ${IID} — 완료 시 자동 종료됨. S3 .complete 마커 대기 (최대 3시간)"

for _ in $(seq 1 360); do
  if aws s3api head-object --bucket "${BUCKET}" --key "${MODEL_KEY}/.complete" --region "${REGION}" >/dev/null 2>&1; then
    echo "OK: 시딩 완료 — s3://${BUCKET}/${MODEL_KEY}. 이제 scripts/start.sh ${STACK} ${REGION} 로 기동하세요."
    exit 0
  fi
  state=$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${IID}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo unknown)
  if [ "${state}" = "terminated" ]; then
    echo "ERROR: 시더가 종료됐지만 .complete 마커가 없음 — 콘솔에서 /var/log/seed.log 확인 필요" >&2
    exit 1
  fi
  sleep 30
done
echo "ERROR: 3시간 내 미완료 — 시더(${IID}) 수동 확인/종료 필요: aws ec2 terminate-instances --instance-ids ${IID} --region ${REGION}" >&2
exit 1

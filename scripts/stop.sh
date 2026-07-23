#!/usr/bin/env bash
# 사용법: scripts/stop.sh <stack-name> [region]
# GPU 인스턴스를 내려 비용을 정지한다 (ALB/S3만 과금 유지). 재기동: scripts/start.sh
set -euo pipefail

STACK="${1:?usage: stop.sh <stack-name> [region]}"
REGION="${2:-us-east-2}"

ASG=$(aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
  --query "StackResources[?ResourceType=='AWS::AutoScaling::AutoScalingGroup'].PhysicalResourceId" \
  --output text)

aws autoscaling update-auto-scaling-group --auto-scaling-group-name "${ASG}" \
  --min-size 0 --desired-capacity 0 --region "${REGION}"
echo "OK: ${ASG} → desired=0 (GPU 비용 정지). 재기동: scripts/start.sh ${STACK} ${REGION}"

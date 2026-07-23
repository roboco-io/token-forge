#!/usr/bin/env bash
# 사용법: scripts/start.sh <stack-name> [region]
# 내려둔 GPU 인스턴스를 다시 올린다. S3 캐시가 있으면 부팅 수 분~15분.
set -euo pipefail

STACK="${1:?usage: start.sh <stack-name> [region]}"
REGION="${2:-us-east-2}"

ASG=$(aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
  --query "StackResources[?ResourceType=='AWS::AutoScaling::AutoScalingGroup'].PhysicalResourceId" \
  --output text)

aws autoscaling set-desired-capacity --auto-scaling-group-name "${ASG}" \
  --desired-capacity 1 --region "${REGION}"
echo "OK: ${ASG} → desired=1. ALB 타깃 healthy까지 대기 후 사용 (S3 캐시 시 수 분~15분)"

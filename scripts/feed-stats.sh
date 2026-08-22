#!/usr/bin/env bash
# 공개 대시보드·피드 이용량 확인 — CloudFront 요청 수 일별 집계 (기본 최근 14일)
# 사용법: scripts/feed-stats.sh [배포ID] [일수]
set -euo pipefail

DIST_ID="${1:-E20ZLBQK3LSD90}"
DAYS="${2:-14}"

# CloudFront 지표는 us-east-1 + Region=Global 디멘션 고정
aws cloudwatch get-metric-statistics \
  --region us-east-1 \
  --namespace AWS/CloudFront \
  --metric-name Requests \
  --dimensions Name=DistributionId,Value="${DIST_ID}" Name=Region,Value=Global \
  --start-time "$(date -u -v-"${DAYS}"d +%Y-%m-%dT00:00:00 2>/dev/null || date -u -d "-${DAYS} days" +%Y-%m-%dT00:00:00)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 86400 \
  --statistics Sum \
  --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' \
  --output text | awk '{printf "%s  %8d req\n", substr($1,1,10), $2}'

#!/usr/bin/env bash
# 사용법: scripts/smoke-test.sh https://<EndpointUrl 출력값> <api-key>
# 실 배포 후 수동 실행 (비용상 CI 제외)
set -euo pipefail

ENDPOINT="${1:?usage: smoke-test.sh <endpoint-url> <api-key>}"
API_KEY="${2:?api key required (aws secretsmanager get-secret-value ...)}"
AUTH=(-H "Authorization: Bearer ${API_KEY}")

echo "==> GET /v1/models"
MODELS_JSON=$(curl -fsS "${AUTH[@]}" "${ENDPOINT}/v1/models")
MODEL_ID=$(echo "${MODELS_JSON}" | jq -re '.data[0].id')
echo "    model: ${MODEL_ID}"

echo "==> POST /v1/chat/completions"
REPLY=$(curl -fsS "${AUTH[@]}" -H 'Content-Type: application/json' \
  "${ENDPOINT}/v1/chat/completions" \
  -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}],\"max_tokens\":32}")
echo "${REPLY}" | jq -re '.choices[0].message.content'

echo "PASS: endpoint is serving ${MODEL_ID}"

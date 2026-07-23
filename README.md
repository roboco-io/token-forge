# token-forge

Hugging Face 오픈소스 LLM을 AWS **스팟 인스턴스 기본**으로 서빙하는 AWS CDK 템플릿.
초기 타겟: [upstage/Solar-Open2-250B](https://huggingface.co/upstage/Solar-Open2-250B).

> **상태:** 설계 완료, 구현 진행 중 — [설계 문서](docs/superpowers/specs/2026-07-23-token-forge-design.md) 참고.

## 아키텍처

```
사용자 ──HTTP──> ALB ──> ASG(min1/max1, p5.48xlarge Spot, 멀티 AZ)
                             └─ EC2: DLAMI + Docker(upstage/vllm-solar-open2)
                                  ├─ 부팅: S3 가중치 캐시 → 없으면 HF 다운로드 후 S3 시딩
                                  └─ vLLM OpenAI 호환 서버 (--api-key = Secrets Manager)
```

## 사전 조건

- **p5 스팟 vCPU 쿼터 192개** — 대부분 계정 기본 0. Service Quotas에서
  "All P5 Spot Instance Requests" 상향 신청 필요.
- 비용 참고: p5.48xlarge 스팟 약 **$30~50/hr** (리전·시점 변동). 사용 후 `cdk destroy` 권장.
- Node 20+, AWS CDK CLI (`npm i -g aws-cdk`), 부트스트랩된 계정(`cdk bootstrap`).

## 배포

```bash
npm install
cdk deploy -c model=solar-open2-250b -c profile=int4 -c region=us-east-2
# 옵션: -c profile=bf16  -c alertEmail=you@example.com
```

첫 부팅은 HF 다운로드 + S3 시딩으로 오래 걸린다(INT4 ~150GB).
이후 재프로비저닝은 S3 캐시에서 s5cmd 로드로 단축(목표 ~15분).

## 사용

```bash
API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id <ApiKeySecretArn 출력값> --query SecretString --output text)
scripts/smoke-test.sh http://<EndpointUrl 출력값> "${API_KEY}"
```

OpenAI SDK: `base_url="http://<EndpointUrl>/v1"`, `api_key=${API_KEY}`.

## 새 모델 추가

`models/<model-name>.yaml` 1개 추가 → `cdk deploy -c model=<model-name> -c profile=<profile>`.
스키마는 `models/solar-open2-250b.yaml` 참고 (`vllmImage`, `profiles.<name>.{weightsRepo,instanceType,vllmFlags,maxModelLen}`).

## 트러블슈팅

| 증상 | 확인 |
|---|---|
| 30분 넘게 InService 0 (SNS 알람) | p5 스팟 쿼터/용량 부족. Service Quotas·다른 리전 검토 |
| 인스턴스가 계속 교체됨 | SSM 세션 접속 → `cat /var/log/token-forge-boot.log`, `docker logs vllm` (OOM 등) |
| 스팟 중단 알림 수신 | 정상 — ASG가 자동 재프로비저닝. S3 캐시로 ~15분 내 복구 |
| HF 다운로드 3회 실패 | 로그 확인 후 인스턴스 종료(ASG 교체) 또는 네트워크 점검 |

## 스코프 (YAGNI)

오토스케일링 없음(min1/max1), 웹 UI 없음, HTTPS는 도메인+ACM 필요로 향후 과제
(현재 HTTP + API 키 — 민감 데이터에는 사용 금지).

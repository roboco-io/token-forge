# token-forge

Hugging Face 오픈소스 LLM을 AWS **스팟 인스턴스 기본**으로 서빙하는 AWS CDK 템플릿.
초기 타겟: [upstage/Solar-Open2-250B](https://huggingface.co/upstage/Solar-Open2-250B).

> 설계 문서: [docs/superpowers/specs/2026-07-23-token-forge-design.md](docs/superpowers/specs/2026-07-23-token-forge-design.md)

## 아키텍처

```
사용자 ──HTTP──> ALB ──> ASG(min1/max1, p5.48xlarge Spot, 멀티 AZ)
                             └─ EC2: DLAMI + Docker(upstage/vllm-solar-open2)
                                  ├─ 부팅: S3 가중치 캐시 → 없으면 HF 다운로드 후 S3 시딩
                                  └─ vLLM OpenAI 호환 서버 (--api-key = Secrets Manager)
```

## 스팟 인텔리전스 공개 대시보드·데이터 피드

roboco가 상시 운영하는 **GPU 스팟 확보 가능성(배치점수) × 가격 공개 서비스**:

- **대시보드**: https://d16jdvzof4zpo7.cloudfront.net — p5·g6e 주요 타입의 리전/AZ별
  배치점수 추이, 스팟 가격, 요일×시간 히트맵, 가성비 랭킹 (1시간 주기 갱신, 90일 이력)
- **데이터 피드**: https://d16jdvzof4zpo7.cloudfront.net/data.json — CORS 전면 허용.
  스키마·이용법은 [docs/spot-feed.md](docs/spot-feed.md)

같은 수집기를 자기 계정에 직접 띄우려면 `cdk deploy -c collector=1` (별도 상시 스택).

## 사전 조건

- **p5 스팟 vCPU 쿼터 192개** — 대부분 계정 기본 0. Service Quotas에서
  "All P Spot Instance Requests"(L-7212CCBC) 상향 신청 필요. 신규 계정은 부분 승인이
  흔하므로 **[EC2 쿼터 증설 요청 가이드](docs/ec2-quota-guide.md)** 의 어필 문안 작성법 참고.
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
scripts/smoke-test.sh <EndpointUrl 출력값> "${API_KEY}"
```

OpenAI SDK: `base_url="<EndpointUrl>/v1"`, `api_key=${API_KEY}`.

## 새 모델 추가

`models/<model-name>.yaml` 1개 추가 → `cdk deploy -c model=<model-name> -c profile=<profile>`.
스키마는 `models/solar-open2-250b.yaml` 참고 (`vllmImage`, `profiles.<name>.{weightsRepo,instanceType,vllmFlags,maxModelLen}`).

## 트러블슈팅

| 증상 | 확인 |
|---|---|
| 30분 넘게 InService 0 (SNS 알람) | p5 스팟 쿼터/용량 부족. Service Quotas·다른 리전 검토 |
| 인스턴스가 계속 교체됨 | SSM 세션 접속 → `cat /var/log/token-forge-boot.log`, `docker logs vllm` (OOM 등). vLLM 컨테이너 로그는 CloudWatch Logs 그룹 `/token-forge/vllm`에서도 확인 가능 (인스턴스 종료 후에도 보존) |
| 스팟 중단 알림 수신 | 정상 — ASG가 자동 재프로비저닝. S3 캐시로 ~15분 내 복구 |
| HF 다운로드 3회 실패 | 로그 확인 후 인스턴스 종료(ASG 교체) 또는 네트워크 점검 |

## 비용 절감 (실험용 운영)

- **유휴 자동 셧다운(기본 켜짐)**: ALB 요청이 30분간 없으면 인스턴스를 자동으로 0대로 내리고 SNS로 알린다.
  간격 변경 `-c idleMinutes=60`, 비활성화 `-c idleMinutes=0`.
- **수동 온/오프**:
  ```bash
  scripts/stop.sh  <stack-name> <region>   # GPU 비용 정지 (ALB/S3만 유지, ~$16/월)
  scripts/start.sh <stack-name> <region>   # 재기동 — S3 캐시로 수 분~15분 내 서비스 복귀
  ```
- **장기 미사용**: `cdk destroy` 권장. S3 가중치 캐시는 Retain으로 남아 재배포 시 고속 부팅.

## 스코프 (YAGNI)

오토스케일링 없음(min1/max1), 웹 UI 없음, HTTPS는 도메인+ACM 필요로 향후 과제
(현재 HTTP + API 키 — 민감 데이터에는 사용 금지).

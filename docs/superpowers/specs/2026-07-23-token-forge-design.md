# token-forge 설계 문서

- 작성일: 2026-07-23
- 상태: 승인됨 (사용자 검토 완료)

## 1. 목적

Hugging Face의 오픈소스 LLM을 AWS에서 **스팟 인스턴스 기본**으로 손쉽게 서빙하는 **AWS CDK 기반 IaC 템플릿 모음**.
초기 타겟 모델은 [upstage/Solar-Open2-250B](https://huggingface.co/upstage/Solar-Open2-250B).

### 성공 기준

- `cdk deploy -c model=solar-open2-250b -c profile=int4` 한 번으로 OpenAI 호환 추론 엔드포인트가 뜬다.
- 스팟 중단 시 자동 재프로비저닝되어 수동 개입 없이 복구된다(다운타임 허용, 재기동 ~15분 목표).
- 새 모델 추가 = `models/` 프로파일 YAML 1개 추가.

### 스코프 제외 (YAGNI)

- 웹 콘솔/UI, 멀티 테넌시, 오토스케일링(min1/max1 고정), CDK Construct 라이브러리 npm 발행(추후 검토), SageMaker 경로.

## 2. 타겟 모델 스펙 (조사 결과, 2026-07 기준)

| 항목 | 값 |
|---|---|
| 아키텍처 | Hybrid-Attention MoE, 총 250B / 활성 15B, 48레이어(softmax 1 + linear 3 ×12), NoPE |
| 가중치 | BF16 약 501GB (safetensors 94개), `model_type: solar_open2` |
| 컨텍스트 | 최대 1M 토큰 (KV 캐시는 softmax 12레이어만) |
| vLLM | **Upstage 포크 필수** — Docker `upstage/vllm-solar-open2` (v0.22.0-solar-open2, CUDA 12.9). 업스트림 미병합 |
| 필수 플래그 | `--tensor-parallel-size 8 --enable-expert-parallel --moe-backend triton --reasoning-parser solar_open2 --tool-call-parser solar_open2 --enable-auto-tool-choice` |
| 라이선스 | Upstage Solar License (gated 아님, HF 토큰 불필요) |
| 양자화 | 공식 `nota-ai/Solar-Open2-250B-Nota-INT4` (~150GB, llm-compressor 포맷, vLLM 직접 서빙). NVFP4는 Blackwell 전용이라 제외 |
| 권장 GPU | 공식 최소 H200×4. AWS 현실 하한선: **p5.48xlarge (H100 80GB×8, HBM 640GB)** |

p4d(A100)는 포크 vLLM의 Ampere 지원 미검증, g6e(L40S)는 NVLink 부재로 TP8+EP 성능 급락 — 둘 다 비권장.

## 3. 확정된 설계 결정

| 결정 | 선택 | 근거 |
|---|---|---|
| 제공 형태 | IaC 템플릿 모음 (fork 후 직접 배포) | 사용자 선택 |
| IaC | AWS CDK (TypeScript) | 조건 분기·프로파일 로직 표현 용이 |
| 런타임 | EC2 Spot + vLLM 컨테이너 직접 구동 | 비용 투명성, 구성 단순 |
| 가용성 | ASG min1/max1, 재프로비저닝 허용 | 개발/데모/내부용, 비용 최소 |
| 기본 정밀도 | INT4 (Nota 공식 양자화), BF16은 프로파일 옵션 | 스팟 비용·확보율 |
| API 노출 | 퍼블릭 ALB + vLLM `--api-key` (Secrets Manager) | 재프로비저닝에도 엔드포인트 유지 |
| 가중치 로딩 | S3 캐시 (최초 1회 HF→S3 시딩, 이후 s5cmd 고속 로드) | 부팅 시간·HF 의존 제거 |
| 리전 | us-east-2 기본, `-c region=` 파라미터화 | p5 스팟 풀 고려 |
| 프로젝트 구조 | 단일 CDK 앱 + 모델 프로파일 YAML | 확장 용이, 구현 단순 |

## 4. 아키텍처

```
사용자 ──HTTPS──> ALB ──> ASG(min1/max1, p5.48xlarge Spot, 멀티 AZ)
                              └─ EC2: DLAMI + Docker(upstage/vllm-solar-open2)
                                   ├─ 부팅: S3 가중치 캐시 → 없으면 HF 다운로드 후 S3 미러링
                                   └─ vLLM OpenAI 호환 서버 (--api-key = Secrets Manager)
```

### 컴포넌트 (단일 스택 `TokenForgeStack`)

1. **모델 프로파일** (`models/solar-open2-250b.yaml`)
   - HF repo ID, 프로파일별 변형: `int4` → `nota-ai/Solar-Open2-250B-Nota-INT4` + p5.48xlarge / `bf16` → 원본 repo + p5.48xlarge
   - vLLM 이미지·플래그, 컨텍스트 길이 캡(기본 128K — 1M 풀 컨텍스트는 메모리상 제한 필요)
2. **네트워크**: VPC 퍼블릭 서브넷 전 AZ 커버(스팟 확보율 극대화), ALB + 타깃 그룹(`/health`, health check grace period 20분)
3. **컴퓨트**: Launch Template(스팟 옵션, DLAMI GPU AMI) + ASG min1/max1. 중단 시 ASG 자동 교체
4. **스토리지**: S3 버킷(가중치 캐시). 부팅 스크립트가 캐시 확인 → 있으면 s5cmd 로드(수 분) / 없으면 HF 다운로드 후 S3 시딩
5. **보안**: API 키 Secrets Manager 자동 생성·주입. SG는 ALB→인스턴스 8000 포트만 허용
6. **알림**: EventBridge 스팟 중단 경고 → SNS 토픽(이메일 구독 옵션)

### 배포 인터페이스

```bash
cdk deploy -c model=solar-open2-250b -c profile=int4 -c region=us-east-2
```

### 사전 조건 (README 명시)

- p5 스팟 vCPU 쿼터 192개 신청 필요(기본 0인 계정 대부분)
- 비용 참고: p5.48xlarge 스팟 약 $30~50/hr (리전·시점 변동)

## 5. 데이터 흐름 (부팅 스크립트, 멱등)

1. Secrets Manager에서 API 키 조회
2. S3 캐시 확인 → 있으면 `s5cmd cp`로 로컬 NVMe에 로드 / 없으면 `hf download` 후 S3 업로드
3. `docker run upstage/vllm-solar-open2` — 프로파일 플래그 + `--api-key` 주입, `--restart always`
4. vLLM `/health` 200 → ALB 타깃 healthy → 서비스 개시

## 6. 에러 처리

| 상황 | 대응 |
|---|---|
| 스팟 쿼터 0 / 용량 부족 | ASG 재시도 지속. InService=0이 30분 지속 시 CloudWatch 알람 → SNS |
| 스팟 중단(2분 경고) | EventBridge → SNS 알림. ASG 자동 재프로비저닝 |
| 모델 로딩 실패(OOM 등) | CloudWatch Logs로 로그 전송, 헬스체크 실패 시 ASG 교체. 무한 루프 시 로그 확인 절차 README 명시 |
| HF 다운로드 실패 | 3회 재시도 후 실패 로그, 인스턴스 unhealthy 처리 |

## 7. 테스트

- **유닛**: 프로파일 YAML 파서 + CDK assertions(스팟 옵션·ASG 설정·SG 규칙 검증)
- **스모크**: `scripts/smoke-test.sh` — `/v1/models`, `/v1/chat/completions` 응답 검증
- 실 배포 통합 테스트는 비용상 CI 제외, 수동 스크립트로 제공

## 8. 리포지토리 구성

```
token-forge/
├─ bin/, lib/          # CDK 앱·스택
├─ models/             # 모델 프로파일 YAML
├─ assets/user-data/   # 부팅 스크립트
├─ scripts/            # smoke-test 등
└─ test/               # CDK 유닛 테스트
```

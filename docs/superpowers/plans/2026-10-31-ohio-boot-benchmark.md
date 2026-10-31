# Ohio 부팅 병렬화 실험 — 2026-10-31

## 결과

parallel과 serial을 새 인스턴스에서 각각 한 번 실행했다. 두 실행의 상태와 시간은 다음과 같다.

| 실행 | 상태 | Launch→READY(초) | boot.start→READY(초) | Launch→READY 비용 proxy(USD) |
|---|---|---:|---:|---:|
| parallel | ready | 477.441 | 411.974 | 0.705141 |
| serial | ready | 483.627 | 423.650 | 0.714277 |

이번 한 쌍의 serial−parallel 차이는 Launch→READY **6.186초**, host→READY **11.676초**다. 1회쌍이므로 통계적 절감률을 주장하지 않는다.

## 조건과 한계

- Ohio, 같은 us-east-2c AZ. g6e.12xlarge Spot, 최대 단가 $6/h, 동시에 GPU 1대. 총 GPU 기동 2회. CPU는 c6id.4xlarge Spot, 최대 단가 $0.50/h.
- 동일 DLAMI·HF revision·이미지 digest·모델 프로파일을 사용했다. fresh root gp3 200GiB, 3000 IOPS, 125MiB/s, fresh NVMe 조건이다. 실제 호스트 GPU·드라이버·마운트·RepoDigest 및 EBS API 응답은 로컬 근거에 보존했다.
- Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8, vllm/vllm-openai:v0.27.1, TP4/EP·tool parser·prefix caching·maxModelLen 131072 유지.
- 제품 boot.sh 원문을 유지하고 8개 placeholder를 scoped 리소스로 치환했다. 실행 모드는 TKF_BOOT_MODE만 달리 지정했다. TKF_BOOT_TIMEOUT=1200, TKF_HEALTH_TIMEOUT=900, 독립 25분 종료 타이머를 사용했다.
- parallel 종료 확인 timeout 때문에 원래 제어기가 serial을 건너뛰었다. 부팅 실패가 아닌 정리/제어 흐름 실패다. 기존 parallel 477.441초와 추론 성공을 보존하고, 후속 승인에 따라 serial만 한 번 재개했다. 제품 소스는 변경하지 않았다.
- 원래 임시 버킷은 이미 삭제됐으므로 CPU Spot 1대를 추가 사용해 새 private 버킷에 동일 revision을 다시 시딩했다. S3 모델 prefix는 동일하며 모델 파일 Size·ETag는 기존 캐시와 일치했다. 버킷과 실행 시각은 다르다.
- 새 AMI 인스턴스에서 두 실행 모두 weights hit / image miss 조건을 확인했다. 네트워크·Spot 호스트 변동이 포함된 1회쌍이다. 단계 시간의 합으로 전체 시간을 만들지 않는다.
- serial은 새 계측 코드의 직렬 control이며 v1.1.0 바이너리 실측이 아니다. 과거 8분과 직접 비교하지 않는다.

HF revision: `dcaee4d4dfc5ee71ad501f01f530e5652438fde0`. 이미지 digest: `sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967`.

Rendered user-data: parallel 13644 bytes, serial 13642 bytes. 모두 16KiB 이내.

## 단계별 관측

| 실행 | weights(초) | image(초) | container(초) | health(초) | 준비 중첩(초) |
|---|---:|---:|---:|---:|---:|
| parallel | 30.388 | 150.858 | 117.070 | 144.044 | 30.387 |
| serial | 29.928 | 138.513 | 112.168 | 143.039 | 0.000 |

parallel의 가중치 준비는 이미지 준비와 겹쳤다. 이미지 준비와 컨테이너·모델 초기화가 주요 대기 구간이다. 각 구간의 실제 변동도 전체 차이에 포함되므로 중첩 시간만을 실제 절감으로 해석하지 않는다.

## 주요 시각과 추론

| 실행 | LaunchTime(UTC) | boot.start(UTC) | READY(UTC) | 종료 요청(UTC) | terminated 관측(UTC) |
|---|---|---|---|---|---|
| parallel | 2026-10-31 08:20:20+00:00 | 2026-10-31T08:21:25.467000+00:00 | 2026-10-31T08:28:17.441000+00:00 | 2026-10-31T08:28:31.394187+00:00 | 2026-10-31T08:35:49.079692+00:00 |
| serial | 2026-10-31 08:42:56+00:00 | 2026-10-31T08:43:55.977000+00:00 | 2026-10-31T08:50:59.627000+00:00 | 2026-10-31T08:51:12.177700+00:00 | 2026-10-31T08:58:01.277919+00:00 |

parallel 추론 SSM 상태: Success. 결과: `{"success": true, "request_latency_seconds": 0.12922150200000715, "usage": {"prompt_tokens": 14, "total_tokens": 17, "completion_tokens": 3, "prompt_tokens_details": null}}`.

serial 추론 SSM 상태: Success. 결과: `{"success": true, "request_latency_seconds": 0.12804900399999042, "usage": {"prompt_tokens": 14, "total_tokens": 17, "completion_tokens": 3, "prompt_tokens_details": null}}`.

공개 prompt로 max_tokens=16의 짧은 요청을 보냈다. latency는 전체 요청 시간이며 TTFT가 아니다. health READY와 실제 추론 성공을 따로 확인했다.

terminated 시각은 관측 근거이며 정확한 상태 전환 시각이 아니다. parallel의 표기 시각은 최초 정리 완료 로그에서 얻은 보수적인 관측 상한이다. parallel은 최초 종료 요청 후 지연됐고 부모가 소유권을 확인해 Force/SkipOsShutdown 종료를 요청했다. serial도 자료 수집 후 소유권 검사와 Force/SkipOsShutdown을 사용했다. 이 조치는 READY 시각에 영향을 주지 않는다.

## 비용 proxy와 정리

| 실행 | 관측 단가(USD/h) | Launch→종료 요청(초) | 해당 구간 비용 proxy(USD) |
|---|---:|---:|---:|
| seed | 0.246 | 138.848 | 0.009488 |
| parallel | 5.3169 | 491.394 | 0.725748 |
| seed-resume | 0.2289 | 138.549 | 0.008809 |
| serial | 5.3169 | 496.178 | 0.732813 |

비용은 명시한 벽시계 구간 × 고정 관측 Spot 단가인 proxy다. pending 보정·청구 단위·가격 변동을 반영한 실제 과금 시간이나 청구액이 아니다. 종료 관측까지의 대기시간은 비용에 포함하지 않는다. AWS는 shutting-down을 미과금으로 명시한다: [EC2 lifecycle](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html). CPU 비용은 별도로 표시했다. S3·CloudWatch Logs·EBS·전송·Secret 비용은 미포함이며 0으로 가정하지 않는다.

독립 정리 검증: **22개 항목 모두 정리 확인**. 모든 실험 소유 인스턴스는 terminated, Spot 요청은 종료 상태이며 ENI·EBS·SG·IAM profile/role·Secret·S3·로그 그룹 잔존 여부를 API로 재조회했다. Ohio 활성 인스턴스는 0대다. 기존 VPC/subnet과 다른 지역 리소스는 변경하지 않았다.

종료 후 CloudWatch 마지막 READY 이벤트를 다시 읽고 로컬에 저장한 뒤 임시 로그 그룹과 캐시를 삭제했다. 공개 문서에는 계정 ID·임시 리소스 ID·Secret ARN·개인 경로를 넣지 않는다.

## 근거와 Ralph 검토

비공개 실험 디렉터리의 result.json은 두 실행과 모든 cleanup 결과를 통합한다. 기존 parallel 근거는 유지하고 serial-resume 하위에 별도 controller·manifest·API·진행·부팅·추론·종료 후 로그를 보존했다. owned-resources.json은 두 준비 과정의 생성물을 모두 기록한다.

첫 반복은 parallel 실험·정리·기록, 두 번째는 읽기 재검토였다. 세 번째는 부모의 후속 승인으로 누락된 serial만 실행했다. 제어기의 소유권 기반 종료와 미소유 거부에 대한 집중 모의 검증 2건을 통과했다. 제품 bootReport로 두 이벤트를 재분석해 경고 없이 ready와 동일한 시간을 확인했다. 실제 Codex 마지막 응답은 실행 중인 어댑터가 official Ralph Stop hook에 전달한다. 이 문서는 아직 반환되지 않은 hook 결과를 성공으로 주장하지 않는다.


## 4차 분석: 실제 병목과 다음 변경 (2026-10-31)

추가 GPU를 기동하기 전에 보존된 호스트·vLLM 로그와 삭제된 두 루트 볼륨의 CloudWatch 이력을 분석했다. 다음 수치는 위 parallel 실행 기준이며, 비용 청구 구간이 아닌 성능 분석 구간이다.

| 임계 경로 구간 | 시간 | 전체 477.441초 대비 |
|---|---:|---:|
| EC2 LaunchTime → boot.start | 65.467초 | 13.7% |
| 이미지 준비 | 150.858초 | 31.6% |
| 컨테이너 시작(시크릿 조회·Docker 명령 포함) | 117.070초 | 24.5% |
| 컨테이너 시작 후 health READY | 144.044초 | 30.2% |

가중치 준비 30.388초는 이미지 준비와 겹친다. 별도 30초를 더하면 총시간을 이중 계산한다. 이미지와 컨테이너 시작 구간은 합계 약 267.9초(56.1%)다.

### 루트 EBS 처리량

루트는 200GiB gp3, 3,000 IOPS, 125MiB/s다. AWS/EBS의 60초 통계를 새로 조회했다. 아래 시각은 UTC로 변환했다(원본 SDK datetime의 현지 시간 표기를 UTC로 오인하지 않는다).

| 실행·시각(UTC) | 평균 쓰기 MiB/s | 평균 총 IOPS | 평균 queue |
|---|---:|---:|---:|
| parallel 08:23 | 125.07 | 542.5 | 1.54 |
| parallel 08:24 | 120.11 | 669.4 | 1.60 |
| parallel 08:25 | 123.08 | 640.6 | 1.88 |
| serial 08:45 | 125.07 | 532.9 | 1.54 |
| serial 08:47 | 125.07 | 649.1 | 1.63 |

이미지/컨테이너 준비 동안 쓰기가 설정한 처리량 상한에 붙지만 IOPS는 3,000보다 낮다. 이는 처리량 병목과 강하게 일치한다. 전용 VolumeThroughputExceededCheck/VolumeIOPSExceededCheck 데이터는 반환되지 않았으므로, 해당 경고 지표로 초과를 확인했다고 주장하지 않는다. 데이터는 호스트 전체 볼륨 집계이며 Docker의 함수별 I/O를 직접 추적한 결과는 아니다.

Docker journal은 Engine 29.9.2, containerd image store, overlayfs snapshotter를 확인한다. 공식 문서는 containerd store가 압축·해제 형식을 모두 보관하며 Docker와 containerd의 데이터 디렉터리도 별도로 설정될 수 있다고 설명한다. 따라서 NVMe에 모델만 둔다고 컨테이너 저장소까지 NVMe를 쓰는 것은 아니다. [Docker 문서](https://docs.docker.com/engine/storage/containerd/)

### 117초의 컨테이너 구간

- 이미지 pull 완료: 08:23:56.223
- container phase 시작: 08:23:56.327
- 중간 SSM 관측에서 docker 프로세스가 약 67초 동안 실행 중이었고 컨테이너 객체는 아직 없었다.
- Docker StartedAt: 08:25:51.645
- container phase 완료/health 시작: 08:25:53.397

따라서 이 구간 대부분을 시크릿 조회로 설명할 수는 없고, Docker 명령 내부의 대기가 큰 부분이다. 다만 압축 해제·snapshot 준비·runtime hook 중 어디에 몇 초가 걸렸는지는 아직 분리 계측하지 않았다. 루트 쓰기 포화가 같은 시간대에 관측됐으므로 디스크 처리량을 먼저 바꾸는 것이 가장 작은 검증 가능한 가설이다.

### health 144초의 내부 구간

| 로그 경계 | 시간 |
|---|---:|
| health 시작 → EngineCore 초기화 로그 | 약 46.2초 |
| EngineCore 초기화 → 모델 로딩 시작 | 약 11.8초 |
| 모델 로딩 시작 → 로딩 완료 로그 | 약 7.5초(모델 자체 보고 6.6초) |
| 로딩 완료 → 엔진 초기화 완료 | 약 75.8초 |
| 엔진 초기화 완료 → health READY | 약 2.7초 |

엔진은 그중 profile/KV cache/warmup 블록을 75.76초로 보고했다. 이 블록에 compilation 43.05초, CUDA graph capture 약 17초, initial profiling/warmup 1.98초가 포함된다. 75.76초에 43.05초와 17초를 다시 더하면 이중 계산이다. serial도 compilation 42.24초, 엔진 초기화 74.65초로 비슷했다. 네 GPU worker의 동시 시간을 네 배로 더하지 않는다.

~30초의 S3→NVMe 복사와 ~6.6초의 실제 가중치 로딩을 구분한다. 이번 조건에서 가중치 로딩을 더 최적화해도 전체 단축 여지는 작다. 반면 매번 새 컨테이너 안에 만들어지는 compile cache는 이후 검토할 후보다. 캐시 재사용은 vLLM이 지원하지만 정확한 image/모델/설정/환경 일치와 효과 검증이 필요하다. [vLLM 0.27.1 compile cache 문서](https://docs.vllm.ai/en/v0.27.1/design/torch_compile/)

### 다음 검증: 처리량 한 가지 변경

첫 변경은 gp3 125→500MiB/s이며, 용량 200GiB와 IOPS 3,000은 유지한다. g6e.12xlarge의 API상 EBS baseline은 20,000Mbps/2,500MBps/80,000 IOPS이므로 인스턴스 상한이 500MiB/s를 막지는 않는다. gp3는 3,000 IOPS에서 500MiB/s 구성이 가능하다. [AWS gp3 문서](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html)

Ohio AWS Price List API에서 추가 gp3 처리량은 $0.04/MiB/s-month로 확인했다. 추가 375MiB/s는 볼륨이 한 달 내내 존재하면 약 $15이며, 실험용 볼륨은 종료 시 삭제하므로 사용 시간에 비례한다. 이는 실제 청구액이나 성능 개선 보장이 아니다.

모델·가중치·AMI·이미지·컴파일/CUDA graph 설정을 동시에 바꾸지 않고, 같은 parallel 경로에서 처리량만 바꿔 실제 기동과 EBS 지표를 확인한다. 아직 500MiB/s의 새 부팅 시간은 측정하지 않았다. 이 변경으로 확인되는 효과를 근거로 다음 단계(compile cache, 이미지 사전 준비, 저장소 배치)를 결정한다.


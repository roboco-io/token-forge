# 루트 gp3 처리량 검증 — 2026-10-31

## 분석과 결정

기존 Ohio parallel 실측은 Launch→READY 477.441초, host→READY 411.974초다.
루트 gp3 200 GiB / 3,000 IOPS / 125 MiB/s에서 60초 평균 쓰기가
120–125 MiB/s였고 총 IOPS는 약 500–670이었다. 처리량 병목과 일치하지만
Docker 압축 해제·snapshot·runtime hook별 소요 시간은 분리하지 못했다.
기존 분석은 [Ohio 보고서의 4차 분석](2026-10-31-ohio-boot-benchmark.md)에 보존한다.

최소 변경은 루트 처리량 125→500 MiB/s다. 용량과 IOPS는 유지하고 종료 시 삭제를 명시한다.
새 context·CLI 옵션·DeploymentSettings 필드는 만들지 않는다. 모델, boot.sh,
컴파일, CUDA graph, 보안, ALB와 ASG 동작은 바꾸지 않는다.
[gp3 공식 사양](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html)은
3,000 IOPS에서 이 처리량을 지원한다. 기존 스택은 명시적 재배포 후 새 인스턴스부터 적용한다.

## 검증과 실험 설계

CDK 합성 검증으로 200 GiB / gp3 / 3,000 IOPS / 500 MiB/s / 종료 시 삭제를 확인한다.
집중 검증 후 전체 Jest, TypeScript 빌드, 기존 오프라인 synth 13사례, diff 공백 검사를 수행한다.
실측 전 모두 통과해야 한다. 단순 문구 고정 테스트는 추가하지 않는다.

parallel 125 기준과 parallel 500을 한 번씩 비교한다. serial은 재실행하지 않는다.
같은 Ohio g6e.12xlarge Spot, 우선 AZ us-east-2c, 같은 AMI·HF revision·이미지 digest,
TP4/EP·131072 조건을 사용한다. 새 private S3 cache는 CPU Spot 1대로 시딩하고
기존 모델 파일 Size/ETag와 일치하는지 확인한다. CPU 종료 확인 후 GPU를 기동한다.
GPU 상한 20분, 독립 25분 종료 타이머, 최대 단가 $6/h, 동시 GPU 1대다.
CPU 최대 단가는 $0.50/h이며 on-demand fallback은 없다.

## 비용과 한계

Ohio에서 추가 처리량 단가 $0.04/MiB/s-month를 적용하면 추가 375 MiB/s는
상시 볼륨에서 약 $15/월이다. 임시 볼륨은 사용 시간에 비례한다.
Launch→READY × 고정 관측 Spot 단가는 비용 proxy이며 실제 청구액이 아니다.
CPU 시딩·추론·스토리지·로그 비용을 GPU 부팅 비용과 구분한다.
[EC2 공식 문서](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html)는
shutting-down 상태를 미과금으로 명시한다. terminated 관측까지의 대기를 GPU 과금 시간으로 계산하지 않는다.

각 처리량에서 다른 시각에 한 번 관측하므로 네트워크·호스트 변동을 분리할 수 없다.
weights와 image는 겹친다. health 전체를 가중치 로딩 시간으로 부르지 않는다.
엔진 profile/KV/warmup에는 compile과 CUDA graph 시간이 포함되므로 중복 합산하지 않는다.
전용 EBS exceeded-check datapoint가 없으면 미수집으로 기록하고 0으로 대체하지 않는다.

## 제품 검증

최종 `npm test -- --runInBand`: **27 suites / 305 tests 통과**.
실측 전 전체 304개와 집중 CDK 검증 46개, 두 번째 반복의 부팅 런타임 검증 30개, `npm run build`, 기존 오프라인 synth 13사례와 `git diff --check`도 통과했다.
새 합성 검증은 기존 설정에서 실패한 뒤 최소 디스크 설정 변경으로 통과했다.
이전 전체 실행에서 기존 SIGTERM 손자 프로세스 종료 검증이 한 번 실패했다.
당시 프로세스 상태 기록은 없어 원인은 확정하지 못했다. 두 번째 반복에서 실행 중→zombie→부모 회수의 실제 프로세스 재현을 추가했다. zombie 상태에서도 `kill(pid, 0)`가 성공하여 기존 검사가 실패하는 것을 확인했다. 테스트의 liveness를 “더 이상 실행하지 않음”으로 정의하고 `ps`의 Z 상태와 ESRCH를 구분했다. 권한·도구 오류는 숨기지 않는다. 살아 있는 프로세스는 실패하며 기존 600ms bounded wait를 늘리지 않았다. 부모가 실제로 회수한 상태도 검증한다. 제품 부팅 코드는 변경하지 않았고 실패 로그를 보존했다.

## 실측 결과

| 항목 | parallel 125 | parallel 500 |
|---|---:|---:|
| Launch→READY(초) | 477.441 | 288.210 |
| host→READY(초) | 411.974 | 243.441 |
| weights(초) | 30.388 | 27.518 |
| image(초) | 150.858 | 82.805 |
| container(초) | 117.070 | 16.832 |
| health(초) | 144.044 | 143.802 |

이번 관측에서는 **189.231초(39.63%) 단축**됐다. 1회씩 다른 시각의 관측이며 통계적 보장이나 모든 모델의 성능 수치가 아니다.
이미지·컨테이너 준비 단축과 125 MiB/s를 넘은 쓰기 관측은 처리량 병목 완화와 일치한다.
전체 차이를 처리량 변경의 순수 인과 효과로 확정하지 않는다. host→READY 단축은 168.533초이며, 나머지 약 20.698초는 Launch→host 계측 시작 전 차이다. weights/image 중첩은 유지됐다.
health에는 모델 로딩 외 엔진 초기화·compile·CUDA graph가 포함되며 별도 시간으로 중복 합산하지 않는다. 새 로그의 실제 GPU 모델 로딩은 6.649초, 엔진 profile/KV/warmup은 75.89초다. 후자에는 compilation 43.42초와 graph capture 약 17초가 포함된다. 기준의 6.6초·75.76초·43.05초·17초와 비슷하며 컴파일을 끄거나 모델을 줄여 얻은 결과가 아니다.

### 동일 조건 확인

- us-east-2c, g6e.12xlarge Spot 1회. CPU c6id.4xlarge Spot 1회 종료 확인 후 GPU를 기동했다.
- GPU 루트 API: gp3 200 GiB / 3,000 IOPS / 500 MiB/s / 종료 시 삭제. CPU 루트는 125 MiB/s 유지.
- 동일 AMI·HF revision·vLLM 이미지 digest·TP4/EP·131072. 모델·컴파일·CUDA graph 설정 변경 없음.
- user-data는 임시 이름·Secret ARN 접미사만 정규화하면 기준 parallel과 완전히 같다. 13,644바이트로 16 KiB 이내다.
- source boot.sh SHA-256도 기준과 같다. 가중치 cache hit / 이미지 cache miss 조건이다.
- 모델 파일 16개의 Size·ETag가 기준과 일치했다. 총 31,195,132,826바이트, 가중치 31,175,618,584바이트다.
- Docker 29.9.2 / containerd image store, L40S 4대 / NVIDIA driver 595.112.07, NVMe ext4 마운트와 이미지 digest를 확인했다.
- 새 버킷·새 호스트·다른 실행 시각은 조건 차이다. 네트워크 및 호스트 변동은 통제하지 못했다.

HF revision: `dcaee4d4dfc5ee71ad501f01f530e5652438fde0`. 이미지 digest: `sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967`.

### 주요 시각과 추론

| 경계 | UTC |
|---|---|
| LaunchTime | 2026-10-31T09:54:33+00:00 |
| boot.start | 2026-10-31T09:55:17.769000+00:00 |
| boot.ready | 2026-10-31T09:59:21.210000+00:00 |
| 종료 요청 | 2026-10-31T09:59:31.484109+00:00 |
| terminated 관측 | 2026-10-31T10:06:31.053675+00:00 |

짧은 실제 추론은 성공했다. 요청 지연은 0.130초이며 TTFT가 아니다. max_tokens=16, 실제 출력 3토큰이었다.
호스트 원본 이벤트, 종료 후 CloudWatch 이벤트와 기존 bootReport 파서를 대조했다. READY·단계 시간·비용 계산 일치를 확인했다.

### EBS 60초 지표

시각은 `astimezone(UTC)`로 변환했다. 아래 값은 볼륨 전체의 60초 평균이며 순간 최대 처리량이 아니다.

| UTC | 읽기 MiB/s | 쓰기 MiB/s | 총 IOPS | 평균 queue |
|---|---:|---:|---:|---:|
| 2026-10-31T09:55:00+00:00 | 11.80 | 155.89 | 934.8 | 2.52 |
| 2026-10-31T09:56:00+00:00 | 0.00 | 267.48 | 1315.7 | 3.47 |
| 2026-10-31T09:57:00+00:00 | 0.44 | 140.27 | 720.5 | 1.82 |

기준 parallel은 08:23/24/25 UTC에 각각 125.07/120.11/123.08 MiB/s였다. 새 관측은 125 MiB/s 상한을 넘었지만 500 MiB/s 포화 여부나 Docker 내부 세부 비율은 증명하지 않는다. VolumeThroughputExceededCheck·VolumeIOPSExceededCheck datapoint는 없으며 0으로 간주하지 않는다.

### 비용 proxy

새 GPU 고정 관측 단가는 $5.3198/h다. Launch→READY proxy는 **$0.425894**이며 기준은 $0.705141(기준 관측 단가 $5.3169/h)다. 실제 청구액이 아니다.

| 실행 | 관측 단가 USD/h | Launch→종료 요청(초) | 해당 구간 proxy USD |
|---|---:|---:|---:|
| seed | 0.2289 | 137.528 | 0.008744 |
| parallel | 5.3198 | 298.484 | 0.441077 |

추가 EBS 처리량은 상시 약 $15/월이다. 30일 월과 볼륨 생성→terminated 관측 716.6초를 가정한 이번 추가 처리량 근사는 $0.004147다. 실제 삭제 시각·청구 단위의 차이를 반영하지 않는다. EBS 기본 용량·CPU·S3·CloudWatch·Secret·전송 비용이 별도로 존재하며 전체 청구를 0으로 주장하지 않는다.

## 기본값 판단과 정리

**500 MiB/s 기본값을 유지한다.** 이번 조건의 이미지·컨테이너 구간과 전체 기동 시간이 줄었고,
EBS 쓰기는 기존 상한을 넘었다. 단기 GPU 사용에서 추가 디스크 비용과 비교할 근거가 있다.
다만 모든 모델·리전·장기 실행에 대한 최적값을 검증한 것은 아니다. 상시 볼륨은 월 약 $15 추가 비용을 고려해야 한다.
IOPS 증설 근거는 없어 3,000을 유지한다. 추가 유료 실험·AMI 빌드·캐시 튜닝은 하지 않았다.

독립 API 정리 검증: **True**. 실험 소유 CPU·GPU 모두 terminated, Spot 요청 종료 상태, ENI·EBS·SG·IAM role/profile·Secret·private S3·CloudWatch 그룹 부재를 확인했다. Ohio 활성 인스턴스는 0대다. 기존 VPC/subnet·다른 리전·기존 스택·CLI state는 변경하지 않았다.

종료 뒤 CloudWatch 로그를 보존하고 임시 그룹을 삭제했다. 새 비밀값은 API 응답 저장 전에 제거했으며 최종 비공개 아티팩트 검사에서도 원문이 남지 않았다. 공개 문서에는 계정·임시 리소스 ID·Secret ARN·개인 경로를 넣지 않는다.

## 근거와 Ralph 경계

비공개 실험 디렉터리의 result.json에 제품 검증, 단계별 실측, 기준 비교, 조건, 비용 proxy, EBS 지표, cleanup 근거를 통합했다. 두 번째 반복에서 저장된 결과·실제 API cleanup·제품 diff를 새로 검토했다. CPU 종료 후 GPU 기동, 단일 CPU/GPU 실행, root API 설정, 동일 부팅 source hash, UTC EBS 원본과 요약 일치를 확인했다. 완료된 유료 실험은 재실행하지 않는다. 실제 마지막 응답은 기존 Codex 실행기가 official Ralph Stop hook에 전달한다. 이 응답 이후 실행될 Stop hook의 성공 여부는 부모 실행기가 기록하며, 여기서 미리 성공을 주장하지 않는다. commit/push/배포/이슈 변경은 하지 않았다.

두 번째 반복의 최종 전체 검증은 305개이며 빌드·synth 13사례도 다시 통과했다. 독립 정리 13항목에 더해 caller와 실제 인스턴스·Spot 요청·ENI·볼륨 ID 조회 9항목을 확인했다. 종료 후 CloudWatch 원본을 기존 CLI로 다시 분석한 결과도 단계 시간·READY·비용 proxy와 일치했다.

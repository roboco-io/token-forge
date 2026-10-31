# prepared AMI 실험과 최단 실측 부팅 경로 선택

**결론:** 4개 rank의 AOT cache 재사용과 실제 추론은 성공했다. 그러나 최종 launch→READY는 **617.075초**로 기준 288.210초보다 **328.865초 느렸다**. 이번 조건에서 전체 부팅 개선은 입증되지 않았다. 제품에는 최단 실측인 표준 DLAMI + 병렬 준비 + gp3 200 GiB/3000 IOPS/500 MiB/s 경로를 반영한다. 준비 AMI와 compile cache 연동은 제품 경로에서 제거했다.

## 승인 범위와 설계

현재 제품은 리전별 SSM GPU DLAMI를 사용한다. 실험 중 추가했던 AMI 선택 context와 DeploymentSettings/CLI 전달을 제거했고 일반 부팅은 cache helper 조회·import·mount를 하지 않는다. 아래 빌더·캐시 절차는 과거 실험 및 수동 재현 기록이다.

CPU Spot 빌더는 동일 GPU DLAMI에서 고정 digest 이미지를 pull하고 컨테이너를 실제 실행해 unpack을 확인한다. Docker/containerd 저장소는 루트 EBS에 둔다. 모델 가중치는 AMI에 넣지 않고 기존 S3→NVMe 경로를 유지한다.

GPU1은 이미지 전용 AMI로 cold compile과 추론을 측정한다. 신뢰한 compile cache만 해시·호환성 manifest와 함께 내보낸 뒤 즉시 종료한다. CPU가 캐시 AMI를 만들고 GPU2가 같은 모델·GPU·볼륨 사양으로 재사용과 추론을 측정한다. 기준 DLAMI와의 암호화·로그 등 차이는 아래에 명시한다. 각 GPU는 최대 20분 측정, 독립 25분 종료이며 CPU는 최대 60분이다. 단계당 GPU 1회, 최대 3 AZ 용량 시도다. 재검토는 유료 실험을 반복하지 않는다.

## 캐시 계약

[vLLM 0.27.1 공식 문서](https://github.com/vllm-project/vllm/blob/v0.27.1/docs/design/torch_compile.md)는 `torch_compile_cache` 복사를 지원한다. 내부 해시가 실제 재사용을 결정한다. 별도 manifest는 이미지 digest, 모델 revision/config 해시, 플래그, 최대 길이, GPU/드라이버, 컨테이너 경로/uid를 비교한다. 불일치·파일 변조·helper 부재는 일반 컴파일로 돌아간다. 디렉터리 존재를 cache hit로 보고하지 않는다. 실제 로그와 시간으로 판정한다. CUDA graph는 다시 캡처한다.

신뢰하지 않는 pickle/cache를 가져오지 않는다. API 키나 GPU 파일시스템 전체는 캡처하지 않는다. 빌더 정리는 [cloud-init clean](https://docs.cloud-init.io/en/latest/reference/cli.html)과 [SSM credential 위치](https://docs.aws.amazon.com/systems-manager/latest/userguide/ssm-agent-technical-details.html)를 기준으로 한다. Docker/containerd를 정지하고 sync한 뒤 snapshot을 만든다. 재사용할 CPU 빌더의 원래 machine-id는 `/run`에만 잠시 보관하고, 캡처 요청 성공 후 복원해야 journald/SSM을 다시 시작할 수 있다.

## 재사용 도구

`scripts/prebootstrap/prepare-image.sh <repository@sha256:...>`는 전용 빌더의 루트 저장소를 준비하고 unpack을 검증한다. `sanitize-image.sh`는 전용 빌더에서만 실행한다. 캐시 helper는 AMI의 `/opt/token-forge/cache.py`, manifest/archive는 `/opt/token-forge/prebootstrap/`에 설치한다. 복원 위치는 `/run/token-forge/vllm-cache`, 컨테이너 경로는 `/root/.cache/vllm`이다. S3 모델 디렉터리의 `.tkf-revision`이 없으면 캐시 복원을 건너뛴다.

## 실제 결과

Ohio 2c, g6e.12xlarge Spot, gp3 200 GiB / 3,000 IOPS / 500 MiB/s, 고정 GPU DLAMI와 vLLM 0.27.1 이미지로 실행했다. 모델은 Qwen3-Coder-30B-A3B-Instruct-FP8의 고정 revision이다. TP4·EP·qwen3_coder 도구 파서·prefix cache·최대 길이 131072를 유지했다. 관측된 환경은 Torch 2.13.0+cu130, NVIDIA L40S 4개, 드라이버 595.112.07이다. GPU는 각 단계 1회, 총 2회 기동했다.

단위: 초. image와 weights는 병렬 실행되므로 합산하지 않는다.

| 항목 | 기준 DLAMI | 이미지 전용¹ | 이미지+compile cache |
|---|---:|---:|---:|
| launch→READY | 288.210 | 944.327 | 617.075 |
| launch→boot 스크립트 시작 | 44.769 | 110.302 | 105.135 |
| boot 스크립트 전체 | 243.441 | 834.026 | 511.940 |
| image 준비 | 82.805 | 4.763 | 4.112 |
| weights 준비 | 27.518 | 30.968 | 28.512 |
| container 시작 | 16.832 | 27.654 | 51.154 |
| health 대기 | 143.802 | 775.402 | 432.272 |
| vLLM compilation | 43.42 | 50.22 | 4.26 |
| engine 초기화² | 75.89 | 158.41 | 83.87 |
| CUDA graph 캡처 | 17 | 18 | 14 |
| 실제 chat completions | 성공 | 성공 | 성공 |

¹ 이미지 전용 GPU의 임시 API 키가 `-`로 시작하여 vLLM 인자 파싱에 실패했다. 같은 VM에서 컨테이너 인자 전달을 수정했다. 944.327초는 실패와 복구 시간을 포함한 실제 시간이며, 순수 이미지 최적화 효과를 비교하는 수치로 사용할 수 없다. VM을 다시 기동하지 않았다. 정상 엔진의 cold compile은 1회였다.

² compilation과 graph 캡처는 engine 내부 시간이다. 이를 engine 또는 health 시간에 다시 더하지 않는다.

최종 GPU에서는 4개 rank 모두 `Directly load AOT compilation from path`를 기록했다. 이 로그는 [vLLM 0.27.1 소스](https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/compilation/decorators.py#L312)에서 native artifact 로딩 완료 후 출력된다. 새 cold graph compilation 로그는 없었다. CUDA graph는 실제로 다시 캡처했다. 두 GPU 모두 인증된 `/v1/chat/completions` 요청으로 정상 응답을 확인했다.

캐시 archive는 211,148,800바이트다. GPU export manifest와 CPU import의 SHA-256이 일치했다. 별도 CPU 검사는 원문 API 키 없이 단방향 digest만 받아 archive에 원문 키가 없음을 확인했다. GPU2의 cache mount는 `/root/.cache/vllm`, writable, UID 0이었다. directory 존재만으로 hit를 판정하지 않았다.

## 해석과 한계

이미지 준비와 compilation은 빨라졌지만 전체 부팅은 느려졌다. snapshot에서 새로 만든 루트 볼륨의 첫 읽기 구간에서 낮은 처리량과 읽기 대기를 관측했다. 사설 snapshot의 최초 읽기가 주요 원인일 가능성이 있으나, 원인을 분리한 추가 실험은 하지 않았다. [AWS 초기화 문서](https://docs.aws.amazon.com/ebs/latest/userguide/initalize-volume.html)도 snapshot 복원 볼륨의 초기 성능 조건을 설명한다.

FSR 및 사전 전체 볼륨 초기화를 사용하지 않은 단일 실행 결과다. 이미지 전용 단계에는 복구 개입도 있었다. 따라서 기존 약 55초/99초 단축 예측은 실측으로 입증되지 않았다. 이 결과로 준비 AMI를 기본 성능 개선책으로 권장하지 않는다. eager·CUDA graph·context·모델·TP 설정을 바꾸지 않았다.

## 구현·실패 처리·검증

- 실험용 AMI 공개 context와 DeploymentSettings/CLI 연동 및 일반 부팅의 cache 연동을 제거했다. 기존 보안 설정·사용 모드·유휴 종료·계측·로컬 이미지 재사용은 유지한다.
- helper 부재, manifest 불일치, archive 변조는 정상 compile로 돌아간다. path traversal과 링크 항목은 거부한다. 캐시는 writable runtime 경로로 복원한다.
- CPU 빌더는 2회 기동했다. 첫 시도는 정리 worker 종료로 AMI 캡처 전에 실패했고 모두 삭제했다. 두 번째 빌더에서는 machine-id 초기화 후 journald 재시작 실패를 확인했다. 같은 CPU를 복구하고, 이후에는 snapshot 요청 후에만 원래 machine-id를 복원하도록 했다. CPU의 실제 사용 시간은 각각 약 7분, 42분으로 60분 제한 이내였다.
- API 키는 `--api-key=값`으로 전달하여 선행 하이픈도 처리한다. vLLM 0.27.1의 시작 인자 INFO 로그에 키가 포함되는 경로를 발견하여 해당 logger만 WARNING으로 설정했다. compile INFO 로그는 유지한다. 이 설정의 `VLLM_LOGGING_CONFIG_PATH`는 [native compile hash 제외 항목](https://github.com/vllm-project/vllm/blob/v0.27.1/vllm/envs.py)이다.
- GPU1에서 원문 키가 기록된 임시 로그 스트림은 redaction한 증거를 확보한 뒤 삭제했고, 독립 조회로 부재를 확인했다. GPU2의 실제 로그와 저장된 로컬 증거에는 원문 키가 없었다. 임시 시크릿도 최종 삭제했다. serving GPU는 AMI로 캡처하지 않았다.
- 이전 compiled-graph 로그 문구만 찾던 보존 판정은 실제 AOT 로그와 공식 소스를 대조하여 수정했다. 원본 로그를 바꾸지 않았고, 4개 rank·부분 hit·중복·cold fallback을 검사하는 별도 테스트 5개가 통과했다. 이 검토에서 유료 실행을 반복하지 않았다.
- AMI 기능 제거 전 검증 기록: `npm test -- --runInBand` 316개 통과. `npm run build`: 통과. `node scripts/verify-usage-mode-synth.js`: 13개 통과. shell 문법과 `git diff --check`도 통과했다. 8개 placeholder를 유지하며 모든 프로파일의 보수적 rendered user-data 최대 크기는 14,854바이트다.

## 비용·보존·정리

관측 Spot 단가는 CPU $0.2288/시간, GPU $5.3198/시간이었다. LaunchTime→최초 종료 요청까지의 compute proxy는 CPU 합계 $0.1864, GPU1 $1.4479, GPU2 $0.9403, **합계 $2.5746**다. 청구서 금액이 아니며 EBS·S3·로그·요청·IPv4·전송 요금은 포함하지 않는다. 종료 요청 후 EC2 상태 전환 대기는 GPU compute proxy에 넣지 않았다.

이전 실험 종료 때 사설 AMI 1개와 암호화된 backing snapshot 1개를 잠시 보존했다. snapshot 데이터는 89,200,787,456바이트(약 83.075 GiB)였다. 당시 Ohio 표준 snapshot 단가 $0.05/GB-month 기준 계속 보존했다면 약 $4.15/월의 추정 저장비가 발생한다. 이는 청구액이 아니다. 최단 실측 경로 선택 후 해당 소유 AMI와 backing snapshot을 삭제했고, 별도 API 조회로 부재를 확인했다. 따라서 이 실험의 잔존 리소스에 대한 지속 비용은 $0이며 과거 사용 요금은 남는다. [AWS EBS 요금](https://aws.amazon.com/ebs/pricing/)을 참고한다.

모든 실험 VM을 종료하고 Spot 요청·임시 EBS/ENI/SG·IAM role/profile·시크릿·S3·CloudWatch 그룹을 삭제했다. 중간 AMI와 snapshot도 삭제했다. 이전 정리의 별도 API 검증 20개가 통과했으며 us-east-1/us-east-2의 모든 GPU 상태를 조회해 실행 중 GPU가 없음을 확인했다. 기존 다른 리전과 생산 스택·CLI 상태는 변경하지 않았다. commit/push/release/생산 배포는 하지 않았다.

삭제된 AMI의 역사적 ID·리전·source pins·cache hash는 저장소 밖의 `retained-artifact.json`과 `result.json`에 보관한다. 원본 SSM/CW·비용·정리 증거도 비공개 작업 디렉터리에 있다. 첫 Ralph 반복은 promise 없이 종료했다. 두 번째 반복에서 source/diff/result/cleanup을 새로 대조하고 읽기 전용 API로 정리를 재확인했다. 유료 실험은 재실행하지 않았다.

## 제품 선택과 측정 해석 보완

288.210초는 Ohio 2c g6e.12xlarge Spot, Qwen3-Coder-30B FP8, vLLM 0.27.1, TP4/EP/131072, S3 가중치 hit·이미지 pull의 단일 실행이다. 이전 125 MiB/s 실행의 477.441초와는 시점이 다르다. 병렬화만의 serial 대비 차이는 6.186초였으므로 전체 189.231초 차이를 병렬화 효과로 설명하지 않는다. 500 MiB/s의 추가 375 MiB/s는 Ohio 상시 볼륨 기준 약 $15/월이며 임시 볼륨은 시간 비례다. 현재 소스에는 API 키 전달·로그 정확성 수정도 포함된다. 로컬 회귀 테스트로 검증했으며 이 소스로 새 288.210초 라이브 실행을 했다는 뜻은 아니다.

GPU1의 944.327초는 실패·같은 VM 복구가 섞인 비비교 자료다. 최적화 비교 delta를 제거했으며 944→617초를 cache 효과로 해석하지 않는다. 정상 신규 부팅 비교는 GPU2 617.075초와 기준 288.210초뿐이다. 기준 루트 EBS는 암호화하지 않았고 GPU2는 암호화했다. AMI·로그/API 수정·실행 시점도 달라 단일 변수 실험이 아니다.

GPU2 launch 기준 주요 관측 시점은 컨테이너 시작 +159.358초, health 시작 +184.803초, 첫 인자 warning +369.034초, 모델 아키텍처 해석 +492.793초, V1 engine 초기화 시작 +505.881초, 가중치 로드 완료 +529.209초, AOT load +578.340초, engine 완료 +613.956초, HTTP 시작 +616.869초, READY +617.075초다. warning은 로그 지점이며 import 경계를 정확히 뜻하지 않는다. health 증가의 대부분은 engine 초기화 전이다. engine 자체는 75.89→83.87초이며 compilation 4.26초는 그 내부다. health 432.272초 전체를 모델/GPU 로드·컴파일로 부르지 않는다.

critical path의 차이는 host 시작 전 +60.366초, 병렬 준비 max −54.293초, 컨테이너 시작 +34.322초, health +288.470초로 총 +328.865초다. GPU2의 가중 평균 EBS 읽기 지연은 16.473ms(기준 2.358ms), 읽기 2.745GiB/54,516회, 최대 60초 평균 처리량은 8.959MiB/s였다. snapshot 최초 읽기 지연 가설을 뒷받침하지만 원인을 분리한 증명은 아니다. GPU2 로그 해석은 launch 이후 timestamp 또는 해당 컨테이너로 제한하여 이전 GPU1 오류를 제외했다.

AMI·snapshot 삭제 후 두 실험 attempt를 독립 API로 다시 확인했다. 소유 VM 종료, AMI/snapshot/EBS/ENI/SG/S3/IAM/시크릿/로그 부재와 Spot 요청 종료 상태를 포함한 27개 확인이 통과했다. Ohio·Virginia는 pending/running/stopping/stopped/shutting-down을 조회했으며 GPU가 0개였다. Seoul 생산 리소스는 조회·변경하지 않았다.

제품 경로 제거 후 이번 반복 검증: 관련 테스트 137개, 전체 테스트 308개(28 suites), `npm run build`, 오프라인 사용 모드 synth 13개가 통과했다. 기존 316개에서 실험용 AMI/CLI/일반 boot-cache 테스트를 제거한 수치다. 8개 placeholder와 6개 프로파일을 유지하며 보수적 rendered user-data 최대 14,465바이트로 16 KiB 이하다. 두 번째 Ralph 반복에서 실제 diff·로그·정리 증거를 새로 검토했다. 제품 소스 해시가 검증 당시와 모두 같아 기존 테스트·빌드·synth 결과를 재사용했다. 새 읽기 전용 정리 확인 27개도 모두 통과했다.

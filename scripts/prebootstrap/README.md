# Prepared AMI 수동 실험 도구

제품 CDK/CLI 또는 일반 boot.sh에 연결되지 않는 수동 재현용 도구다. 실측 617.075초가 표준 DLAMI의 288.210초보다 느려 제품 경로로 채택하지 않았다. 아래는 이전 실험 절차이며 추가 유료 실행 지시가 아니다.

전용 Spot 빌더에서만 사용한다. AMI 리전과 GPU 드라이버/아키텍처는 대상 프로파일과 같아야 한다. 기본 DLAMI 경로는 바뀌지 않는다.

1. 빌더에 독립 종료 타이머를 먼저 설정한다. 동일 GPU DLAMI로 CPU Spot을 만든다. `/opt/token-forge/builder-only` 표식이 있는 전용 호스트만 스크립트를 실행할 수 있다.
2. `prepare-image.sh <repository@sha256:...>`를 실행한다. Docker/containerd는 루트 EBS에 저장한다. 실제 컨테이너 실행으로 unpack을 확인한다. 빌더를 재부팅한 뒤 두 저장소와 컨테이너 실행을 다시 검증한다.
3. `cache.py`를 `/opt/token-forge/cache.py`에 설치한다. 이미지 전용 AMI에는 compile cache를 넣지 않는다. 모델은 S3로 시딩하고 revision을 `.tkf-revision` 파일에 기록한다. 가중치는 루트 디스크에 저장하지 않는다.
4. 전용 빌더에서 `sanitize-image.sh`를 독립 프로세스로 실행한다. SSM이 중단되므로 별도 완료 신호와 복구 경로가 필요하다. Docker/containerd 정지·sync 이후 NoReboot AMI를 만든다. 빌더를 재사용하면 캡처 전에 원래 machine-id를 `/run`에만 보관한다. snapshot 요청이 성공한 뒤 원래 machine-id를 복원하고 journald·Docker·containerd·SSM을 재시작한다. 초기화한 machine-id 상태에서 journald를 재시작하면 실패할 수 있다. 종료 타이머는 원래 마감을 유지한다.
5. GPU에서 실제 추론이 성공한 trusted `torch_compile_cache`만 내보낸다. `cache.py`의 `identity()`와 SHA-256을 manifest에 기록한다. 컨테이너의 Torch/vLLM 버전도 기록한다. CPU 빌더가 검증한 `cache.tar`와 `manifest.json`만 `/opt/token-forge/prebootstrap/`에 넣고 다시 정리·캡처한다.
6. 별도 실험에서 실제 로그의 캐시 재사용과 추론을 확인한다. 수동 실험 harness가 helper를 호출하고 검증된 복원 경로만 컨테이너에 마운트해야 한다. 일반 제품 부팅에는 이 연동이 없다. cache hit와 전체 부팅 개선을 구분하고, 실험 후 사용하지 않는 소유 AMI와 backing snapshot을 삭제한다.

실험 harness에서 `.tkf-revision`이 없으면 helper는 복원을 건너뛴다. 일반 S3 seed는 이 실험용 revision 표식을 보장하지 않는다.

모델 revision/config, digest, 플래그, 최대 길이, GPU/드라이버, uid/경로가 다르면 일반 컴파일로 돌아간다. vLLM 내부 해시도 적용되므로 manifest 일치만으로 hit를 보장하지 않는다. writable runtime cache는 `/run/token-forge/vllm-cache`이며 컨테이너에서는 `/root/.cache/vllm`이다. GPU 메모리와 CUDA graph는 보존하지 않는다.

이 스크립트는 EC2/IAM/S3 수명주기를 생성하지 않는다. 호출자는 소유권 태그·저널·Spot 가격 상한·종료 마감·예외 정리를 책임진다. serving GPU를 AMI로 캡처하거나 외부에서 받은 캐시를 import하지 않는다. 사설 AMI에도 snapshot 저장 요금이 지속된다. 실험 조건과 결과는 [실측 보고서](../../docs/superpowers/plans/2026-10-31-prebootstrap.md)에 기록한다.

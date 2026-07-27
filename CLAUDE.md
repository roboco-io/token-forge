# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

Hugging Face LLM을 EC2 스팟에서 vLLM(OpenAI 호환)으로 서빙하는 AWS CDK(TypeScript) 템플릿.
단일 스택 + 모델 프로파일 YAML 구조. 설계 근거는 `docs/superpowers/specs/2026-07-23-token-forge-design.md`,
구현 계획은 `docs/superpowers/plans/` 참고. 문서·커밋 메시지는 한국어.

## 명령어

```bash
npm test                                   # 전체 테스트 (jest + ts-jest)
npx jest test/model-profile.test.ts        # 파일 단위
npx jest -t 'ASG is 100% spot'             # 테스트 이름 단위
npm run build                              # tsc 타입 체크

# synth/배포 — 컨텍스트 파라미터가 인터페이스의 전부
npx cdk synth -c model=solar-open2-250b -c profile=int4 --quiet
npx cdk deploy -c model=<model> -c profile=<profile> -c region=<r> \
  [-c azs=us-east-1a,us-east-1b] [-c minCapacity=0] [-c idleMinutes=60] [-c alertEmail=...]

scripts/start.sh <stack-name> <region>     # desired=1 (기동)
scripts/stop.sh  <stack-name> <region>     # min=0, desired=0 (GPU 비용 정지)
scripts/smoke-test.sh <endpoint-url> <api-key>  # /v1/models + /v1/chat/completions 검증
```

## 아키텍처 핵심

**데이터 흐름**: `bin/token-forge.ts`가 컨텍스트(`model`/`profile`)로 `models/<model>.yaml`을
`loadModelProfile()`(lib/model-profile.ts)로 해석 → `ResolvedProfile`을 `TokenForgeStack`에 주입.
스택 이름은 CFN 제약에 맞게 정규화됨(점 → 대시).

**boot.sh 플레이스홀더 계약** (가장 깨지기 쉬운 부분): `assets/user-data/boot.sh`의
`__REGION__` 등 7개 토큰을 스택이 synth 시 `.replace()`로 치환해 user-data로 주입한다.
토큰을 추가/변경하면 세 곳을 동시에 수정해야 한다 — boot.sh, `lib/token-forge-stack.ts`의
치환 체인, `test/boot-script.test.ts`·`test/token-forge-stack.test.ts`의 PLACEHOLDERS 목록.

**스팟 확보 전략** (실배포에서 검증된 순서): ASG는 MixedInstancesPolicy(100% 스팟,
capacity-optimized) + `capacityRebalance`. 프로파일의 `instanceType`은 콤마 구분 다중 후보
허용("g6e.xlarge,g5.xlarge") — 첫 타입이 Launch Template 기본, 전체가 overrides가 된다.
`-c minCapacity=0`은 CFN 생성을 스팟 확보와 분리하는 패턴: 스팟이 말라도 스택은 생성되고,
`scripts/start.sh`로 desired=1을 올리면 ASG가 무기한 재시도한다(신규 계정은 GPU 스팟
배정이 장기간 거부될 수 있음 — `docs/ec2-quota-guide.md` 참고).

**비용 가드**: `idleMinutes`(기본 30) 동안 ALB 요청 0이면 Lambda가 ASG를 0으로 내린다
(`-c idleMinutes=0`으로 비활성). p5.48xlarge는 시간당 $30-50이므로 이 가드를 끄지 말 것.

**새 모델 추가** = `models/<name>.yaml` 1개 (스키마: 최상위 `model`/`vllmImage`/`profiles`,
프로파일별 `weightsRepo`/`instanceType`/`vllmFlags`/`maxModelLen` — 파서가 누락·빈 문자열 거부).
solar-open2-250b는 Upstage 포크 vLLM 이미지 필수, `maxModelLen` 131072 캡 유지.

## 테스트 작성 시 주의

- CDK 단위 테스트 환경의 AZ는 `dummy1a`/`dummy1b`로 합성된다 — `-c azs=` 관련 테스트는
  실제 AZ 이름이 아닌 dummy 이름으로 작성.
- 스테일 컴파일 산출물(`*.js`/`*.d.ts`, gitignored)이 ts-jest에서 `.ts`를 가릴 수 있다 —
  테스트가 설명 불가하게 실패하면 먼저 삭제.
- 스택 테스트는 `makeTemplate()` 헬퍼(solar int4 프로파일 기준)를 재사용하고, 컨텍스트가
  필요한 케이스만 별도 `cdk.App({ context })`로 만든다.

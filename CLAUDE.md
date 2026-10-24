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
  [-c azs=us-east-1a,us-east-1b] [-c minCapacity=0] [-c idleMinutes=60] [-c usageMode=interactive|batch|online] [-c alertEmail=...]

npx cdk deploy -c collector=1              # 스팟 배치점수 수집기 (별도 스택, 상시 가동)
npx cdk destroy -c collector=1             # 수집기 삭제 (수집 이력도 함께 삭제됨)

scripts/start.sh <stack-name> <region>     # desired=1 (기동)
scripts/stop.sh  <stack-name> <region>     # min=0, desired=0 (GPU 비용 정지)
scripts/smoke-test.sh <endpoint-url> <api-key>  # /v1/models + /v1/chat/completions 검증

# tkf CLI 사용 모드
tkf up <model> [--usage-mode online] [--idle-minutes 30]
tkf run <model> --region <r> [--timeout 120] -- <command> [args...]   # batch: 작업 후 GPU 0
npx ts-node scripts/verify-usage-mode-synth.ts   # 사용 모드 오프라인 합성 검증 (AWS 호출 없음)
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
(`-c idleMinutes=0`으로 비활성). p5.48xlarge는 시간당 $30-50이므로 interactive·batch에서 이 가드를
끄지 말 것. online 모드(유휴 종료 없음)는 사용자가 비용(24시간 × 단가)을 알고 명시적으로 고르는 경우에만
쓰고, 작업·데모 기본값으로 쓰지 않는다.

**사용 모드(#43)**: `lib/usage-mode.ts`의 `resolveUsagePolicy()`가 CDK 컨텍스트와 CLI 옵션을 같은
규칙으로 해석한다. interactive(기본, 유휴 30분) / batch(`tkf run`, 작업 중 1분 하트비트로 유휴 알람
억제, 알람은 SIGKILL·호스트 유실용 백스톱) / online(유휴 알람 없음, READY 후 CLI가 min=1). idleMinutes는
5의 배수(5-1440) 또는 0만 허용하며 모드와 충돌하는 값은 synth에서 거부한다. 스택 출력
`UsageMode`/`IdleMinutes`를 CLI가 요청 정책과 비교해 다르면 기존 스택도 `cdk deploy`로 갱신한다
(`ensureStackReady`). 이 자동 갱신은 스택 출력 `DeploymentSettings`(v1 JSON: allowedCidrs/azs/alertEmail)를 그대로 다시 전달하며,
기록이 없거나 손상되면 자동 배포하지 않는다(구버전 스택 + 기본 interactive 요청은 배포 없이 사용). 스택에 새 컨텍스트를
추가하면 `lib/deployment-settings.ts`에도 넣을 것. batch는 desired>0이거나 인스턴스가 남은 스택을 인수·종료하지 않고(배포 전·기동 직전 2회 검사),
같은 호스트의 `~/.token-forge/locks/` 잠금(자동 회수 없음)이 있으면 up/seed도 거부한다. 호스트 간 잠금은 없다. 모드 관련 출력·컨텍스트를
바꾸면 `lib/usage-mode.ts`, 스택, `cli/commands/up.ts`, 관련 테스트를 함께 수정할 것.

**새 모델 추가** = `models/<name>.yaml` 1개 (스키마: 최상위 `model`/`vllmImage`/`profiles`,
프로파일별 `weightsRepo`/`instanceType`/`vllmFlags`/`maxModelLen` — 파서가 누락·빈 문자열 거부).
solar-open2-250b는 Upstage 포크 vLLM 이미지 필수, `maxModelLen` 131072 캡 유지.

## 테스트 작성 시 주의

- CDK 단위 테스트 환경의 AZ는 `dummy1a`/`dummy1b`로 합성된다 — `-c azs=` 관련 테스트는
  실제 AZ 이름이 아닌 dummy 이름으로 작성.
- 스테일 컴파일 산출물(`*.js`/`*.d.ts`, gitignored)이 ts-jest에서 `.ts`를 가릴 수 있었다 —
  jest.config.js의 `moduleFileExtensions`를 `.ts` 우선으로 바꿔 막았지만, 테스트가 설명 불가하게
  실패하면 여전히 먼저 삭제해 볼 것.
- 스택 테스트는 `makeTemplate()` 헬퍼(solar int4 프로파일 기준)를 재사용하고, 컨텍스트가
  필요한 케이스만 별도 `cdk.App({ context })`로 만든다.

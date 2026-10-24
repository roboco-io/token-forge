# 사용 모드(interactive / batch / online)와 비용 설명 — 구현 계획·작업 기록 (#43)

이슈: https://github.com/roboco-io/token-forge/issues/43. 이 문서는 이슈의 설계 초안을 구현 가능한 규칙으로
구체화한 결론, 초안과 다르게 정한 부분, 테스트 결과와 검증 한계, Ralph Loop 반복 리뷰 기록을 담는다.
작업 방식은 사용자의 지시에 따라 Ralph Loop(같은 프롬프트로 세션을 반복해 구현 → 검증 → 리뷰를 되풀이)로
진행했다. 반복 1-4의 기능 검증은 mock과 오프라인 합성으로 수행했고, 그 단계에서는 실제 배포·GPU 기동을 하지 않았다.
이후 사용자 지시로 기존 스택 1개에 실제 배포했다(GPU 기동 없음). 결과는 7절에 있다.

## 1. 배경

README의 기본 유휴 종료 30분에 대해 비용 피드백이 있었다. 예시 단가 $2.60/h를 가정하면 세션 종료 후 30분은
$1.30이고, 하루 2회 × 30일이면 $78이다. 기존 유휴 감시는 ALB 요청 수만 보므로 배치 작업 완료, 대화형 사용자의
휴식, 트래픽을 기다리는 온라인 서비스를 구분하지 못한다. 그래서 사용 목적별 기본 정책(사용 모드)을 도입하고
README의 비용 설명을 정정한다.

## 2. 설계 결론

### 2.1 공통 정책 해석기 (`lib/usage-mode.ts`)

CDK 컨텍스트(`-c usageMode`, `-c idleMinutes`, `-c minCapacity`)와 CLI 옵션(`--usage-mode`, `--idle-minutes`)은
같은 함수 `resolveUsagePolicy()`로 해석한다. 두 경로가 서로 다른 기본값이나 검증 규칙을 갖지 않게 하기 위해서다.
CLI는 해석된 값을 `policyContextArgs()`로 전부 명시해 `cdk deploy`에 넘기며, CDK 쪽 기본값에 기대지 않는다.
이 왕복이 같은 정책을 만드는지는 `test/usage-mode.test.ts`가 확인한다.

| 모드 | idleMinutes 기본 | 명시값 규칙 | CDK minCapacity 기본 | READY 후 CLI가 거는 min |
| --- | --- | --- | --- | --- |
| interactive (생략 시) | 30 | 0(비활성, 기존 호환) 또는 5의 배수 5-1440 | 1 (직접 CDK 호환) | 0 |
| batch | 30 (백스톱) | 5의 배수 5-1440, 0은 거부 | 0, 1은 거부 | 0 |
| online | 0 | 0만 허용, 그 외 거부 | 1 | 1 |

우선순위는 "명시값 > 모드 기본값"이다. 모드 목적과 충돌하는 명시값은 무시하지 않고 오류로 거부한다.
idleMinutes는 정수 문자열·숫자만 받으며 5의 배수가 아니면 거부한다. 기존 구현은
`Math.round(idleMinutes / 5)`로 반올림해서, 예를 들어 12분을 10분 평가로 만들어 더 일찍 종료할 수 있었다.
상한 1440분은 5분 × 288 평가 주기 = 24시간으로, CloudWatch 알람 평가 기간 총합 1일 이내로 둔 값이다.
기본 30분은 초안대로 유지했다(단축하지 않음).

### 2.2 CDK 스택

스택은 정책을 해석해 ASG `MinSize`와 유휴 알람·Lambda 생성 여부를 정하고, 출력 `UsageMode`와 `IdleMinutes`를
남긴다. 모드는 유휴 알람·Lambda와 ASG MinSize만 바꾸며 Launch Template(user-data)은 바꾸지 않는다. 그래서
기존 스택의 모드를 바꾸는 `cdk deploy`가 실행 중인 인스턴스 교체를 일으키지 않는다(LT 동일성 테스트로 확인).

### 2.3 CLI `tkf up` — 기존 스택에도 정책 반영

`ensureStackReady()`는 기존 스택이 있으면 출력의 `UsageMode`/`IdleMinutes`를 요청 정책과 비교한다. 다르면
GPU를 올리기 전에 `cdk deploy`로 갱신하고, 배포 후 출력이 여전히 다르면 실패한다. 출력이 없는 구버전 스택의 처리는
반복 3에서 바뀌었다(아래 반복 3 기록 참고: 기본 요청은 배포 없이 사용, 그 외는 수동 갱신 안내). 정책을 넘기지 않는 `tkf seed` 경로는 기존 스택을 건드리지
않는다(신규 생성 시에는 기본 interactive). CLI는 항상 `-c minCapacity=0`으로 배포하므로 스택 생성·갱신은 스팟
확보와 분리된다. online은 READY(인증 프로브 200) 직후 `setCapacity(asg, min=1, desired=1)`을 적용하고, 이 적용이
실패하면 성공으로 보고하지 않는다. `tkf down`은 기존처럼 `setDesired(0)` = MinSize 0 + Desired 0이므로 online도
항상 내릴 수 있다. 자동 리전 경로(`runUpAuto`)는 race·single·lazy 모두 후보별 `ensure`와 승자 `wait`에 같은
정책을 넘긴다.

### 2.4 batch 작업 래퍼 `tkf run`

```
tkf run <model> --region <r> [--profile p] [--idle-minutes N] [--boot-timeout 30] [--timeout 120] -- <command> [args...]
```

`runBatch()`(`cli/commands/run.ts`)의 순서는 다음과 같다. 로컬 잠금 획득 → 신호 핸들러 등록 → `ensureStackReady`
(소유권 검사 + batch 정책 반영) → ASG 이름 확인(이 시점부터 이 실행이 정리 책임을 짐) → `waitReady`(부팅 제한
시간, 신호를 받으면 대기 즉시 중단) → API 키 조회 → 자식 프로세스 실행 → 정리 → 이전 state.json 복원.

자식 프로세스는 셸 없이 `spawn(cmd, args)`로 실행하고, `TKF_ENDPOINT`, `TKF_MODEL`, `TKF_API_KEY`,
`OPENAI_BASE_URL`, `OPENAI_API_KEY`를 환경변수로만 받는다. 로그와 결과 메시지에는 키를 넣지 않는다.
종료 코드는 자식의 코드이고, 124 = 작업 시간 제한, 127 = spawn 실패, 130/143/129 = SIGINT/SIGTERM/SIGHUP 취소다.
시간 제한과 취소 시에는 SIGTERM을 보내고 10초 유예 후 SIGKILL을 보낸다. 정리는 `setDesired(0)` 후 ASG를 다시 읽어
desired=0인지 확인하며, 실패하면 작업 결과와 정리 오류를 함께 메시지에 남기고 작업이 성공했더라도 종료 코드를
0이 아닌 값으로 만든다.

소유권 조건은 다음과 같다(반복 2에서 강화). batch 요청 시 스택에 desired>0이거나 인스턴스(Pending·InService·
Terminating 등 상태 무관)가 남아 있으면 시작을 거부하고 아무 ASG 설정도 바꾸지 않는다. 이 검사는 배포 전
(`ensureStackReady`)과 desired를 올리기 직전(배포·시딩이 수 분 걸리므로) 두 번 한다. 반대로 batch 스택에서 GPU가 있으면
interactive/online 요청(`tkf up`)도 거부한다. 같은 호스트에서는 `~/.token-forge/locks/<stack>@<region>.lock`이
두 번째 `tkf run`과, 준비 단계(desired=0)의 batch를 `tkf up`/`tkf seed`가 인수하는 경쟁을 막는다. 잠금은 pid를 다 쓴
임시 파일을 `link()`로 만들어(대상이 있으면 EEXIST로 원자적 실패) 빈 잠금이 보이는 순간이 없고, 남은 잠금은 자동
회수하지 않는다(회수의 read→rm→create 경쟁으로 새 소유자 잠금을 지울 수 있어서). 오류 메시지에 pid와 파일 경로를
보여 사용자가 확인 후 지운다. 호스트 간 잠금은 없다.

자식은 별도 프로세스 그룹(`detached`)으로 실행하고 신호는 그룹 전체에 보낸다. 자식이 끝나면 그룹에 남은 손자를
SIGKILL로 정리하고, 이후 kill 호출은 아무것도 하지 않는다. 취소·시간 제한으로 예약한 SIGKILL 타이머는 작업 종료 시
모두 취소한다. 분리된 그룹은 터미널 Ctrl-C를 직접 받지 않으므로 tkf가 받은 신호를 SIGTERM으로 전달하며, stdin이
TTY면 백그라운드 그룹의 TTY 읽기 정지(SIGTTIN)를 피하려고 stdin을 주지 않는다(파이프 stdin은 전달). 잠금 이후의
모든 단계는 바깥 `try/finally`에서 신호 핸들러와 잠금을 해제한다. 이전 state.json 복원 실패는 GPU 정리 실패와
별개 메모로 보고하며 종료 코드에 영향을 주지 않는다.

## 3. 초안과 다르게 정한 부분 (결정과 이유)

1. **batch 스택은 유휴 알람을 "백스톱"으로 유지한다.** 초안은 "작업 동안 요청 기반 종료를 사용하지 않는다"였다.
   이 요구는 작업 중 1분 간격 하트비트(무인증 `/v1/models` 핑, 기존 race가 쓰던 방식)로 알람 발화를 막아 충족한다.
   알람 자체를 없애면 `tkf run`이 SIGKILL로 죽거나 호스트가 유실됐을 때 GPU를 내릴 장치가 없어진다. 이 프로젝트의
   비용 규칙(CLAUDE.local.md: 유휴 방치 금지)을 우선해, 하트비트가 끊긴 뒤 idleMinutes(기본 30분) 후 GPU가 정지되게
   했다. 그래서 batch에서 `idleMinutes=0`은 거부한다.
2. **batch는 `--region` 필수(단일 리전).** 레이스로 여러 리전 GPU를 동시에 올리면 소유권 확인과 정리 대상이 늘어난다.
   초안의 명령 형태도 `--region`을 포함하므로 이번 범위에서는 단일 리전만 지원한다.
3. **작업 시간 제한 기본 120분.** 하트비트가 작업 동안 유휴 정지를 막으므로, 멈춘 작업은 무기한 과금될 수 있다.
   기본 제한을 두고 `--timeout 0`으로만 무제한을 허용한다.
4. **state.json 처리.** `ensureStackReady`가 run 리전을 state에 저장하므로 실행 중에는 `tkf down`이 run 리전을
   대상으로 한다(비정상 종료 복구용). 정리가 성공하면 실행 전 state를 복원해 다른 리전 대화형 세션의 `tkf down`
   대상을 보존하고, 정리가 실패하면 run 리전 state를 남긴다.
5. **jest 해석 순서 변경.** 기본 `moduleFileExtensions`가 `.js`를 먼저 찾아 tsc 산출물이 `.ts`를 가렸다.
   `.ts` 우선으로 바꿔 테스트가 항상 실제 소스를 검증하게 했다.
6. **docs/value-proposition.md도 정정.** README가 비용 근거로 링크하는 문서에 같은 "쓴 시간만큼만" 표현이 있어
   함께 고쳤다.

## 4. 알려진 한계

- interactive의 ALB RequestCount 감시는 실행 중인 긴 스트리밍 응답이나 대기 작업을 보지 못한다. 기본값을 안전하게
  줄이려면 실행·대기 요청 수와 최근 활동을 보는 별도 활동 감시가 필요하며, 이번 변경 범위가 아니다.
- CloudWatch 5분 주기 평가와 결측 데이터 처리 때문에 실제 정지는 설정값보다 몇 분 늦을 수 있다(정확한 과금 종료
  시각이 아님).
- 잠금은 같은 호스트 안에서만 동작한다. 두 호스트가 같은 순간에 시작하면 둘 다 ASG 검사를 통과할 수 있다.
- `tkf run`이 SIGKILL·호스트 유실로 끝나면 자동 정리는 보장되지 않는다. 정지 Lambda는 유휴 알람이 ALARM으로
  "바뀔 때"만 실행되므로, 부팅 프로브가 알람을 OK로 돌리기 전(GPU 요청 후 대략 처음 5-10분)에 죽으면 새 상태 변화가
  없어 GPU가 계속 실행된다. 정상적으로 발화하더라도 5분 평가와 이벤트 전달 지연으로 설정 시각보다 늦다. 복구는
  `tkf down --region <r>` 후 `tkf status` 확인이다(README 3개 언어에 기록). 이 구멍을 닫으려면 주기적으로 알람 상태와
  ASG를 보는 별도 감시가 필요하지만, 부팅 중 인스턴스를 잘못 내릴 위험이 있어 이번 범위에서 제외했다.
- 정리 성공은 ASG desired=0이 받아들여졌다는 뜻이며 인스턴스 종료·과금 중단 시점까지 확인한 것이 아니다.
- `setsid` 등으로 프로세스 그룹을 벗어난 손자 프로세스는 정리하지 않는다.
- 실제 AWS 배포·스팟 확보·CloudWatch 알람 발화·CFN 갱신이 인스턴스를 교체하지 않는지는 실환경에서 검증하지 않았다.
  LT 동일성은 합성 템플릿 비교로만 확인했다.

## 5. 검증 결과 (반복 1, 2026-10-24)

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| 기준선(변경 전) | `npx jest --runInBand` (stale JS 삭제 후) | 146 통과 |
| 전체 테스트 | `npx jest --runInBand` | 26 스위트, 223 통과 |
| 타입 검사·빌드 | `npm run build` | 통과 |
| stale JS 차단 | `cli/commands/run.js`를 일부러 깨진 내용으로 바꾼 뒤 `test/cli-run.test.ts` 실행 | 19 통과(.ts 사용 확인) 후 원복 |
| 오프라인 합성 | 임시 디렉터리 + 더미 AZ 컨텍스트, `AWS_EC2_METADATA_DISABLED=true CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 cdk synth --no-lookups` | 아래 표 |

| 합성 컨텍스트 (qwen3-coder-30b/fp8) | UsageMode | IdleMinutes | ASG Min/Max | 유휴 알람 평가 주기 |
| --- | --- | --- | --- | --- |
| `usageMode=interactive` | interactive | 30 | 1/1 | 6 |
| `usageMode=batch` | batch | 30 | 0/1 | 6 |
| `usageMode=online -c minCapacity=0` | online | 0 | 0/1 | 없음 |
| `usageMode=online` | online | 0 | 1/1 | 없음 |
| `idleMinutes=60` | interactive | 60 | 1/1 | 12 |
| `solar-open2-250b/int4` 기본 | interactive | 30 | 1/1 | 6 |

거부 확인(합성 rc=1): `online + idleMinutes=30`, `batch + minCapacity=1`, `idleMinutes=12`, `usageMode=bogus`.
리포지토리의 `cdk.context.json`(사용자 계정 AZ 캐시)은 건드리지 않기 위해 합성은 `/tmp`의 별도 `cdk.json`과
더미 AZ 컨텍스트로 실행했다. 첫 합성 시도는 zsh가 `$m`을 단어 분리하지 않아 컨텍스트가 전달되지 않았고,
`${=m}`으로 고쳐 다시 실행한 결과가 위 표다. 이 과정에서 비용 검사 훅이 합성 명령에 포함된
`idleMinutes=0` 케이스를 지적했다. 해당 명령은 `cdk synth`뿐이라 리소스가 생성되지 않았고, 이후 합성에서는 그 값을 쓰지 않았다
(`idleMinutes=0` 해석은 단위 테스트로 검증).

추가된 테스트 파일: `test/usage-mode.test.ts`(정책 해석·우선순위·왕복), `test/token-forge-stack.test.ts`의
`usage modes (#43)`(합성), `test/cli-usage-mode.test.ts`(기존 스택 비교·배포 결정, online min=1, down, 자동 경로 전달),
`test/cli-run.test.ts`(batch 래퍼: 성공/실패/spawn 오류/시간 제한/SIGINT·SIGTERM/부팅 중 취소/부팅 제한/정리 실패·검증/
소유권/잠금/state 복원), `test/cli-program.test.ts`(명령 등록·`--` 파싱·실제 자식 프로세스 spawn/ENOENT/kill),
`test/readme-cost.test.ts`(README 3개 언어 비용 문구). 스택·CLI 테스트는 구현 전에 추가해 실패를 먼저 확인했다.

## 6. 반복 리뷰 기록

### 반복 1

구현과 위 검증을 마쳤다. diff와 완료 조건에 대한 독립 리뷰는 반복 2에서 수행한다.

### 반복 2 (2026-10-24)

리뷰 메모(소유권, 잠금, 프로세스 정리, 문서, 합성 검증, 테스트 범위)와 실제 diff를 다시 검토해 다음 결함을 고쳤다.

| 지적 | 판단 | 조치 |
| --- | --- | --- |
| 소유권 검사가 desired=0·InService 없음이면 Pending/Terminating 인스턴스를 놓침 | 결함 | `instanceIds` 전체로 판정, batch·기존 batch 스택 양쪽 회귀 테스트 |
| 배포·시딩(수 분) 사이 다른 세션이 GPU를 올리면 batch가 인수 | 결함 | desired를 올리기 직전 재검사, 테스트(설정 호출 0회 확인) |
| 같은 호스트 `tkf up`/`seed`가 준비 중 batch를 인수 | 결함 | ensure가 같은 호스트 잠금을 확인(`batchLockHolder`, run 자신은 미주입), 테스트 |
| 잠금 wx→pid 쓰기 사이 빈 파일, 죽은 잠금 회수 경쟁 | 결함 | `link()` 원자 생성, 자동 회수 제거·수동 해제 안내, 테스트 |
| 취소 신호의 SIGKILL 타이머 미취소 | 결함 | 작업 종료 시 모든 타이머 취소, 테스트 |
| 잠금 이후 예외(loadState 등)에서 잠금·핸들러 누수 | 결함 | 바깥 try/finally, 테스트 |
| 상태 복원 실패와 GPU 정리 실패 혼동 | 결함 | 별개 메모로 보고, 테스트 |
| 신호 무시 자식·손자 잔존 | 결함 | 프로세스 그룹 kill + 종료 후 그룹 SIGKILL, 실제 자식 프로세스 테스트 4개(시간 제한·SIGINT·정상 종료 손자·ENOENT) |
| online min=1 실패 시 상태·복구 안내 | 확인 | 이미 실패 보고. state 보존과 `tkf down` 안내를 테스트로 고정 |
| 백스톱이 정확한 종료를 보장하는 것처럼 서술 | 문서 결함 | ALARM 상태 유지 시 미발화 한계를 README·이 문서에 명시 |
| `tkf down`/정리 = 즉시 과금 0으로 읽히는 표현 | 문서 결함 | "용량 0 요청 수락, 종료는 수 분" 으로 정정 |
| CLAUDE.md "가드를 끄지 말 것"과 online 모순 | 문서 결함 | interactive·batch 유지, online은 명시 선택으로 정리 |
| `--region` 생략 자동 선택 설명이 run과 혼동 | 문서 결함 | `tkf up`에 한정 |
| 합성 검증이 셸 문자열·파이프로 재현성 부족 | 결함 | `scripts/verify-usage-mode-synth.ts`(배열 인자, 케이스별 새 출력 디렉터리, exit·값 assert) |
| README 문구 고정 테스트 | 저가치 | `test/readme-cost.test.ts` 삭제, 문서는 이 검토 기록으로 확인 |

반복 2의 회귀 테스트는 수정과 같은 단계에서 추가했으며, 수정 전 코드에서 실패하는 것을 별도로 관찰하지는 않았다
(반복 1의 스택·CLI 테스트는 구현 전 실패를 관찰했다).

검증(반복 2, 수정 후 실행):

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| 전체 테스트 | `npx jest --runInBand` | 25 스위트, 231 통과 |
| 타입 검사·빌드 | `npm run build` | exit 0 |
| 오프라인 합성 | `npx ts-node scripts/verify-usage-mode-synth.ts` | exit 0, `PASS 12 cases` (정상 7, 거부 5) |
| 잔존 프로세스 | 테스트 후 `pgrep -fl setInterval` | 없음 |

합성 스크립트의 정상 케이스: 기본(interactive/30/min1/알람 6주기), interactive+min0, idleMinutes=60(12주기),
idleMinutes=0(합성만, 알람 없음), batch(30/min0/알람 6주기), online+min0, online(min1, 알람 없음).
거부 케이스: online+idle30, batch+min1, batch+idle0, idle12, bogus 모드.

### 반복 3 (2026-10-24)

필수 추가 리뷰 4건을 반영했다.

1. **기존 스택 갱신 시 보안·운영 컨텍스트 유실(치명).** 스택이 읽는 컨텍스트는 `usageMode`, `idleMinutes`,
   `minCapacity`, `azs`, `allowedCidrs`, `alertEmail`(앱: `model`, `profile`, `region`, `collector`)이다. 반복 2의 자동
   `cdk deploy`는 `azs`/`allowedCidrs`/`alertEmail`을 넘기지 않아, 최초 배포 때 지정한 IP 허용목록이 풀리고 AZ 선택·알림
   구독이 초기화될 수 있었다. 스택이 실제 적용한 세 값을 출력 `DeploymentSettings`(v1 JSON, `lib/deployment-settings.ts`)에
   기록하고, 정책 갱신 배포 때 이 값을 인자 배열로 다시 전달한다. 배포 후 기록이 달라지면 실패한다. 기록이 없거나
   손상·미지원 버전이면 기본값으로 바꾸지 않고 자동 배포를 거부하며 수동 `npx cdk deploy` 명령을 안내한다.
   구버전 스택(모드 기록 없음) + 기본 interactive/30분 요청은 이전 CLI와 같이 배포 없이 그대로 사용하고, 그 외 요청은 수동
   갱신을 안내한다(반복 1의 "구버전은 자동 1회 갱신"을 철회 — 보안 보존 우선). 정책이 같으면 기록 유무와 관계없이 배포하지
   않는다. 회귀 테스트: interactive→online, idleMinutes 변경, online→interactive, interactive→batch에서 세 값 보존, 빈 설정은
   인자 미추가, 배포 후 설정 변화 실패, 기록 없음·손상 3종 거부(배포 0회), 구버전 기본 요청 무배포, 구버전 모드 변경 거부,
   정책 동일 시 무배포. 스택 합성 테스트로 출력 기록(정규화된 CIDR 포함)을 확인. 이 테스트들은 구현 전에 추가해 11건 실패를
   먼저 관찰했다.
2. **키 조회 중 취소 시 자식이 잠깐 실행됨.** `getSecret` 직후 취소를 다시 확인해 자식을 시작하지 않는다. 해당 구간 SIGINT
   테스트를 먼저 추가해 실패(타임아웃)를 관찰한 뒤 수정했다.
3. **합성 스크립트의 app 문자열 인용.** cdk CLI는 `cdk.json`의 `app`을 셸로 실행하므로 각 경로를 POSIX 작은따옴표로
   인용했다(macOS/Linux 전용). 저장소를 공백·작은따옴표가 포함된 임시 경로(예: `<tmp>/tf root's dir`)의 심볼릭 링크로 열고
   `--preserve-symlinks`로 실행해 스크립트의 ROOT가 그 경로임을 확인했고, 13케이스가 통과했다. 스크립트에 보안 설정 케이스
   (allowedCidrs/azs/alertEmail → DeploymentSettings)와 모든 케이스의 DeploymentSettings 검사를 추가했다.
4. **README 절대 표현.** batch 표의 "유휴 꼬리 없음"을 "정지 요청·인스턴스 종료까지 몇 분은 남음, 유휴 대기는 없음"으로,
   "인수·정지하지 않는다"를 "보이는 인스턴스는 인수·정지하지 않으며 같은 순간 시작하는 다른 호스트는 볼 수 없음"으로
   3개 언어 모두 고쳤다. 마이그레이션 절(구버전 스택 처리와 수동 갱신 명령)을 추가했다. CLAUDE.md에 DeploymentSettings 규칙을 추가했다.

검증(반복 3, 마지막 코드 수정 후 실행):

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| 전체 테스트 | `npx jest --runInBand` | 25 스위트, 246 통과 |
| 타입 검사·빌드 | `npm run build` | exit 0 |
| 오프라인 합성 | `npx ts-node scripts/verify-usage-mode-synth.ts` | exit 0, `PASS 13 cases` (정상 8, 거부 5) |
| 공백·따옴표 경로 합성 | 위 스크립트를 공백·작은따옴표 포함 임시 경로로 실행 | exit 0, `PASS 13 cases` |
| 잔존 프로세스 | `pgrep -fl setInterval` | 없음 |

합성 이후 수정한 파일은 `cli/commands/run.ts`(취소 재확인)와 문서뿐이며, 합성 대상인 스택·앱 코드는 합성 후 바뀌지 않았다.
실제 AWS 배포는 하지 않았으므로 DeploymentSettings 출력이 실제 CFN 스택에서 기대대로 읽히는지, 갱신 배포가 CloudFront
Function·SNS 구독을 바꾸지 않는지는 합성·단위 테스트 수준에서만 확인했다.

### 반복 4 (2026-10-24)

Stop hook이 같은 프롬프트로 다시 시작해 반복 3 이후 상태를 다시 검토했다. 검토 범위는 반복 3 필수 리뷰 4건의 반영 여부와
그 외 경로였다. 그 외 경로는 `tkf down --purge`의 `cdk destroy`, `tkf seed`의 정책 미지정 경로, 자동 리전 `ensure`의 같은 호스트
잠금 확인, 재전달된 `allowedCidrs`(정규화 값 재입력 시 동일)와 `alertEmail` 구독의 불변성이다. 새 치명·중요 결함은 찾지 못했다.

이번 반복에서는 코드를 바꾸지 않았다. 반복 3 검증 로그 이후 수정된 `.ts` 파일이 없는 것을 `find -newer`로 확인했다.
그래서 검증을 다시 실행하지 않고 반복 3 결과를 근거로 삼는다(테스트 246 통과, 빌드 exit 0, 합성 `PASS 13 cases`).

알려진 동작으로 기록만 하는 사항이 하나 있다. `waitReady`는 READY 전에 desired=0을 보면 desired=1로 복구한다. 이것은 이번 변경 전부터
있던 동작이다. 그래서 부팅 중에 다른 터미널에서 `tkf down`을 실행하면 GPU가 다시 올라갈 수 있다. 이번 범위에서는 바꾸지 않았다.

## 7. 실제 배포 기록 (2026-10-24)

사용자의 "배포해" 지시에 따라 기존 스택 한 개에 이 변경을 배포했다. 대상은 운영 AWS 계정(`<ACCOUNT_ID>`, 로컬 AWS 프로파일 사용),
리전 ap-northeast-2, 스택 `TokenForge-qwen3-coder-30b-fp8`(모델 `qwen3-coder-30b`, 프로파일 `fp8`)이다. 배포 전 ASG는
min=0, desired=0, 인스턴스 0개였다. 기존 설정을 유지하려고 `-c usageMode=interactive -c idleMinutes=30 -c minCapacity=0`을
주었고, `allowedCidrs`·`azs`·`alertEmail`은 기존 스택처럼 지정하지 않았다.

배포는 두 단계로 했다. 먼저 `cdk deploy --method prepare-change-set --change-set-name tkf-usage-modes-43`으로 변경 세트만
만들고, `describe-change-set`으로 내용을 검토한 뒤 `execute-change-set`을 실행했다. 실행 시각은 2026-10-24T05:04:26Z이고,
05:04:43Z에 `UPDATE_COMPLETE`가 되었다. 실패나 롤백은 없었다.

변경 세트의 리소스 변경은 `LaunchTemplate04EC5460` Modify 1건이었다(Replacement=False). 이벤트상 ASG는 새 Launch Template
버전을 참조하도록 갱신만 되었다. 이 변경의 원인은 두 가지다. 첫째, 이전 배포 때 템플릿에 저장된 user-data 주석과 알람 설명의
비ASCII 문자(한국어, em dash)가 `?`로 손실되어 있었고, 이번 템플릿은 원래 문자를 담고 있다. 비ASCII를 마스킹하면 두 템플릿의
해당 리소스는 같다. 둘째, SSM 파라미터로 가져오는 DLAMI latest 값이 바뀌었다. Launch Template 이미지는 이전 DLAMI AMI(버전 2)에서
새 DLAMI AMI(버전 3)로 바뀌었다. 소스의 이미지 참조 방식(SSM latest 파라미터)은 바뀌지 않았다.
리소스 추가·삭제, 보안 규칙 변경은 없었고, 새 출력 3개(`UsageMode`, `IdleMinutes`, `DeploymentSettings`)가 추가되었다.

배포 후 실제 조회로 다음을 확인했다. 출력은 `UsageMode=interactive`, `IdleMinutes=30`,
`DeploymentSettings={"v":1,"allowedCidrs":"","azs":"","alertEmail":""}`이고, `EndpointUrl`은 기존
CloudFront 엔드포인트(`https://<distribution>.cloudfront.net`) 그대로다. 템플릿에는 CloudFront Function과 SNS 이메일 구독이 없고, ASG는 서브넷 4개를
사용하며 온디맨드 비율은 0%(100% 스팟, capacity-optimized)다. ASG는 min=0, desired=0, 인스턴스 0개다. 유휴 알람은 5분 × 6회
(30분) 그대로다.

글로벌 `tkf`는 `npm link --ignore-scripts`로 이 작업 트리의 빌드에 연결했다. `tkf run --help`, `tkf up --help`(`--usage-mode`,
`--idle-minutes` 표시), `tkf status`(모드 interactive, 유휴 종료 30분, desired=0)로 적용을 확인했다. npm 배포, 버전 변경,
커밋은 하지 않았다. 종료 전 ap-northeast-2, ap-northeast-1, us-east-1, us-east-2에서 pending/running 인스턴스가 0개인 것을
확인했다.

한계: GPU를 기동하지 않았으므로 새 AMI로의 부팅, vLLM 추론, `tkf run`의 실제 batch 실행, online 모드 전환은 실환경에서
검증하지 않았다. 증거(변경 세트 JSON, 이벤트, 배포 전후 템플릿, 로그)는 로컬 임시 디렉터리에만 보관했다.

# 스팟 배치 점수 수집기 설계

날짜: 2026-08-06
상태: 승인됨

## 배경

p5.48xlarge 스팟 확보 시도(2026-08-04)가 `UnfulfillableCapacity`로 실패했다. 어느 시간대에
스팟 여유가 생기는지 판단하려면 배치 점수(`GetSpotPlacementScores`)의 시계열이 필요하지만,
AWS는 이 지표의 과거 이력을 제공하지 않는다. 직접 주기 수집해 쌓는다.

## 요구사항 (확정)

- 수집 대상: **p5.48xlarge만** (추후 타입 추가 용이하게)
- 수집 리전: us-east-1, us-east-2, us-west-2
- 수집 단위: 리전 점수 + AZ 점수 둘 다
- 간격: 1시간
- 보존: DynamoDB TTL 90일
- 구현: AWS Lambda + DynamoDB, CDK(TypeScript)

## 아키텍처

**기존 서빙 스택(`TokenForge-<model>-<profile>`)과 완전히 분리된 별도 스택**
`TokenForge-SpotScoreCollector`로 구현한다. 서빙 스택을 destroy해도 수집은 계속된다.
배포 리전은 us-east-1, 상시 가동. 예상 비용 월 $0.01 미만.

```
EventBridge Rule rate(1 hour)
  → Lambda CollectorFn (inline 코드, NODEJS_22_X, 기존 IdleStopFn 관례)
      1. GetSpotPlacementScores(리전 단위, 3개 리전 일괄)
      2. GetSpotPlacementScores(SingleAvailabilityZone=true, AZ 단위)
      3. 결과 ~21건 → DynamoDB BatchWriteItem 1회
  → DynamoDB ScoresTable
```

### bin 연동 (컨텍스트 게이트)

`bin/token-forge.ts`에서 `-c collector=1`일 때 **수집기 스택만** 합성하고,
그 외에는 기존처럼 서빙 스택만 합성한다. 기존 배포 명령 UX는 변경 없음.

```bash
npx cdk deploy -c collector=1               # 수집기 배포
npx cdk destroy -c collector=1              # 수집기 삭제
```

### DynamoDB 스키마

| 항목 | 값 |
|---|---|
| 테이블 | 온디맨드 과금, TTL 속성 `expireAt` |
| PK `scope` (S) | `region#us-east-1` 또는 `az#use1-az4` |
| SK `ts` (S) | ISO8601 UTC (예: `2026-08-06T05:00:00Z`) |
| 속성 | `score`(N), `instanceType`(S), `expireAt`(N, 수집 시각+90일 epoch초) |
| RemovalPolicy | `DESTROY` — 전체 삭제 시 잔존물 없음 (이력 보존 원하면 RETAIN으로 변경) |

시간대 추이 조회는 `scope` PK + `ts` range 쿼리로 커버. GSI 없음.

### Lambda 환경변수

`TABLE_NAME`, `INSTANCE_TYPES`(콤마 구분, 초기값 `p5.48xlarge`),
`REGIONS`(콤마 구분), `TTL_DAYS`(기본 90).

### 오류 처리

- 리전/AZ 호출 중 한쪽 실패: 성공한 쪽만 저장, 실패는 `console.error` 로그.
- 둘 다 실패: throw → Lambda 오류 메트릭 노출 + EventBridge 기본 재시도.
- BatchWriteItem `UnprocessedItems`: 1회 재시도 후 남으면 로그.

### IAM

- `ec2:GetSpotPlacementScores` (리소스 `*` — 이 API는 리소스 수준 제한 미지원)
- 테이블 한정 `dynamodb:BatchWriteItem`

## 테스트

`test/spot-score-collector-stack.test.ts` (기존 스택 테스트와 독립):

- 테이블: PK/SK 스키마, TTL 활성(`expireAt`), 온디맨드 모드
- 스케줄: `rate(1 hour)` Rule → Lambda 타깃
- Lambda: NODEJS_22_X, 환경변수 4종 주입
- IAM: ec2:GetSpotPlacementScores + dynamodb:BatchWriteItem 정책 존재

bin 게이트는 jest 대상이 아님(엔트리 파일은 테스트에서 import하지 않는 기존 관례) —
`npx cdk synth -c collector=1 --quiet` / 무컨텍스트 synth로 수동 검증한다.

## 하지 않는 것 (YAGNI)

- 조회 UI/대시보드 — 분석은 애드혹 쿼리(필요 시 후속으로 리포트 스크립트 추가)
- 알람/SNS — Lambda 오류 메트릭으로 충분
- 다중 인스턴스 타입 수집 — env 변경만으로 추가 가능하게 해두되 초기값은 p5만

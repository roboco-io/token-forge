# EC2 GPU 쿼터(용량) 증설 요청 가이드

token-forge로 GPU 인스턴스를 띄우려면 먼저 **vCPU 기반 쿼터**를 확보해야 한다.
신규 계정은 GPU 쿼터가 대부분 **0**이며, 승인은 자동이 아니라 사람이 심사한다.
이 문서는 실제 승인 과정(2026-07, p5 스팟 192 요청)에서 얻은 절차와 문안 작성법을 정리한 것이다.

## 1. 어떤 쿼터가 필요한가

쿼터는 **인스턴스 패밀리 × 구매옵션(스팟/온디맨드)** 단위의 vCPU 총량이다.

| 쿼터 이름 | 코드 | 대상 | token-forge 용도 |
|---|---|---|---|
| All P Spot Instance Requests | `L-7212CCBC` | p3/p4/p5 스팟 | **solar-open2-250b: p5.48xlarge = 192 필요** |
| All G and VT Spot Instance Requests | `L-3819A6DF` | g4dn/g5/g6/g6e 스팟 | 소형 모델 선검증 (xlarge = 4) |
| Running On-Demand G and VT instances | `L-DB2E81BA` | G 계열 온디맨드 | 스팟 고갈 시 대안 |
| Running On-Demand P instances | `L-417A185B` | P 계열 온디맨드 | 스팟 미배정 시 대안 |

> 인스턴스 크기는 쪼갤 수 없다. p5.48xlarge는 192 vCPU 고정이므로
> 쿼터가 128이면 **한 대도 못 띄운다**. 어필 문안의 핵심 논거가 된다.

## 2. 확인·신청 CLI

```bash
# 현재값 확인
aws service-quotas get-service-quota \
  --service-code ec2 --quota-code L-7212CCBC --region us-east-1 \
  --query 'Quota.[QuotaName,Value]' --output text

# 증설 신청 (예: 192)
aws service-quotas request-service-quota-increase \
  --service-code ec2 --quota-code L-7212CCBC --desired-value 192 --region us-east-1

# 요청 이력/상태 확인
aws service-quotas list-requested-service-quota-change-history \
  --service-code ec2 --region us-east-1 \
  --query 'RequestedQuotas[].[QuotaName,DesiredValue,Status]' --output text
```

상태 의미: `PENDING`(접수) → `CASE_OPENED`(수동 심사, Support 케이스 생성됨) →
`CASE_CLOSED`(종결 — 승인/부분승인/거절 모두 이 상태로 끝나므로 **현재값으로 결과 판단**).

## 3. 심사 흐름과 현실적인 기대치

- **소량(G 계열 4~8 vCPU)**: 보통 수 시간 내 전액 승인.
- **대량(P 계열 100+ vCPU)**: 내부 팀 협의로 넘어가며, 신규·무이력 계정은
  **부분 승인이 일반적**이다 (실측: 192 요청 → 128 승인).
- 부분 승인 메일에는 "케이스를 reopen하고 상세한 use case를 주면 재평가하겠다"는
  안내가 포함된다 — **어필은 공식적으로 열려 있는 절차**다.
- 쿼터가 있어도 신규 계정은 한동안 GPU **스팟 용량 배정 자체가 거부**될 수 있다
  (`InsufficientInstanceCapacity` 반복). 소형 인스턴스로 사용 이력을 만들면 개선된다.

## 4. 어필(재요청) 문안 작성법

Basic 서포트 플랜은 CLI 답글(`aws support` API)이 불가하므로
**Support Center 콘솔의 해당 케이스에서 Reply**로 작성한다. 포함할 요소:

1. **왜 그 숫자여야 하는가** — 인스턴스 크기가 고정이라 부분 승인으로는 0대라는 산수.
2. **무엇을 하는가** — 모델명/오픈소스 여부, 서빙 스택(vLLM 등), 필요 스펙 근거(TP8 → 8 GPU).
3. **절제된 사용 패턴** — 대수 고정(min1/max1), 유휴 자동 셧다운, 월 예상 사용시간.
4. **신뢰 근거** — 자동화된 IaC, 공개 리포 링크, 단기 실험 목적.

### 영어 템플릿

```text
We'd like to appeal for the full <N> vCPUs ("<quota name>", currently <M>).

Use case: short-term inference demo of the open-source LLM <model>
served with vLLM using --tensor-parallel-size <T>. This requires a single
<instance-type> (<G>x <GPU>, <N> vCPUs) Spot instance — the instance size
is fixed at <N> vCPUs, so the current <M> vCPU limit does not allow any
<instance-type> launch.

Usage pattern: a single instance (ASG min=1/max=1, no autoscaling),
intermittent sessions of a few hours with automatic idle shutdown after
30 minutes of no traffic. Expected monthly usage is under ~<H> hours.
Infrastructure is fully automated via AWS CDK (public repo: <repo-url>).

We would appreciate a re-assessment to raise the limit from <M> to <N>. Thank you!
```

## 5. 승인 후 체크리스트

```bash
# 값 반영 확인 (192 이상인지)
aws service-quotas get-service-quota --service-code ec2 --quota-code L-7212CCBC \
  --region <region> --query 'Quota.Value' --output text

# 배포 — 스팟 미배정 대비 -c minCapacity=0 권장 (CFN 생성과 용량 확보 분리)
cdk deploy -c model=solar-open2-250b -c profile=int4 -c region=<region> -c minCapacity=0
scripts/start.sh TokenForge-solar-open2-250b-int4 <region>
```

## 팁 요약

- 여러 리전에 병행 신청해 먼저 열리는 쪽을 쓴다 (쿼터는 리전별).
- 케이스 메일은 no-reply — 답글은 반드시 Support Center에서.
- 심사자 관점에서 "떼일 걱정 없는 소액·단기·자동 회수" 그림을 그려줄 것.
- 선검증(소형 모델)으로 계정에 GPU 사용 이력을 만든 뒤 대형을 요청하면 유리하다.

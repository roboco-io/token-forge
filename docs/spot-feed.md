# 스팟 배치점수 오픈 데이터 피드

roboco가 공개 운영하는 GPU 스팟 인텔리전스 피드입니다. 수집기(`-c collector=1` 스택)가
1시간마다 [Spot Placement Score](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-placement-score.html)와
스팟 가격 히스토리를 수집·집계해 CloudFront로 제공합니다.

- **대시보드**: CloudFront 배포 URL의 `/` (스택 출력 `DashboardCdnUrl`)
- **데이터 피드**: 같은 URL의 `/data.json` — CORS 전면 허용, 캐시 5분
- **커버리지**: 인스턴스 타입·리전은 `lib/spot-score-collector-stack.ts` 상단의
  `INSTANCE_TYPES` / `REGIONS` 상수가 기준. 무한정 추가할 수 없음 —
  `GetSpotPlacementScores`는 계정당 조회 구성 수에 한도가 있다.

## data.json 스키마

```jsonc
{
  "generated": "2026-08-22 05:00 UTC",   // 생성 시각
  "types": ["p5.48xlarge", ...],          // 수집 대상 인스턴스 타입
  "regions": ["us-east-1", ...],          // 수집 대상 리전
  "noPool": {                             // 스팟 풀이 미개설된 리전 (90일 가격 기록 0건 기준)
    "p5.48xlarge": ["ap-northeast-2"]     // 데이터 누락이 아니라 스팟 시장 자체가 없다는 뜻
  },
  "azMeta": {                             // AZ ID → 리전·AZ 이름 매핑
    "apne1-az4": { "region": "ap-northeast-1", "azname": "ap-northeast-1a" }
  },
  "scores":   { "<type>": { "<region>": [["2026-08-06T00:00:00Z", 3], ...] } },
  "azScores": { "<type>": { "<azId>":   [["...", 3], ...] } },
  "prices":   { "<type>": { "<region>": [["...", 4.93], ...] } },  // 리전 내 최저 AZ 스팟가 $/h
  "azPrice":  { "<type>": { "<azName>": 4.93 } }                   // AZ별 현재 스팟가
}
```

- 배치점수는 1~10 (높을수록 몇 시간 내 스팟 확보 성공 가능성↑). 단일 타입 조회는
  저평가 경향이 있으므로 절대값보다 추세·리전 간 비교로 읽을 것.
- 시계열은 최근 14일은 원본 해상도(1시간), 그 이전은 6시간 버킷(점수=최대, 가격=최소)으로
  다운샘플되어 저장 기간은 90일(DynamoDB TTL).
- 가격 시계열은 시간 그리드에 carry-forward한 리전 내 최저가.

## 이용 예

```bash
curl -s "$DASHBOARD_CDN_URL/data.json" | jq '.scores["g6e.48xlarge"]["ap-northeast-1"] | last'
```

무료 제공이며 가용성을 보장하지 않습니다. 점수는 AWS가 제공하는 확률 신호로,
스팟 확보를 보장하지 않습니다.

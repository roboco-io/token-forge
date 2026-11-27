# 스팟 배치점수 오픈 데이터 피드

roboco가 공개 운영하는 스팟 인텔리전스 피드입니다. GPU(p5·g6e·g6·g5·g4dn)와 T·M·C·R·I 계열(버스터블·범용·컴퓨팅·메모리·스토리지 최적화) 타입을 다룹니다. 수집기(`-c collector=1` 스택)가
1시간마다 [Spot Placement Score](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-placement-score.html)와
스팟 가격 히스토리를 수집·집계해 CloudFront로 제공합니다.

- **대시보드**: https://spot.roboco.io — GitHub Pages로 배포(`.github/workflows/dashboard-pages.yml`).
  기존 CloudFront URL의 `/`는 이 주소로 301 리다이렉트된다.
- **데이터 피드**: CloudFront 배포 URL(스택 출력 `DashboardCdnUrl`)의 `/data.json` — CORS 전면 허용, 캐시 5분
- **커버리지**: 수집 대상은 `lib/spot-collector-targets.ts`의 `COLLECT_TARGETS`, 리전은
  `lib/spot-score-collector-stack.ts`의 `REGIONS` 상수가 기준이다. 대상을 한 번에 많이 늘리지 말 것 —
  AWS는 24시간 안에 새로 쓰는 조회 구성의 수를 제한할 수 있다고 문서에 밝히지만 수치는 공개하지 않는다.
  대상 1개는 시간당 조회 2회(리전 단위, AZ 단위)를 쓴다.

## 수집 대상: 단일 타입과 타입 묶음

수집 대상(target)은 `GetSpotPlacementScores` 1회 조회에 함께 넣는 인스턴스 타입의 집합이다.
피드의 `types` 배열과 `scores`·`prices` 등의 키는 이 대상의 id다.

GPU 대상은 인스턴스 타입 1개이며 id가 타입 이름과 같다(`p5.48xlarge`, `g6e.48xlarge` 등).
T·M·C·R·I 대상은 같은 크기의 타입 3개를 묶은 것이고 id는 타입 이름이 아니다(`c.xlarge`,
`r.xlarge-arm` 등). 묶는 이유는 AWS 문서의 제약이다. P·G·Trn·Inf 계열이 아닌 타입을 1-2개만
지정하면 배치점수가 항상 낮게 반환된다. 2026-11-18에 직접 조회했을 때 `t4g.medium` 단독은
4개 리전에서 3점이었고, t4g 3개 묶음은 같은 4개 리전에서 9점이었다.

따라서 묶음 대상의 값은 다음과 같이 읽는다. 점수는 "묶음에 속한 타입 중 어느 것이든 1대"를
확보할 가능성이다. 가격은 묶음에 속한 타입들의 스팟가 중 최저가다. 묶음에 속한 타입은
`typeMeta.<id>.members`에 있다. `t4g.mixed`(medium·large·xlarge)와 `i8g.mixed`(large·xlarge·2xlarge)는
크기가 다른 3개를 묶는다. Graviton 버스터블은 t4g 한 세대뿐이고, Graviton 스토리지 최적화 중 수집 리전
5곳 모두에 있는 세대는 i8g뿐이라 같은 크기 3개를 만들 수 없기 때문이다. 두 대상의 가격은 사실상 묶음에서
가장 작은 크기의 가격이다.

묶음의 타입은 수집 리전 5곳 모두에서 제공되는 것만 쓴다. 어떤 리전에 없는 타입이 섞이면 그 리전에서는
타입 2개로 조회한 것과 같아져 점수가 낮게 나온다. 2026-11-19까지 `c.xlarge`·`r.xlarge`에는 서울 리전에
없는 c6a·r6a가 들어 있어 서울 점수가 3점으로 기록됐고, 같은 날 c5·r5로 교체했다. 그 이전의 서울 점수는
실제 확보 가능성보다 낮게 기록된 값이다.

HPC 계열(hpc6a·hpc7a·hpc7g 등)은 스팟 구매 옵션을 지원하지 않아 수집 대상이 아니다.

수집 대상을 바꾼 뒤에는 대시보드 페이지를 먼저 배포하고(`main`에 push하면 GitHub Pages 워크플로가
실행된다) 그다음에 수집기 스택을 `cdk deploy -c collector=1`로 배포한다. 새 대시보드는 `typeMeta`가
없는 이전 피드도 표시하지만, 이전 대시보드는 묶음 대상이 들어간 새 피드를 받으면 대상마다 설명이
`undefined`로 표시되기 때문이다.

## data.json 스키마

```jsonc
{
  "generated": "2026-08-22 05:00 UTC",   // 생성 시각
  "types": ["p5.48xlarge", "c.xlarge", ...], // 수집 대상 id (GPU는 타입 이름, 그 외는 묶음 id)
  "typeMeta": {                           // 대상별 메타 (구버전 피드에는 없음)
    "c.xlarge": { "family": "c", "arch": "x86", "spec": "4 vCPU · 8 GiB",
                  "members": ["c7i.xlarge", "c6i.xlarge", "c5.xlarge"] },
    "p5.48xlarge": { "family": "gpu", "arch": "x86", "spec": "192 vCPU · 2048 GiB",
                     "gpu": "8×H100", "members": ["p5.48xlarge"] }
  },
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

- 배치점수는 1-10 (높을수록 몇 시간 내 스팟 확보 성공 가능성↑). 단일 타입 조회는
  저평가 경향이 있으므로 절대값보다 추세·리전 간 비교로 읽을 것.
- 시계열은 최근 14일은 원본 해상도(1시간), 그 이전은 6시간 버킷(점수=최대, 가격=최소)으로
  다운샘플되어 저장 기간은 90일(DynamoDB TTL).
- 가격 시계열은 시간 그리드에 carry-forward한 리전 내 최저가이며 소수 4자리까지 기록한다
  (소형 타입은 시간당 $0.01대다). 이 변경 전에 만들어진 피드는 소수 2자리였다.
- `azScores`에는 조회 시점마다 점수 상위 10개 AZ만 기록된다. `GetSpotPlacementScores`가 AZ 단위 조회에서
  상위 10건만 반환하기 때문이다(2026-11-18 실측: `MaxResults`를 100으로 지정해도 10건, `NextToken` 없음).
  AZ가 10개를 넘는 대상(GPU가 아닌 묶음)은 점수가 낮은 AZ의 기록이 비거나 끊길 수 있다.
- 피드는 CloudFront가 gzip·brotli로 압축 전송한다(`Accept-Encoding` 헤더를 보낸 경우).

## 이용 예

```bash
curl -s "$DASHBOARD_CDN_URL/data.json" | jq '.scores["g6e.48xlarge"]["ap-northeast-1"] | last'
```

무료 제공이며 가용성을 보장하지 않습니다. 점수는 AWS가 제공하는 확률 신호로,
스팟 확보를 보장하지 않습니다.

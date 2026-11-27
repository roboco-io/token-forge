"""스팟 대시보드 데이터 퍼블리셔 — 1시간마다 수집기 DDB 점수 + 스팟 가격 히스토리를
집계해 data.json을 대시보드 S3 버킷에 게시한다. (14일 이전 구간은 6h 버킷으로 다운샘플)"""
import json
import os
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import boto3

# 수집 대상(target): GPU는 타입 1개, 그 외는 같은 크기 3개 묶음 — lib/spot-collector-targets.ts가 기준.
# 피드의 키는 대상 id이고, 가격은 대상에 속한 타입(types)들의 기록을 합쳐 최저가로 집계한다.
# 배포 시 스택이 코드 패키지에 targets.json을 넣는다(환경 변수 4KB 한도 때문). 로컬 실행은 TARGETS 환경 변수로 줄 수 있다.
def _load_targets():
    if os.environ.get('TARGETS'):
        return json.loads(os.environ['TARGETS'])
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'targets.json'), encoding='utf-8') as f:
        return json.load(f)


TARGETS = _load_targets()
TYPES = [t['id'] for t in TARGETS]
OWNER = {m: t['id'] for t in TARGETS for m in t['types']}   # 인스턴스 타입 -> 대상 id
MEMBER_TYPES = sorted(OWNER)
REGIONS = os.environ['REGIONS'].split(',')
TABLE = os.environ['TABLE_NAME']
BUCKET = os.environ['DASHBOARD_BUCKET']
PRICE_DAYS = int(os.environ.get('PRICE_DAYS', '90'))

ddb = boto3.client('dynamodb')
s3 = boto3.client('s3')


def parse(ts):
    return datetime.fromisoformat(ts.replace('Z', '+00:00'))


def fmt(t):
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def downsample(series, agg, fine_cutoff):
    fine = [(t, v) for t, v in series if t >= fine_cutoff]
    old = [(t, v) for t, v in series if t < fine_cutoff]
    buckets = defaultdict(list)
    for t, v in old:
        b = t.replace(hour=t.hour - t.hour % 6, minute=0, second=0, microsecond=0)
        buckets[b].append(v)
    coarse = sorted((b, (max if agg == 'max' else min)(vs)) for b, vs in buckets.items())
    return [[fmt(t), v] for t, v in coarse + fine]


def scan_scores():
    """점수 항목을 페이지 단위로 흘려보낸다. 전체를 리스트로 모으면 대상이 늘 때 메모리가 부족해진다."""
    kwargs = {}
    while True:
        out = ddb.scan(TableName=TABLE, ProjectionExpression='#s, #t, #v',
                       ExpressionAttributeNames={'#s': 'scope', '#t': 'ts', '#v': 'score'}, **kwargs)
        yield from out.get('Items', [])
        if 'LastEvaluatedKey' not in out:
            return
        kwargs['ExclusiveStartKey'] = out['LastEvaluatedKey']


def fetch_region(ec2, reg, start):
    """한 리전의 AZ 목록과 (인스턴스 타입, AZ)별 스팟 가격 기록을 가져온다."""
    azs = {z['ZoneId']: (reg, z['ZoneName']) for z in ec2.describe_availability_zones()['AvailabilityZones']}
    by_type_az = defaultdict(list)
    paginator = ec2.get_paginator('describe_spot_price_history')
    for page in paginator.paginate(InstanceTypes=MEMBER_TYPES, ProductDescriptions=['Linux/UNIX'],
                                   StartTime=start):
        for p in page['SpotPriceHistory']:
            by_type_az[(p['InstanceType'], p['AvailabilityZone'])].append(
                (p['Timestamp'].astimezone(timezone.utc), float(p['SpotPrice'])))
    for k in by_type_az:
        by_type_az[k].sort()
    return azs, by_type_az


def handler(event, context):
    now = datetime.now(timezone.utc)
    fine_cutoff = now - timedelta(days=14)

    region_scores = {t: defaultdict(list) for t in TYPES}
    az_scores = {t: defaultdict(list) for t in TYPES}
    for item in scan_scores():
        s, t, sc = item['scope']['S'], parse(item['ts']['S']), int(item['score']['N'])
        if s.startswith('region#'):     # 구스키마(초기 p5 수집분)
            region_scores['p5.48xlarge'][s.split('region#')[1]].append((t, sc))
        elif s.startswith('az#'):
            az_scores['p5.48xlarge'][s.split('az#')[1]].append((t, sc))
        else:
            typ = s.split('#')[0]
            if typ not in TYPES:
                continue
            if '#region#' in s:
                region_scores[typ][s.split('#region#')[1]].append((t, sc))
            elif '#az#' in s:
                az_scores[typ][s.split('#az#')[1]].append((t, sc))

    azmap = {}
    price_series = {t: {} for t in TYPES}
    az_latest_price = {t: {} for t in TYPES}
    start = now - timedelta(days=PRICE_DAYS)
    # 가격 기록 조회는 리전마다 수십 페이지라 리전별로 병렬 실행한다
    # boto3 세션의 클라이언트 생성은 스레드 안전하지 않으므로 클라이언트는 스레드 밖에서 미리 만든다
    # (만들어진 클라이언트의 호출은 스레드 안전)
    clients = {r: boto3.client('ec2', region_name=r) for r in REGIONS}
    with ThreadPoolExecutor(max_workers=len(REGIONS)) as pool:
        fetched = list(pool.map(lambda r: fetch_region(clients[r], r, start), REGIONS))
    for reg, (azs, by_type_az) in zip(REGIONS, fetched):
        azmap.update(azs)
        for tid in TYPES:
            # 대상에 속한 모든 (타입, AZ) 가격 계열 — 대상의 가격은 이들 중 최저가
            keys = [k for k in by_type_az if OWNER.get(k[0]) == tid]
            if not keys:
                continue
            for k in keys:
                cur = by_type_az[k][-1][1]
                az_latest_price[tid][k[1]] = min(cur, az_latest_price[tid].get(k[1], cur))
            t0 = min(by_type_az[k][0][0] for k in keys).replace(minute=0, second=0, microsecond=0)
            grid_n = int((now - t0).total_seconds() // 3600) + 1
            idx = {k: 0 for k in keys}
            last = {k: None for k in keys}
            series = []
            for i in range(grid_n):
                g = t0 + timedelta(hours=i)
                mins = []
                for k in keys:
                    v = by_type_az[k]
                    while idx[k] < len(v) and v[idx[k]][0] <= g:
                        last[k] = v[idx[k]][1]
                        idx[k] += 1
                    if last[k] is not None:
                        mins.append(last[k])
                if mins:
                    # 소형 타입은 시간당 $0.01대라 소수 2자리로는 변동이 사라진다 — 4자리 유지
                    series.append((g, round(min(mins), 4)))
            price_series[tid][reg] = downsample(series, 'min', fine_cutoff)

    # 90일간 스팟 가격 기록이 한 건도 없는 (타입, 리전) = 해당 리전에 스팟 풀 자체가 미개설.
    # (배치점수 API도 이런 리전은 응답에서 제외하므로 "수집 누락"과 구분해 명시한다)
    no_pool = {t: [r for r in REGIONS if r not in price_series[t]] for t in TYPES}

    out = {
        'generated': now.strftime('%Y-%m-%d %H:%M UTC'),
        'types': TYPES, 'regions': REGIONS,
        'typeMeta': {t['id']: {'family': t['family'], 'arch': t['arch'], 'spec': t['spec'],
                               **({'gpu': t['gpu']} if t.get('gpu') else {}),
                               'members': t['types']} for t in TARGETS},
        'noPool': no_pool,
        'azMeta': {azid: {'region': m[0], 'azname': m[1]} for azid, m in azmap.items()},
        'scores': {t: {r: downsample(sorted(set(v)), 'max', fine_cutoff)
                       for r, v in region_scores[t].items()} for t in TYPES},
        'azScores': {t: {a: downsample(sorted(set(v)), 'max', fine_cutoff)
                         for a, v in az_scores[t].items()} for t in TYPES},
        'prices': price_series,
        'azPrice': az_latest_price,
    }
    body = json.dumps(out, separators=(',', ':'))
    s3.put_object(Bucket=BUCKET, Key='data.json', Body=body.encode(),
                  ContentType='application/json', CacheControl='max-age=300')
    print(f'published data.json: {len(body)} bytes')
    return {'bytes': len(body)}

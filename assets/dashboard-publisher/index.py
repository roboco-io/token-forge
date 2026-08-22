"""스팟 대시보드 데이터 퍼블리셔 — 1시간마다 수집기 DDB 점수 + 스팟 가격 히스토리를
집계해 data.json을 대시보드 S3 버킷에 게시한다. (14일 이전 구간은 6h 버킷으로 다운샘플)"""
import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import boto3

TYPES = os.environ['INSTANCE_TYPES'].split(',')
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
    items, kwargs = [], {}
    while True:
        out = ddb.scan(TableName=TABLE, **kwargs)
        items += out.get('Items', [])
        if 'LastEvaluatedKey' not in out:
            return items
        kwargs['ExclusiveStartKey'] = out['LastEvaluatedKey']


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
    for reg in REGIONS:
        ec2 = boto3.client('ec2', region_name=reg)
        for z in ec2.describe_availability_zones()['AvailabilityZones']:
            azmap[z['ZoneId']] = (reg, z['ZoneName'])
        by_type_az = defaultdict(list)
        paginator = ec2.get_paginator('describe_spot_price_history')
        for page in paginator.paginate(InstanceTypes=TYPES, ProductDescriptions=['Linux/UNIX'],
                                       StartTime=start):
            for p in page['SpotPriceHistory']:
                by_type_az[(p['InstanceType'], p['AvailabilityZone'])].append(
                    (p['Timestamp'].astimezone(timezone.utc), float(p['SpotPrice'])))
        for k in by_type_az:
            by_type_az[k].sort()
        for (it, az), v in by_type_az.items():
            az_latest_price[it][az] = v[-1][1]
        for it in TYPES:
            azs = [az for (i, az) in by_type_az if i == it]
            if not azs:
                continue
            t0 = min(by_type_az[(it, az)][0][0] for az in azs).replace(minute=0, second=0, microsecond=0)
            grid_n = int((now - t0).total_seconds() // 3600) + 1
            idx = {az: 0 for az in azs}
            last = {az: None for az in azs}
            series = []
            for i in range(grid_n):
                g = t0 + timedelta(hours=i)
                mins = []
                for az in azs:
                    v = by_type_az[(it, az)]
                    while idx[az] < len(v) and v[idx[az]][0] <= g:
                        last[az] = v[idx[az]][1]
                        idx[az] += 1
                    if last[az] is not None:
                        mins.append(last[az])
                if mins:
                    series.append((g, round(min(mins), 2)))
            price_series[it][reg] = downsample(series, 'min', fine_cutoff)

    # 90일간 스팟 가격 기록이 한 건도 없는 (타입, 리전) = 해당 리전에 스팟 풀 자체가 미개설.
    # (배치점수 API도 이런 리전은 응답에서 제외하므로 "수집 누락"과 구분해 명시한다)
    no_pool = {t: [r for r in REGIONS if r not in price_series[t]] for t in TYPES}

    out = {
        'generated': now.strftime('%Y-%m-%d %H:%M UTC'),
        'types': TYPES, 'regions': REGIONS,
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

import { bootReport, BootEvent, formatBootReport } from '../cli/commands/boot-report';
const id = '12345678-1234-1234-1234-123456789abc';
const base = Date.parse('2026-10-31T00:00:00Z');
function fixture(): BootEvent[] {
  return [
    ['boot', 'start', 0], ['weights', 'start', 10], ['image', 'start', 20],
    ['image', 'complete', 5020], ['weights', 'complete', 6010],
    ['weights', 'cache', 6011], ['image', 'cache', 6012],
    ['container', 'start', 6020], ['container', 'complete', 6100],
    ['health', 'start', 6110], ['health', 'ready', 10000], ['boot', 'ready', 10001],
  ].map(([phase, status, t], seq) => ({ v: 1, boot_id: id, seq, timestamp_ms: base + Number(t), elapsed_ms: Number(t),
    phase: String(phase), status: String(status), ...(status === 'cache' ? { cache: 'hit' as const } : {}) }));
}
const jsonl = (xs: unknown[]) => xs.map(x => JSON.stringify(x)).join('\n');
const options = { hourlyPrice: '36', launchTime: '2026-10-30T23:59:50Z' };

test('겹친 준비 시간은 합산하지 않고 명시 단가+launch anchor로만 비용 산출', () => {
  const b = bootReport(jsonl(fixture()), options).boots[0];
  expect(b.status).toBe('ready');
  expect(b.observedHostToReadyMs).toBe(10001);
  expect(b.phaseDurationsMs.weights).toBe(6000);
  expect(b.phaseDurationsMs.image).toBe(5000);
  expect(b.launchToReadyMs).toBe(20001);
  expect(b.approximateBootCostUsd).toBeCloseTo(.20001);
  expect(bootReport(jsonl(fixture())).boots[0].approximateBootCostUsd).toBeNull();
  expect(bootReport(jsonl(fixture()), { hourlyPrice: '36' }).boots[0].approximateBootCostUsd).toBeNull();
});

test('CW export, 역순, 중복을 병합', () => {
  const xs = fixture();
  const r = bootReport(JSON.stringify({ events: [...xs.reverse(), xs[0]].map(x => ({ message: JSON.stringify(x) })) }), options);
  expect(r.boots[0].status).toBe('ready');
  expect(r.boots[0].duplicates).toBe(1);
  expect(r.boots[0].observedHostToReadyMs).toBe(10001);
});

test('여러 boot ID에 단일 anchor 적용 금지', () => {
  const xs = [...fixture(), ...fixture().map(e => ({ ...e, boot_id: 'abcdefab-1234-1234-1234-123456789abc' }))];
  expect(bootReport(jsonl(xs)).boots).toHaveLength(2);
  expect(() => bootReport(jsonl(xs), options)).toThrow('정확히 하나');
});

test.each(['missing', 'conflict', 'clock', 'monotonic', 'duration', 'ordering', 'unsupported', 'malformed'])('%s는 성공/$0으로 오인하지 않음', mode => {
  const xs: any[] = fixture();
  let tail = '';
  if (mode === 'missing') xs.splice(2, 1);
  if (mode === 'conflict') xs.push({ ...xs[0], elapsed_ms: 100 });
  if (mode === 'clock') xs[11].timestamp_ms += 9000;
  if (mode === 'monotonic') xs[5].elapsed_ms = 0;
  if (mode === 'duration') xs[3].duration_ms = 1;
  if (mode === 'ordering') xs[7].seq = 2;
  if (mode === 'unsupported') xs.push({ ...xs[0], v: 999 });
  if (mode === 'malformed') tail = '\nDO_NOT_LOG_SECRET';
  const report = bootReport(jsonl(xs) + tail, options);
  expect(report.boots[0].status).toBe('incomplete');
  expect(report.boots[0].approximateBootCostUsd).toBeNull();
  expect(JSON.stringify(report)).not.toContain('DO_NOT_LOG_SECRET');
});

test('부분 실패, 빈 입력, 키가 든 추가 필드는 안전하게 처리', () => {
  const xs = fixture().slice(0, 4); xs[3].status = 'failed';
  expect(bootReport(jsonl(xs)).boots[0].status).toBe('failed');
  expect(bootReport('').boots).toHaveLength(0);
  expect(formatBootReport(bootReport(''))).not.toContain('$0');
  expect(JSON.stringify(bootReport(jsonl(fixture().map(e => ({ ...e, key: 'DO_NOT_LOG_SECRET' })))))).not.toContain('DO_NOT_LOG_SECRET');
});

test.each(['-1', 'NaN', 'Infinity', '1e999', '', ' 1'])('잘못된 단가 %j 거부', hourlyPrice => {
  expect(() => bootReport(jsonl(fixture()), { hourlyPrice })).toThrow();
});

test.each(['garbage', '2026-10-31', '2026-10-31T01:00:00', '2026-02-30T01:00:00Z'])('잘못된 anchor %s 거부', launchTime => {
  expect(() => bootReport(jsonl(fixture()), { launchTime })).toThrow();
});

test('호스트 시작 뒤 anchor는 비용 산출 안 함; 업로드 실패는 READY와 별도', () => {
  const xs = fixture();
  xs.push({ ...xs[11], seq: 12, phase: 'upload', status: 'failed' });
  const b = bootReport(jsonl(xs), { ...options, launchTime: '2026-10-31T00:00:01Z' }).boots[0];
  expect(b.approximateBootCostUsd).toBeNull();
  expect(b.uploadFailures).toBe(1);
  expect(b.warnings).toContain('launch-time이 호스트 시작보다 늦음');
  expect(formatBootReport(bootReport(jsonl(fixture()), options))).toContain('청구서 아님');
});

test('작은 벽시계 역행도 비용 계산에서 제외', () => {
  const xs = fixture(); xs[6].timestamp_ms = xs[5].timestamp_ms - 1;
  const b = bootReport(jsonl(xs), options).boots[0];
  expect(b.status).toBe('incomplete'); expect(b.approximateBootCostUsd).toBeNull();
});

test('서로 다른 boot의 시간 이상을 합쳐 성공 처리하지 않음', () => {
  const bad = fixture().map(e => ({ ...e, boot_id: 'abcdefab-1234-1234-1234-123456789abc' }));
  bad[7].timestamp_ms -= 9000;
  const r = bootReport(jsonl([...fixture(), ...bad]));
  expect(r.boots.map(b => b.status)).toEqual(['ready', 'incomplete']);
});

test('READY 뒤 telemetry 순번/시간은 부팅 시간과 비용에서 분리', () => {
  const xs = fixture();
  xs.push({ ...xs[0], stream: 'telemetry', phase: 'upload', status: 'failed', timestamp_ms: base + 999999, elapsed_ms: 123456 });
  const b = bootReport(jsonl(xs), options).boots[0];
  expect(b.status).toBe('ready'); expect(b.observedHostToReadyMs).toBe(10001);
  expect(b.approximateBootCostUsd).toBeCloseTo(.20001); expect(b.uploadFailures).toBe(1);
});

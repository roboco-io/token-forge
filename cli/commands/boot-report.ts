/** 호스트 JSONL / CloudWatch filter-log-events export의 로컬 분석. AWS 호출 없음. */
export interface BootEvent {
  v: 1; boot_id: string; seq: number; timestamp_ms: number; elapsed_ms: number;
  phase: string; status: string; duration_ms?: number; cache?: 'hit' | 'miss'; stream?: 'telemetry'; exit_code?: number;
}
export interface ReportOptions { hourlyPrice?: string; launchTime?: string }
const phases = ['boot', 'weights', 'image', 'container', 'health', 'upload'];
const statuses = ['start', 'complete', 'failed', 'cancelled', 'timeout', 'ready', 'cache'];
export const BOOT_SCOPE = '호스트 시작→로컬 health READY는 부분 관측 구간이다. EC2 LaunchTime→READY 비용은 명시한 고정 단가의 근사치이며 청구서가 아니다. 준비·시딩·스팟 대기·엔드포인트 관측 지연과 serving·idle tail·종료 전파·전체 세션 비용은 측정하지 않는다.';
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function parseEvent(raw: unknown): BootEvent | undefined {
  if (!raw || typeof raw !== 'object') return;
  const e = raw as Record<string, unknown>;
  if (e.v !== 1 || typeof e.boot_id !== 'string' || !/^[a-f0-9-]{36}$/.test(e.boot_id) ||
      !Number.isSafeInteger(e.seq) || (e.seq as number) < 0 || !number(e.timestamp_ms) ||
      !Number.isFinite(new Date(e.timestamp_ms).getTime()) || !number(e.elapsed_ms) ||
      !phases.includes(String(e.phase)) || !statuses.includes(String(e.status)) ||
      (e.stream !== undefined && (e.stream !== 'telemetry' || e.phase !== 'upload')) ||
      (e.exit_code !== undefined && !Number.isSafeInteger(e.exit_code)) ||
      (e.duration_ms !== undefined && !number(e.duration_ms)) ||
      (e.cache !== undefined && e.cache !== 'hit' && e.cache !== 'miss')) return;
  // 알려진 안전 필드만 복사. 입력의 메시지·인자·키는 결과나 오류에 반영하지 않는다.
  return { v: 1, boot_id: e.boot_id, seq: e.seq as number, timestamp_ms: e.timestamp_ms,
    elapsed_ms: e.elapsed_ms, phase: e.phase as string, status: e.status as string,
    ...(e.stream === undefined ? {} : { stream: 'telemetry' as const }),
    ...(e.exit_code === undefined ? {} : { exit_code: e.exit_code as number }),
    ...(e.duration_ms === undefined ? {} : { duration_ms: e.duration_ms as number }),
    ...(e.cache === undefined ? {} : { cache: e.cache as 'hit' | 'miss' }) };
}

export function bootReport(input: string, options: ReportOptions = {}) {
  let rate: number | undefined, anchor: number | undefined;
  if (options.hourlyPrice !== undefined) {
    if (!/^(?:\d+\.?\d*|\.\d+)$/.test(options.hourlyPrice) || !number(Number(options.hourlyPrice)))
      throw new Error('시간당 단가는 유한한 0 이상의 USD 숫자여야 합니다.');
    rate = Number(options.hourlyPrice);
  }
  if (options.launchTime !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(options.launchTime) ||
        !Number.isFinite(Date.parse(options.launchTime))) throw new Error('launch-time은 시간대가 있는 유효한 ISO 시각이어야 합니다.');
    const calendar = options.launchTime.slice(0, 19);
    if (new Date(`${calendar}Z`).toISOString().slice(0, 19) !== calendar)
      throw new Error('launch-time의 달력 날짜/시간이 유효하지 않습니다.');
    anchor = Date.parse(options.launchTime);
  }
  const warnings: string[] = [];
  const raw: unknown[] = [];
  let invalid = 0;
  try {
    const doc = JSON.parse(input);
    if (doc && Array.isArray(doc.events)) {
      for (const x of doc.events) {
        try { raw.push(JSON.parse(x.message)); } catch { invalid++; }
      }
    } else raw.push(doc);
  } catch {
    for (const line of input.split('\n').filter(x => x.trim())) {
      try { raw.push(JSON.parse(line)); } catch { invalid++; }
    }
  }
  const groups = new Map<string, BootEvent[]>();
  for (const value of raw) {
    const event = parseEvent(value);
    if (!event) { invalid++; continue; }
    const events = groups.get(event.boot_id) ?? [];
    events.push(event); groups.set(event.boot_id, events);
  }
  if (invalid) warnings.push(`잘못된 형식/미지원 이벤트 ${invalid}개 제외; 완전성 확인 불가`);
  if (!groups.size) warnings.push('분석할 부팅 이벤트가 없습니다.');
  if (anchor !== undefined && groups.size !== 1) throw new Error('launch-time은 boot ID가 정확히 하나인 파일에만 적용할 수 있습니다.');
  const boots = [...groups].map(([bootId, all]) => {
    const issues: string[] = [];
    const bySeq = new Map<number, BootEvent>();
    let duplicates = 0;
    const telemetry = all.filter(e => e.stream === 'telemetry');
    for (const e of all.filter(e => e.stream !== 'telemetry')) {
      const prev = bySeq.get(e.seq);
      if (prev) {
        duplicates++;
        if (JSON.stringify(prev) !== JSON.stringify(e)) issues.push('동일 seq의 충돌 이벤트');
      } else bySeq.set(e.seq, e);
    }
    const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    events.forEach((e, i) => {
      if (e.seq !== i) issues.push('이벤트 순번 누락');
      if (i && e.elapsed_ms < events[i - 1].elapsed_ms) issues.push('단조 시간 역행');
      if (i && e.timestamp_ms < events[i - 1].timestamp_ms) issues.push('벽시계 역행');
      const first = events[0];
      if (Math.abs((e.timestamp_ms - first.timestamp_ms) - (e.elapsed_ms - first.elapsed_ms)) > 2)
        issues.push('벽시계 변동');
    });
    const one = (phase: string, status: string) => {
      const xs = events.filter(e => e.phase === phase && e.status === status);
      if (xs.length > 1) issues.push('중복 단계 상태');
      return xs.length === 1 ? xs[0] : undefined;
    };
    const start = one('boot', 'start'), ready = one('boot', 'ready'), health = one('health', 'ready');
    const durations: Record<string, number | null> = {};
    for (const phase of ['weights', 'image', 'container', 'health']) {
      const s = one(phase, 'start'), e = one(phase, phase === 'health' ? 'ready' : 'complete');
      durations[phase] = s && e && e.elapsed_ms >= s.elapsed_ms ? e.elapsed_ms - s.elapsed_ms : null;
      if (s && e && (e.seq <= s.seq || (e.duration_ms !== undefined && Math.abs(e.duration_ms - (e.elapsed_ms - s.elapsed_ms)) > 1)))
        issues.push('단계 시간 불일치');
    }
    const failed = events.some(e => e.phase !== 'upload' && ['failed', 'cancelled', 'timeout'].includes(e.status));
    if (!start || !ready || !health || Object.values(durations).some(x => x === null)) issues.push('단계/READY 기록 미완성');
    if (start && start.seq !== 0) issues.push('부팅 시작 순서 오류');
    if (ready && health && (ready.elapsed_ms < health.elapsed_ms || ready.seq < health.seq)) issues.push('READY 순서 오류');
    const containerStart = events.find(e => e.phase === 'container' && e.status === 'start');
    const healthStart = events.find(e => e.phase === 'health' && e.status === 'start');
    for (const phase of ['weights', 'image', 'container']) {
      const end = events.find(e => e.phase === phase && e.status === 'complete');
      const next = phase === 'container' ? healthStart : containerStart;
      if (end && next && end.seq >= next.seq) issues.push('준비/컨테이너 순서 오류');
    }
    const complete = !failed && !invalid && !issues.length && !!start && !!ready;
    let launchToReadyMs: number | null = null, approximateBootCostUsd: number | null = null;
    if (complete && anchor !== undefined && start && ready) {
      if (anchor > start.timestamp_ms) issues.push('launch-time이 호스트 시작보다 늦음');
      else {
        launchToReadyMs = ready.timestamp_ms - anchor;
        if (rate !== undefined) {
          const cost = launchToReadyMs / 3600000 * rate;
          if (Number.isFinite(cost)) approximateBootCostUsd = cost;
          else issues.push('비용 계산 범위 초과');
        }
      }
    }
    return { bootId, status: failed ? 'failed' : complete ? 'ready' : 'incomplete',
      observedHostToReadyMs: complete && start && ready ? ready.elapsed_ms - start.elapsed_ms : null,
      phaseDurationsMs: durations, // 병렬 단계 시간을 합산하지 않는다.
      cache: Object.fromEntries(events.filter(e => e.cache).map(e => [e.phase, e.cache])),
      uploadFailures: [...events, ...telemetry].filter(e => e.phase === 'upload' && ['failed', 'timeout'].includes(e.status)).length,
      duplicates, warnings: [...new Set(issues)], launchToReadyMs, approximateBootCostUsd };
  });
  return { schemaVersion: 1, scope: BOOT_SCOPE, assumptions: { hourlyPriceUsd: rate ?? null,
    launchTime: options.launchTime ?? null, pricing: '명시적 고정 시간당 단가; 실제 스팟 단가 변동/청구 단위 미반영' }, warnings, boots };
}

export function formatBootReport(report: ReturnType<typeof bootReport>): string {
  const lines = [report.scope, ...report.warnings];
  for (const b of report.boots) {
    lines.push(`${b.bootId}: ${b.status}; 호스트→READY ${b.observedHostToReadyMs === null ? '측정 불완전' : `${(b.observedHostToReadyMs / 1000).toFixed(3)}초`}`);
    if (b.uploadFailures) lines.push('계측 전송 유실 가능: 호스트 원본을 확인하세요.');
    lines.push(`단계(ms, 합산 금지): ${JSON.stringify(b.phaseDurationsMs)}; 캐시: ${JSON.stringify(b.cache)}; 전송 실패: ${b.uploadFailures}; 중복: ${b.duplicates}`);
    lines.push(b.approximateBootCostUsd === null ? '근사 비용: 산출 안 함 (완전한 기록·단가·유효 launch anchor 필요)' :
      `근사 부팅 비용: $${b.approximateBootCostUsd.toFixed(6)} USD (단가 $${report.assumptions.hourlyPriceUsd}/h, EC2 launch→READY ${b.launchToReadyMs! / 1000}초; 청구서 아님)`);
    lines.push(...b.warnings);
  }
  return lines.join('\n');
}

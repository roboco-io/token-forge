import { AwsApi } from '../aws';
import { stackNameFor } from '../../lib/naming';
import { TfState } from '../state';
import { TfConfig } from '../config';
import { Candidate, rank } from '../placement/engine';
import { RaceEntrant } from './race';
import { UsagePolicy, resolveUsagePolicy, policyContextArgs, policyMatchesOutputs, describePolicy, DEFAULT_IDLE_MINUTES } from '../../lib/usage-mode';
import { DeploymentSettings, parseSettings, settingsContextArgs } from '../../lib/deployment-settings';

/** policy 미지정 = seed 경로(기존 스택 정책을 건드리지 않음). 신규 생성 시에는 기본(interactive) 정책 */
export interface UpOpts { model: string; profile: string; region: string; policy?: UsagePolicy }
export interface UpDeps {
  api: Pick<AwsApi, 'getStackOutputs' | 'getAsgName' | 'getAsgStatus' | 'setDesired' | 'setCapacity' | 'getSecret' | 'headObject'>;
  exec: (cmd: string, args: string[]) => Promise<number>;
  probeAuth: (url: string, key: string) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  saveState: (s: TfState) => void;
  log: (msg: string) => void;
  timeoutMs: number; // 기본 30분 (스펙 R8)
  /** 같은 호스트 tkf run 잠금 보유 pid — up/seed가 준비 중(desired=0)인 batch를 인수하지 않게 확인 (run 자신은 미주입) */
  batchLockHolder?: (key: string) => string | null;
}

export async function ensureStackReady(
  opts: UpOpts,
  d: Pick<UpDeps, 'api' | 'exec' | 'log' | 'saveState' | 'batchLockHolder'>,
): Promise<{ outputs: Record<string, string>; stackName: string }> {
  const stackName = stackNameFor(opts.model, opts.profile);
  const holder = d.batchLockHolder?.(`${stackName}@${opts.region}`) ?? null;
  if (holder) {
    throw new Error(`${stackName} @ ${opts.region}은(는) 이 호스트의 tkf run(pid ${holder})이 사용 중입니다 — 작업이 끝난 뒤 다시 시도하세요`);
  }

  // CLI 경로는 항상 minCapacity=0으로 배포한다 (스택 생성·갱신을 스팟 확보와 분리, online의 min=1은 READY 후 적용)
  const baseArgs = (policy: UsagePolicy) => ['-c', `model=${opts.model}`, '-c', `profile=${opts.profile}`,
    '-c', `region=${opts.region}`, '-c', 'minCapacity=0', ...policyContextArgs(policy)];
  const deploy = async (policy: UsagePolicy, settings?: DeploymentSettings) => {
    const code = await d.exec('npx', ['cdk', 'deploy', ...baseArgs(policy),
      ...(settings ? settingsContextArgs(settings) : []), '--require-approval', 'never']);
    if (code !== 0) throw new Error('cdk deploy 실패 — 위 출력을 확인하세요');
    const out = await d.api.getStackOutputs(stackName);
    if (!out) throw new Error('배포 후에도 스택 출력을 읽을 수 없습니다');
    return out;
  };

  // ① 스택 보장 (GPU 0대로 생성 — 스펙 R7 선시딩 워크플로)
  let outputs = await d.api.getStackOutputs(stackName);
  if (!outputs) {
    d.log(`스택 생성 중: ${stackName} @ ${opts.region} (GPU 0대, 약 5분)`);
    outputs = await deploy(opts.policy ?? resolveUsagePolicy());
  } else if (opts.policy) {
    const policy = opts.policy;
    // 소유권: batch 작업이 쓰는 GPU를 다른 모드가 인수하거나, batch가 남의 GPU를 인수하지 않는다
    if (policy.mode === 'batch' || outputs.UsageMode === 'batch') {
      const st = await d.api.getAsgStatus(await d.api.getAsgName(stackName));
      // Pending·Terminating 인스턴스도 남아 있으면 활성으로 본다 (desired=0이라도 직전 실행의 잔존일 수 있음)
      if (st.desired > 0 || st.instanceIds.length > 0) {
        throw new Error(policy.mode === 'batch'
          ? `${stackName} @ ${opts.region}에서 GPU가 이미 사용 중입니다(desired=${st.desired}) — 다른 세션/온라인 인스턴스를 인수하거나 종료하지 않습니다. ` +
            `tkf status로 확인하고, 본인이 남긴 고아 GPU라면 tkf down --region ${opts.region} 후 다시 실행하세요`
          : `${stackName} @ ${opts.region}에서 배치 작업(tkf run)이 GPU를 사용 중입니다 — 작업이 끝난 뒤 다시 시도하세요 ` +
            `(중단된 작업의 잔존 GPU라면 tkf down --region ${opts.region})`);
      }
    }
    const legacyDefault = !outputs.UsageMode && policy.mode === 'interactive' && policy.idleMinutes === DEFAULT_IDLE_MINUTES;
    if (legacyDefault) {
      // 구버전 스택(모드 기록 없음) + 기본 요청: 이전 CLI처럼 그대로 사용한다. 정책·설정을 모르는 채 자동 배포하면
      // 최초 배포 때 쓴 allowedCidrs 등을 잃을 수 있다.
      d.log('이 스택에는 사용 모드 기록이 없습니다(구버전) — 기존 설정 그대로 사용합니다. 모드를 바꾸려면 README의 마이그레이션 절 참고');
    } else if (!policyMatchesOutputs(policy, outputs)) {
      const cur = outputs.UsageMode ? `${outputs.UsageMode}/${outputs.IdleMinutes}분` : '기록 없음(구버전 스택)';
      let settings: DeploymentSettings;
      try {
        settings = parseSettings(outputs.DeploymentSettings);
      } catch (e) {
        throw new Error(`${(e as Error).message} — 기존 스택의 allowedCidrs/azs/alertEmail을 알 수 없어 자동 갱신하지 않습니다. ` +
          `최초 배포 때 쓴 컨텍스트를 그대로 붙여 수동 갱신하세요: npx cdk deploy ${baseArgs(policy).join(' ')} ` +
          '[-c allowedCidrs=... -c azs=... -c alertEmail=... (사용했다면)]');
      }
      d.log(`사용 모드 반영: ${cur} → ${describePolicy(policy)} — 기존 스택 cdk deploy 갱신 (기존 allowedCidrs/azs/alertEmail 유지)`);
      outputs = await deploy(policy, settings);
      if (outputs.DeploymentSettings !== JSON.stringify(settings)) {
        throw new Error(`배포 후 DeploymentSettings가 바뀌었습니다(${outputs.DeploymentSettings ?? '없음'}) — 보안·운영 설정을 확인하세요`);
      }
    }
  }
  const skipVerify = opts.policy && !outputs.UsageMode && opts.policy.mode === 'interactive' && opts.policy.idleMinutes === DEFAULT_IDLE_MINUTES;
  if (opts.policy && !skipVerify && !policyMatchesOutputs(opts.policy, outputs)) {
    throw new Error(`배포 후 스택 정책(${outputs.UsageMode ?? '-'}/${outputs.IdleMinutes ?? '-'})이 요청(${opts.policy.mode}/${opts.policy.idleMinutes})과 다릅니다 — cdk 출력을 확인하세요`);
  }
  // 스택 보장 직후 상태 저장 — 이후 단계에서 실패해도 tkf down이 대상을 찾을 수 있도록 (비용 가드)
  d.saveState({ model: opts.model, profile: opts.profile, region: opts.region });

  // ② 가중치 시딩 보장 (스펙 R8: 첫 기동은 선시딩 포함 약 20분)
  const modelKey = outputs.WeightsRepo.replace(/\//g, '_');
  if (!(await d.api.headObject(outputs.WeightsBucketName, `${modelKey}/.complete`))) {
    d.log('가중치 캐시 없음 — CPU 스팟으로 선시딩 시작 (GPU 비용 없음)');
    const code = await d.exec('scripts/seed-weights.sh', [stackName, opts.region]);
    if (code !== 0) throw new Error('선시딩 실패 — 시더 로그를 확인하세요');
  }

  return { outputs, stackName };
}

export async function waitReady(
  args: { stackName: string; outputs: Record<string, string>; policy?: UsagePolicy },
  d: Pick<UpDeps, 'api' | 'probeAuth' | 'sleep' | 'log' | 'timeoutMs'>,
): Promise<{ endpoint: string }> {
  const { stackName, outputs } = args;
  const timeoutMin = Math.round(d.timeoutMs / 60000);

  // ③ 기동 + ④ READY 대기 (상시 프로브가 유휴 알람 발화를 막고, 강등 시 자동 복구)
  const asgName = await d.api.getAsgName(stackName);
  await d.api.setDesired(asgName, 1);
  d.log('스팟 확보 대기 중 — 캐시 부팅 기준 약 8분');
  const key = await d.api.getSecret(outputs.ApiKeySecretArn);
  const deadline = Date.now() + d.timeoutMs;
  let acquired = false;
  let consecutive403 = 0;
  while (Date.now() < deadline) {
    const code = await d.probeAuth(`${outputs.EndpointUrl}/v1/models`, key);
    if (code === 200) {
      // online: 준비 단계는 min=0(스팟 미확보 시에도 정리 가능), READY 이후에만 min=1로 고정
      if (args.policy?.readyMinCapacity === 1) {
        try {
          await d.api.setCapacity(asgName, 1, 1);
        } catch (e) {
          throw new Error(`READY지만 online 최소 용량(min=1) 적용 실패: ${(e as Error).message} — GPU는 desired=1로 실행 중입니다. ` +
            '다시 tkf up --usage-mode online을 실행하거나 tkf down으로 정지하세요');
        }
        d.log('online 모드 — 최소 용량 1 고정 (유휴 종료 없음, 끄려면 tkf down)');
      }
      d.log(`READY — ${outputs.EndpointUrl}`);
      d.log('다음: tkf connect claude');
      return { endpoint: outputs.EndpointUrl };
    }
    // 403은 CloudFront 엣지 차단(allowedCidrs 허용목록 밖)이며 절대 READY로 전환되지 않으므로
    // 연속 3회 관측되면 스팟 용량 부족으로 오진단하지 않고 즉시 실패한다 (401은 무시 — READY 신호).
    if (code === 403) {
      consecutive403 += 1;
      if (consecutive403 >= 3) {
        let restoreMsg = '용량은 0으로 되돌렸습니다';
        try {
          await d.api.setDesired(asgName, 0);
        } catch (e) {
          restoreMsg = `용량을 0으로 되돌리는 데 실패해 desired=1이 남아있을 수 있습니다: ${(e as Error).message}`;
        }
        throw new Error(`엔드포인트가 403을 반환합니다 — allowedCidrs 허용목록에 현재 IP가 포함되는지 확인하세요 (${restoreMsg})`);
      }
    } else {
      consecutive403 = 0;
    }
    const st = await d.api.getAsgStatus(asgName);
    if (st.desired === 0) {           // 유휴 가드 강등 감지 → 복구 (스펙 교훈 반영)
      d.log('유휴 가드 강등 감지 — desired=1 복구');
      await d.api.setDesired(asgName, 1);
    }
    if (!acquired && st.instanceIds.length > 0) { acquired = true; d.log('스팟 확보 — 부팅 중'); }
    await d.sleep(15000);
  }
  // 타임아웃 시 GPU 과금이 방치되지 않도록 desired를 0으로 되돌린다 (비용 가드 최우선 원칙)
  let restoreMsg = '용량을 0으로 되돌렸습니다.';
  try {
    await d.api.setDesired(asgName, 0);
  } catch (e) {
    restoreMsg = `용량을 0으로 되돌리는 데 실패해 desired=1이 남아있을 수 있습니다: ${(e as Error).message}`;
  }
  throw new Error(`타임아웃(${timeoutMin}분) — 스팟 용량 부족 가능성. ${restoreMsg} 다른 리전으로 tkf up --region <r>을 시도하세요`);
}

export async function runUp(opts: UpOpts, d: UpDeps): Promise<{ endpoint: string }> {
  if (opts.policy?.mode === 'batch') throw new Error('batch 모드는 tkf up이 아니라 tkf run <model> --region <r> -- <command>로 실행합니다');
  const { outputs, stackName } = await ensureStackReady(opts, d);

  const { endpoint } = await waitReady({ stackName, outputs, policy: opts.policy }, d);
  d.saveState({ model: opts.model, profile: opts.profile, region: opts.region });
  return { endpoint };
}

export interface UpAutoDeps {
  config: TfConfig;
  gather: () => Promise<{ cands: Candidate[]; notices: string[] }>;
  /** ensureStackReady를 리전만 바꿔 호출하는 클로저 (program.ts에서 조립) */
  ensure: (o: { model: string; profile: string; region: string; policy?: UsagePolicy }) => Promise<{ outputs: Record<string, string>; stackName: string }>;
  asgNameFor: (region: string, stackName: string) => Promise<string>;
  race: (entrants: RaceEntrant[]) => Promise<RaceEntrant>;
  wait: (a: { stackName: string; outputs: Record<string, string>; region: string; policy?: UsagePolicy }) => Promise<{ endpoint: string }>;
  saveState: (s: TfState) => void;
  loadState?: () => TfState | null;
  log: (m: string) => void;
  now: () => Date;
}

export async function runUpAuto(opts: { model: string; profile: string; policy?: UsagePolicy }, d: UpAutoDeps): Promise<{ endpoint: string; region: string }> {
  if (opts.policy?.mode === 'batch') throw new Error('batch 모드는 tkf up이 아니라 tkf run <model> --region <r> -- <command>로 실행합니다');
  const { cands, notices } = await d.gather();
  notices.forEach(d.log);
  const ranked = rank(cands, { score: d.config.scoreTieThreshold, rttMs: d.config.rttTieThresholdMs });
  const k = d.config.standby === 'single' ? 1 : Math.min(d.config.k, ranked.length);
  const top = ranked.slice(0, k);
  d.log(`후보 선정: ${top.map((c, i) => `${i + 1}. ${c.region}(점수 ${c.score.toFixed(1)})`).join('  ')}`);

  // 스택·시딩은 순차 보장 — cdk.out 충돌 방지 (설계 결정 6)
  const prepared: { cand: Candidate; outputs: Record<string, string>; stackName: string; asgName: string }[] = [];
  for (const cand of top) {
    // 레이스 후보·lazy 대기 스택 모두 같은 정책으로 보장 — 승자 결정 후 모드 누락이 없게 한다
    const { outputs, stackName } = await d.ensure({ model: opts.model, profile: opts.profile, region: cand.region, policy: opts.policy });
    prepared.push({ cand, outputs, stackName, asgName: await d.asgNameFor(cand.region, stackName) });
  }

  // 레이스(최대 30분) 중 중단되어도 tkf down이 전 후보 리전을 찾을 수 있도록,
  // standbyRegions를 포함한 상태를 레이스 호출 전에 잠정 저장한다 (region은 잠정 top 1위).
  const prev = d.loadState?.() ?? null;
  const standbyRegions = top.map((c) => c.region);
  let lastUsed = { ...(prev?.lastUsed ?? {}), [prepared[0].cand.region]: d.now().toISOString() };
  d.saveState({ model: opts.model, profile: opts.profile, region: prepared[0].cand.region, standbyRegions, lastUsed });

  let winner = prepared[0];
  if (prepared.length > 1) {
    const w = await d.race(prepared.map((p) => ({ region: p.cand.region, asgName: p.asgName, endpointUrl: p.outputs.EndpointUrl })));
    winner = prepared.find((p) => p.cand.region === w.region)!;
  }

  lastUsed = { ...lastUsed, [winner.cand.region]: d.now().toISOString() };
  const state: TfState = { model: opts.model, profile: opts.profile, region: winner.cand.region,
    standbyRegions, lastUsed };
  d.saveState(state);

  const { endpoint } = await d.wait({ stackName: winner.stackName, outputs: winner.outputs, region: winner.cand.region, policy: opts.policy });

  // lazy: 패자 스택 정리 제안 (자동 삭제 금지 — 설계 결정 4)
  if (d.config.standby === 'lazy') {
    for (const p of prepared.filter((x) => x !== winner)) {
      d.log(`lazy 모드 — 대기 스택 정리: tkf down --purge --region ${p.cand.region}`);
    }
  }
  // 캐시 보유 리전 상한(설계 결정 5) 초과 시 LRU 정리 제안
  const cap = d.config.standby === 'race' ? d.config.k : d.config.standby === 'single' ? 1 : 2;
  const regions = Object.entries(lastUsed).sort(([, a], [, b]) => a.localeCompare(b)); // 오래된 순
  const over = regions.length - cap;
  for (let i = 0; i < over; i++) {
    if (top.some((c) => c.region === regions[i][0])) continue; // 이번 후보는 제안 제외
    d.log(`가중치 캐시 보유 리전이 상한(${cap})을 초과 — 정리 제안: tkf down --purge --region ${regions[i][0]}`);
  }
  return { endpoint, region: winner.cand.region };
}

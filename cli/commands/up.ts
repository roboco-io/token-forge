import { AwsApi } from '../aws';
import { stackNameFor } from '../../lib/naming';
import { TfState } from '../state';

export interface UpOpts { model: string; profile: string; region: string }
export interface UpDeps {
  api: Pick<AwsApi, 'getStackOutputs' | 'getAsgName' | 'getAsgStatus' | 'setDesired' | 'getSecret' | 'headObject'>;
  exec: (cmd: string, args: string[]) => Promise<number>;
  probeAuth: (url: string, key: string) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  saveState: (s: TfState) => void;
  log: (msg: string) => void;
  timeoutMs: number; // 기본 30분 (스펙 R8)
}

export async function ensureStackReady(
  opts: UpOpts,
  d: Pick<UpDeps, 'api' | 'exec' | 'log'>,
): Promise<{ outputs: Record<string, string>; stackName: string }> {
  const stackName = stackNameFor(opts.model, opts.profile);

  // ① 스택 보장 (GPU 0대로 생성 — 스펙 R7 선시딩 워크플로)
  let outputs = await d.api.getStackOutputs(stackName);
  if (!outputs) {
    d.log(`스택 생성 중: ${stackName} @ ${opts.region} (GPU 0대, 약 5분)`);
    const code = await d.exec('npx', ['cdk', 'deploy',
      '-c', `model=${opts.model}`, '-c', `profile=${opts.profile}`,
      '-c', `region=${opts.region}`, '-c', 'minCapacity=0',
      '--require-approval', 'never']);
    if (code !== 0) throw new Error('cdk deploy 실패 — 위 출력을 확인하세요');
    outputs = await d.api.getStackOutputs(stackName);
    if (!outputs) throw new Error('배포 후에도 스택 출력을 읽을 수 없습니다');
  }

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
  args: { stackName: string; outputs: Record<string, string> },
  d: Pick<UpDeps, 'api' | 'probeAuth' | 'sleep' | 'log' | 'timeoutMs'>,
): Promise<{ endpoint: string }> {
  const { stackName, outputs } = args;

  // ③ 기동 + ④ READY 대기 (상시 프로브가 유휴 알람 발화를 막고, 강등 시 자동 복구)
  const asgName = await d.api.getAsgName(stackName);
  await d.api.setDesired(asgName, 1);
  d.log('스팟 확보 대기 중 — 캐시 부팅 기준 약 8분');
  const key = await d.api.getSecret(outputs.ApiKeySecretArn);
  const deadline = Date.now() + d.timeoutMs;
  let acquired = false;
  while (Date.now() < deadline) {
    const code = await d.probeAuth(`${outputs.EndpointUrl}/v1/models`, key);
    if (code === 200) {
      d.log(`READY — ${outputs.EndpointUrl}`);
      d.log('다음: tf connect claude');
      return { endpoint: outputs.EndpointUrl };
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
  throw new Error(`타임아웃(30분) — 스팟 용량 부족 가능성. ${restoreMsg} 다른 리전으로 tf up --region <r>을 시도하세요`);
}

export async function runUp(opts: UpOpts, d: UpDeps): Promise<{ endpoint: string }> {
  const { outputs, stackName } = await ensureStackReady(opts, d);
  // 스택 보장 직후 상태 저장 — 이후 단계에서 실패해도 tf down이 대상을 찾을 수 있도록 (비용 가드)
  d.saveState({ model: opts.model, profile: opts.profile, region: opts.region });

  const { endpoint } = await waitReady({ stackName, outputs }, d);
  d.saveState({ model: opts.model, profile: opts.profile, region: opts.region });
  return { endpoint };
}

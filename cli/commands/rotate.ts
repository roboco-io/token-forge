// R11: API 키 회전 (시크릿 갱신 + 적용 시점 안내, 설계 결정 5)
import { AwsApi } from '../aws';
import { stackNameFor } from '../../lib/naming';
import { TfState } from '../state';

export interface RotateDeps {
  api: Pick<AwsApi, 'getStackOutputs' | 'getAsgName' | 'getAsgStatus' | 'putSecret'>;
  genKey: () => string;
  log: (m: string) => void;
}

export async function runRotateKey(state: TfState, d: RotateDeps): Promise<void> {
  const stackName = stackNameFor(state.model, state.profile);
  const outputs = await d.api.getStackOutputs(stackName);
  if (!outputs) throw new Error(`스택 ${stackName}이 ${state.region}에 없습니다 — 먼저 tkf up을 실행하세요`);

  await d.api.putSecret(outputs.ApiKeySecretArn, d.genKey());
  d.log('API 키 회전 완료 — Secrets Manager에 새 값이 저장됐습니다.');

  const asgName = await d.api.getAsgName(stackName);
  const st = await d.api.getAsgStatus(asgName);
  if (st.desired > 0 || st.instanceIds.length > 0) {
    // vLLM은 부팅 시 키를 읽으므로 실행 중인 서버에는 기존 키가 유지된다
    d.log('주의: 서버가 가동 중입니다 — 새 키는 재기동 시 적용됩니다 (tkf down && tkf up).');
    d.log('그때까지 기존 키가 계속 유효하며, 재기동 후 tkf connect claude를 다시 실행하세요.');
  } else {
    d.log('서버 정지 상태 — 다음 기동부터 적용됩니다. 기동 후 tkf connect claude를 다시 실행하세요.');
  }
}

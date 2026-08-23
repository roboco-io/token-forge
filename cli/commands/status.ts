import { AwsApi } from '../aws';
import { TfState } from '../state';
import { stackNameFor } from '../../lib/naming';

interface Deps { api: AwsApi; state: TfState; probe: (url: string) => Promise<number> }

export async function runStatus({ api, state, probe }: Deps): Promise<string[]> {
  const stackName = stackNameFor(state.model, state.profile);
  const lines = [`대상: ${state.model}/${state.profile} @ ${state.region} (${stackName})`];
  const outputs = await api.getStackOutputs(stackName);
  if (!outputs) return [...lines, '스택 없음 — tf up으로 생성하세요'];

  const asgName = await api.getAsgName(stackName);
  const { desired, instanceIds } = await api.getAsgStatus(asgName);
  if (instanceIds.length === 0) {
    return [...lines, desired === 0 ? '정지됨 (desired=0) — tf up으로 기동' : '스팟 확보 대기 중 (desired=1, 인스턴스 0대)'];
  }
  const type = await api.getInstanceType(instanceIds[0]);
  const code = await probe(`${outputs.EndpointUrl}/v1/models`);
  lines.push(`인스턴스: ${instanceIds[0]} (${type})`);
  lines.push(code === 200 ? `READY — ${outputs.EndpointUrl}` : `부팅 중 (엔드포인트 ${code || '연결 불가'})`);
  return lines;
}

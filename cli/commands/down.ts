import { AwsApi } from '../aws';
import { TfState } from '../state';
import { stackNameFor } from '../../lib/naming';

interface Deps {
  api: Pick<AwsApi, 'getStackOutputs' | 'getAsgName' | 'setDesired' | 'emptyAndDeleteBucket'>;
  exec: (cmd: string, args: string[]) => Promise<number>;
}

export async function runDown(state: TfState, purge: boolean, d: Deps): Promise<string> {
  const stackName = stackNameFor(state.model, state.profile);
  const outputs = await d.api.getStackOutputs(stackName);
  if (!outputs) return '스택 없음 — 이미 삭제됨';

  if (!purge) {
    const asgName = await d.api.getAsgName(stackName);
    await d.api.setDesired(asgName, 0);
    return `정지 완료 (GPU 비용 0) — 스택·가중치 캐시는 유지, 재기동은 tf up`;
  }
  const bucket = outputs.WeightsBucketName;
  const code = await d.exec('npx', ['cdk', 'destroy', '--force',
    '-c', `model=${state.model}`, '-c', `profile=${state.profile}`, '-c', `region=${state.region}`]);
  if (code !== 0) throw new Error('cdk destroy 실패');
  await d.api.emptyAndDeleteBucket(bucket); // 가중치 버킷은 Retain — 별도 정리
  return `완전 삭제 완료 — 스택과 가중치 캐시(${bucket})까지 제거됨`;
}

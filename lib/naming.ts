/** CloudFormation 스택 이름 제약(/^[A-Za-z][A-Za-z0-9-]*$/)에 맞게 정규화 */
export function stackNameFor(model: string, profile: string): string {
  return `TokenForge-${model}-${profile}`.replace(/[^A-Za-z0-9-]/g, '-');
}

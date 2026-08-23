import { stackNameFor } from '../lib/naming';

test('모델·프로파일에서 CFN 제약에 맞는 스택 이름 생성', () => {
  expect(stackNameFor('solar-open2-250b', 'int4')).toBe('TokenForge-solar-open2-250b-int4');
  expect(stackNameFor('glm-4.6', 'fp8')).toBe('TokenForge-glm-4-6-fp8'); // 점 → 대시
});

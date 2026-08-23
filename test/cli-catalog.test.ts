import * as path from 'path';
import { listModels, defaultProfile } from '../cli/catalog';

const MODELS = path.join(__dirname, '..', 'models');

test('models/ 디렉토리의 카탈로그를 나열한다', () => {
  const models = listModels(MODELS);
  const names = models.map((m) => m.model);
  expect(names).toEqual(expect.arrayContaining(['solar-open2-250b', 'glm-4-6', 'qwen3-coder-30b']));
  expect(models.find((m) => m.model === 'qwen3-coder-30b')!.profiles).toEqual(['fp8']);
});

test('기본 프로파일은 yaml의 첫 프로파일', () => {
  expect(defaultProfile(MODELS, 'solar-open2-250b')).toBe('int4');
});

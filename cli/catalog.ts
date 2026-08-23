import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

interface CatalogEntry { model: string; profiles: string[] }

export function listModels(modelsDir: string): CatalogEntry[] {
  return fs.readdirSync(modelsDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => {
      const doc = yaml.load(fs.readFileSync(path.join(modelsDir, f), 'utf8')) as
        { model: string; profiles: Record<string, unknown> };
      return { model: doc.model, profiles: Object.keys(doc.profiles ?? {}) };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

export function defaultProfile(modelsDir: string, model: string): string {
  const entry = listModels(modelsDir).find((m) => m.model === model);
  if (!entry || entry.profiles.length === 0) {
    throw new Error(`모델 "${model}"을 카탈로그에서 찾을 수 없습니다. tf model list로 확인하세요.`);
  }
  return entry.profiles[0];
}

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ProfileVariant {
  weightsRepo: string;
  instanceType: string;
  vllmFlags: string;
  maxModelLen: number;
}

interface ModelProfileFile {
  model: string;
  vllmImage: string;
  profiles: Record<string, Partial<ProfileVariant>>;
}

export interface ResolvedProfile extends ProfileVariant {
  model: string;
  profile: string;
  vllmImage: string;
}

const REQUIRED_FIELDS: (keyof ProfileVariant)[] = [
  'weightsRepo', 'instanceType', 'vllmFlags', 'maxModelLen',
];

export function loadModelProfile(
  modelsDir: string, model: string, profile: string,
): ResolvedProfile {
  const filePath = path.join(modelsDir, `${model}.yaml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Model profile not found: ${filePath}`);
  }
  const doc = yaml.load(fs.readFileSync(filePath, 'utf8')) as ModelProfileFile;
  const variant = doc.profiles?.[profile];
  if (!variant) {
    const available = Object.keys(doc.profiles ?? {}).join(', ');
    throw new Error(`Profile "${profile}" not found in ${filePath}. Available: ${available}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (variant[field] === undefined) {
      throw new Error(`Profile "${profile}" in ${filePath} missing required field "${field}"`);
    }
  }
  return {
    model: doc.model,
    profile,
    vllmImage: doc.vllmImage,
    ...(variant as ProfileVariant),
  };
}

import * as path from 'path';
import { loadModelProfile } from '../lib/model-profile';

const fixturesDir = path.join(__dirname, 'fixtures');

describe('loadModelProfile', () => {
  test('resolves a valid profile', () => {
    const p = loadModelProfile(fixturesDir, 'dummy-model', 'int4');
    expect(p).toEqual({
      model: 'dummy-model',
      profile: 'int4',
      vllmImage: 'example/vllm:latest',
      weightsRepo: 'example/dummy-int4',
      instanceType: 'p5.48xlarge',
      vllmFlags: '--tensor-parallel-size 8',
      maxModelLen: 131072,
    });
  });

  test('throws when model file is missing', () => {
    expect(() => loadModelProfile(fixturesDir, 'no-such-model', 'int4'))
      .toThrow(/Model profile not found/);
  });

  test('throws when profile name is missing, listing available ones', () => {
    expect(() => loadModelProfile(fixturesDir, 'dummy-model', 'fp8'))
      .toThrow(/Profile "fp8" not found.*int4/);
  });

  test('throws when a required field is missing', () => {
    expect(() => loadModelProfile(fixturesDir, 'dummy-model', 'broken'))
      .toThrow(/missing required field "vllmFlags"/);
  });
});

describe('solar-open2-250b profile', () => {
  const modelsDir = path.join(__dirname, '..', 'models');
  const REQUIRED_FLAGS = [
    '--tensor-parallel-size 8',
    '--enable-expert-parallel',
    '--moe-backend triton',
    '--reasoning-parser solar_open2',
    '--tool-call-parser solar_open2',
    '--enable-auto-tool-choice',
  ];

  test.each(['int4', 'bf16'])('%s profile is valid', (profile) => {
    const p = loadModelProfile(modelsDir, 'solar-open2-250b', profile);
    expect(p.vllmImage).toBe('upstage/vllm-solar-open2:v0.22.0-solar-open2');
    expect(p.instanceType).toBe('p5.48xlarge');
    expect(p.maxModelLen).toBe(131072);
    for (const flag of REQUIRED_FLAGS) {
      expect(p.vllmFlags).toContain(flag);
    }
  });

  test('int4 uses Nota quantized weights', () => {
    const p = loadModelProfile(modelsDir, 'solar-open2-250b', 'int4');
    expect(p.weightsRepo).toBe('nota-ai/Solar-Open2-250B-Nota-INT4');
  });

  test('bf16 uses original weights', () => {
    const p = loadModelProfile(modelsDir, 'solar-open2-250b', 'bf16');
    expect(p.weightsRepo).toBe('upstage/Solar-Open2-250B');
  });
});

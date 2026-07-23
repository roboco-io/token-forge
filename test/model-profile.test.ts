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

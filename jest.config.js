module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  // tsc가 소스 옆에 만드는 *.js(gitignored)가 .ts를 가리지 않도록 .ts를 먼저 해석한다
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
};

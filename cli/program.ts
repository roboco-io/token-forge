import { Command } from 'commander';
import * as pkg from '../package.json';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('tf')
    .description('token-forge — 내 AWS 계정 안의 프라이빗 바이브 코딩 LLM')
    .version(pkg.version);
  return program;
}

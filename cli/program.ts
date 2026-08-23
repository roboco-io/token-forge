import { Command } from 'commander';
import * as path from 'path';
import * as pkg from '../package.json';
import { listModels } from './catalog';

const MODELS_DIR = path.join(__dirname, '..', 'models');

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('tf')
    .description('token-forge — 내 AWS 계정 안의 프라이빗 바이브 코딩 LLM')
    .version(pkg.version);

  const model = program.command('model').description('모델 카탈로그');
  model.command('list').description('사용 가능한 모델·프로파일 나열').action(() => {
    for (const m of listModels(MODELS_DIR)) {
      console.log(`${m.model}  (profiles: ${m.profiles.join(', ')})`);
    }
  });

  return program;
}

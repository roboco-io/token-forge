#!/usr/bin/env node
import { buildProgram } from './program';

buildProgram().parseAsync(process.argv).catch((e: any) => {
  console.error(`오류: ${e.message}`);
  process.exit(1);
});

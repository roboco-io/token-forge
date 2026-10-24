import * as fs from 'fs';
import * as path from 'path';

function lockFile(dir: string, key: string): string {
  return path.join(dir, 'locks', `${key.replace(/[^A-Za-z0-9._@-]/g, '_')}.lock`);
}

/**
 * 같은 호스트 안의 batch 실행 잠금. pid를 먼저 임시 파일에 다 쓴 뒤 link()로 잠금 경로를 만든다 —
 * link는 대상이 있으면 EEXIST로 원자적으로 실패하므로, 다른 실행이 "빈 잠금 파일"을 보는 순간이 없다.
 * 남은 잠금(비정상 종료 등)은 자동 회수하지 않는다: 회수의 read→rm→create 사이 경쟁으로 새 소유자
 * 잠금을 지울 수 있기 때문이다. 대신 보유 pid와 파일 경로를 알려 사용자가 확인 후 지우게 한다.
 * 다른 호스트 간 잠금이 아니다 — 그 경우는 ASG 상태 검사(소유권 조건)만 적용된다.
 * 반환값은 해제 함수 — 자신이 쓴 pid일 때만 지운다.
 */
export function acquireLock(dir: string, key: string, pid: number = process.pid): () => void {
  const file = lockFile(dir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, String(pid));
  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const holder = readHolder(file);
    throw new Error(`${key}에 다른 tkf run(pid ${holder ?? '알 수 없음'})의 잠금이 있습니다 — 실행 중이면 끝난 뒤 다시 시도하세요. ` +
      `해당 프로세스가 없음을 확인했다면 잠금 파일을 지우세요: rm ${file}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return () => {
    try { if (fs.readFileSync(file, 'utf8') === String(pid)) fs.rmSync(file, { force: true }); }
    catch { /* 이미 없음 */ }
  };
}

function readHolder(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

/** 잠금 보유 pid (없으면 null) — tkf up/seed가 같은 호스트의 준비 중인 batch를 인수하지 않게 확인 */
export function lockHolder(dir: string, key: string): string | null {
  const file = lockFile(dir, key);
  if (!fs.existsSync(file)) return null;
  return readHolder(file) ?? '알 수 없음';
}

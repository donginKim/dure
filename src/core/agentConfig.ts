import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfigFile } from '@shared/types';

/** 저장소가 에이전트(Claude Code)에게 물리는 설정 파일: hook(명령 실행), 권한 허용, MCP 서버가 여기에 든다. */
const FILES = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
const MAX = 200_000;

/**
 * 작업 폴더에 든 에이전트 설정 파일을 읽는다. 남에게 받은 저장소라면 이 파일이 에이전트를 켜는 순간 이 PC 에서 명령을 돌릴 수 있고,
 * 에이전트가 스스로 이 파일을 써서 다음에 켜질 때의 권한을 넓힐 수도 있다. 그래서 내용을 사용자가 보고 허용한 것만 쓰게 한다.
 * hash 가 빈 글이면 그런 파일이 없다.
 */
export function readAgentConfig(worktree: string): { files: AgentConfigFile[]; hash: string } {
  const files: AgentConfigFile[] = [];
  const h = createHash('sha256');
  for (const rel of FILES) {
    let st;
    try { st = lstatSync(join(worktree, rel)); } catch { continue; }
    let text: string;
    if (st.isSymbolicLink()) text = '(다른 곳을 가리키는 링크입니다)';
    else if (!st.isFile()) continue;
    else if (st.size > MAX) text = `(너무 큽니다: ${st.size.toLocaleString('ko-KR')} 바이트)`;
    else { try { text = readFileSync(join(worktree, rel), 'utf8'); } catch { text = '(읽지 못했습니다)'; } }
    if (!text.trim()) continue;
    h.update(`\n${rel}\n`).update(text);
    files.push({ path: rel, text: text.slice(0, 8000), cut: text.length > 8000 });
  }
  return { files, hash: files.length ? h.digest('hex') : '' };
}

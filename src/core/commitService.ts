import { EventEmitter } from 'node:events';
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { CommitResult, CommitState, Workspace, FileDiff } from '@shared/types';
import type { CommitDraftStore } from './commitDrafts';
import type { Git } from './git';
import type { MessageService } from './messages';
import type { WorkspaceStore } from './stores';

const NOTICE_THREAD = '두레 알림';

/**
 * 커밋 창이 쓰는 것: 바뀐 파일과 초안 보기, 커밋, push.
 * 커밋과 push 는 사용자가 화면에서 누를 때만 실행된다. 에이전트는 하지 않는다.
 * 이벤트: 'changed' (workspaceId)
 */
/** 화면에 보낼 diff 의 상한 (글자) */
const MAX_DIFF = 400_000;

export class CommitService extends EventEmitter {
  constructor(private readonly d: {
    workspaces: WorkspaceStore;
    git: Git;
    drafts: CommitDraftStore;
    messages: MessageService;
    /** 커밋·push 뒤에 에이전트에게 알리는가 (설정). 없으면 알린다 */
    notifyAgent?: () => boolean;
  }) {
    super();
    d.drafts.on('changed', (workspaceId: string) => this.emit('changed', workspaceId));
  }

  private mustGet(id: string): Workspace {
    const ws = this.d.workspaces.get(id);
    if (!ws) throw new Error(`워크스페이스가 없습니다: ${id}`);
    // 조율 에이전트의 폴더는 저장소가 아니다. 그 폴더가 다른 저장소 안에 있으면 바깥 저장소에 커밋될 수 있다.
    if (ws.role === 'coordinator') throw new Error('조율 에이전트에는 커밋할 저장소가 없습니다.');
    return ws;
  }

  async state(workspaceId: string): Promise<CommitState> {
    const ws = this.mustGet(workspaceId);
    const branch = await this.d.git.currentBranch(ws.worktreePath);
    const [files, remoteUrl, ahead, merging] = await Promise.all([
      this.d.git.changedFiles(ws.worktreePath),
      this.d.git.remoteUrl(ws.worktreePath),
      this.d.git.aheadCount(ws.worktreePath, branch),
      this.d.git.merging(ws.worktreePath),
    ]);
    return { branch, files, draft: this.d.drafts.get(workspaceId) ?? null, remoteUrl, ahead, merging };
  }

  /**
   * 바뀐 파일 하나의 변경 내용. 화면의 "변경" 보기가 쓴다.
   * 바뀐 파일 목록에 있는 것만 보여 준다 (화면이 아무 경로나 읽게 하지 않는다).
   */
  async diff(workspaceId: string, file: string): Promise<FileDiff> {
    const ws = this.mustGet(workspaceId);
    const entry = (await this.d.git.changedFiles(ws.worktreePath)).find((f) => f.path === file);
    if (!entry) throw new Error('바뀐 파일이 아닙니다 (이미 커밋했거나 되돌렸습니다).');
    const cut = (text: string): FileDiff => ({ text: text.slice(0, MAX_DIFF), binary: false, truncated: text.length > MAX_DIFF });
    if (entry.status !== 'untracked') {
      const text = await this.d.git.fileDiff(ws.worktreePath, file);
      return /^Binary files .* differ$/m.test(text) && !text.includes('\n@@') ? { text: '', binary: true, truncated: false } : cut(text);
    }
    // 추적 안 된 파일: git 이 비교할 것이 없으므로 내용 전체를 추가된 줄로 보여 준다.
    const abs = join(ws.worktreePath, file);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return cut(`새 심볼릭 링크 → ${readlinkSync(abs)}`);
    if (!st.isFile()) return cut('(파일이 아닙니다)');
    const fd = openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_DIFF));
      const n = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, n);
      if (head.includes(0)) return { text: '', binary: true, truncated: false };
      const body = head.toString('utf8');
      const lines = body.split('\n');
      if (lines.at(-1) === '') lines.pop();
      return { text: [`새 파일: ${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'), binary: false, truncated: st.size > MAX_DIFF };
    } finally {
      closeSync(fd);
    }
  }

  async commit(workspaceId: string, i: { files: string[]; message: string }, o: { auto?: boolean } = {}): Promise<CommitResult> {
    const ws = this.mustGet(workspaceId);
    // 실패하면 여기서 던져지고 초안은 그대로 남는다.
    const result = await this.d.git.commitFiles({ path: ws.worktreePath, files: i.files, message: i.message });
    this.d.drafts.clear(workspaceId);
    this.notify(ws, o.auto ? `두레가 자동 반영 설정에 따라 커밋했다 (확인 명령 통과, 리뷰에 높음 없음): ${result.hash} ${result.subject}` : `사용자가 커밋했다: ${result.hash} ${result.subject}`);
    this.emit('changed', workspaceId);
    return result;
  }

  async push(workspaceId: string): Promise<string> {
    const ws = this.mustGet(workspaceId);
    if (!(await this.d.git.remoteUrl(ws.worktreePath))) throw new Error('원격 저장소(origin)가 없습니다.');
    const branch = await this.d.git.currentBranch(ws.worktreePath);
    // 이 워크스페이스의 브랜치만 보낸다. 에이전트가 브랜치를 바꿔 놓았을 수 있다.
    if (branch !== ws.branch) {
      throw new Error(`현재 브랜치(${branch === 'HEAD' ? '분리된 HEAD' : branch})는 이 워크스페이스의 브랜치(${ws.branch})가 아닙니다. 터미널에서 브랜치를 확인하세요.`);
    }
    const output = await this.d.git.push({ path: ws.worktreePath, branch });
    this.notify(ws, `사용자가 push 했다: ${branch} → origin`);
    this.emit('changed', workspaceId);
    return output;
  }

  /** 에이전트에게 두레의 알림으로 전한다. 꺼진 에이전트에게는 보내지 않는다: 알림 때문에 에이전트가 떠오르면 안 된다. */
  private notify(ws: Workspace, text: string): void {
    if (this.d.notifyAgent?.() === false) return;
    if (this.d.workspaces.get(ws.id)?.status === 'stopped') return;
    const thread = this.d.messages.threads(ws.projectId)
      .find((t) => {
        if (t.title !== NOTICE_THREAD) return false;
        // 제목만 같은 스레드를 다른 에이전트가 만들 수 있다. 두레가 이 워크스페이스에 보낸 것으로 시작하는 스레드만 쓴다.
        const first = this.d.messages.messages(t.id)[0];
        return first?.from.kind === 'system' && first.toWorkspaceId === ws.id;
      });
    try {
      this.d.messages.send({
        projectId: ws.projectId, from: { kind: 'system' }, toWorkspaceId: ws.id, body: text,
        threadId: thread?.id, title: thread ? undefined : NOTICE_THREAD,
      });
    } catch { /* 알림 실패가 커밋 결과를 바꾸면 안 된다 */ }
  }
}

import { EventEmitter } from 'node:events';
import type { CommitResult, CommitState, Workspace } from '@shared/types';
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

  async commit(workspaceId: string, i: { files: string[]; message: string }): Promise<CommitResult> {
    const ws = this.mustGet(workspaceId);
    // 실패하면 여기서 던져지고 초안은 그대로 남는다.
    const result = await this.d.git.commitFiles({ path: ws.worktreePath, files: i.files, message: i.message });
    this.d.drafts.clear(workspaceId);
    this.notify(ws, `사용자가 커밋했다: ${result.hash} ${result.subject}`);
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

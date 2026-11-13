import type { ActivityItem } from '@shared/types';
import type { AutoShipService } from './autoship';
import type { ChatService } from './chat/chatService';
import type { FigureService } from './figures';
import type { Git } from './git';
import type { MessageService } from './messages';
import type { ReviewService } from './review';
import type { WorkspaceStore } from './stores';
import type { TodoService } from './todos';
import type { VerifyService } from './verify';

const cut = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/**
 * 작업 기록: 한 워크스페이스가 무엇을 받고 무엇을 했는지 시간순으로 모은다 (새것부터).
 * 받은 지시(사용자의 말, 두레·다른 워크스페이스의 메시지), 보낸 메시지, 올린 자료, TODO, 커밋과 바꾼 파일, 확인 명령, 리뷰, 자동 반영, 그림.
 * 따로 적어 두는 것은 없다: 이미 있는 기록들에서 읽어 모은다.
 */
export class ActivityService {
  constructor(private readonly d: {
    workspaces: WorkspaceStore; messages: MessageService; todos: TodoService; git: Git; chat: ChatService;
    verify: VerifyService; review: ReviewService; autoShip: AutoShipService; figures: FigureService;
  }) {}

  async list(workspaceId: string, limit = 300): Promise<ActivityItem[]> {
    const ws = this.d.workspaces.get(workspaceId);
    if (!ws) throw new Error('워크스페이스가 없습니다.');
    const names = new Map(this.d.workspaces.listAll(ws.projectId).map((w) => [w.id, w.role === 'coordinator' ? '조율 에이전트' : w.name]));
    const out: ActivityItem[] = [];
    const add = (i: Omit<ActivityItem, 'id'>): void => { out.push({ ...i, id: `${i.kind}:${i.at}:${out.length}` }); };
    // 사용자가 대화로 한 말
    try {
      for (const it of this.d.chat.snapshot(workspaceId).items) if (it.kind === 'user') add({ kind: 'instruction', at: it.at, title: '사용자의 말', detail: cut(it.text, 400) });
    } catch { /* 대화 기록이 없다 */ }
    // 메시지: 받은 것과 보낸 것
    for (const t of this.d.messages.threads(ws.projectId)) {
      for (const m of this.d.messages.messages(t.id)) {
        if (m.toWorkspaceId === workspaceId) {
          const from = m.from.kind === 'user' ? '사용자' : m.from.kind === 'system' ? '두레' : names.get(m.from.workspaceId) ?? '다른 워크스페이스';
          add({ kind: m.from.kind === 'workspace' ? 'message-in' : 'instruction', at: m.createdAt, title: `${from}에게서 ${t.title ? `"${cut(t.title, 40)}"` : '메시지'}`, detail: cut(m.body, 400) });
        } else if (m.from.kind === 'workspace' && m.from.workspaceId === workspaceId) {
          add({ kind: 'message-out', at: m.createdAt, title: `${names.get(m.toWorkspaceId) ?? '다른 워크스페이스'}에게 보냄`, detail: cut(m.body, 400) });
        }
      }
    }
    for (const a of this.d.messages.artifacts(ws.projectId)) if (a.workspaceId === workspaceId) add({ kind: 'artifact', at: a.createdAt, title: `자료를 올림: ${cut(a.title, 80)}`, detail: cut(a.body, 300) });
    // TODO: 지금 상태와 마지막으로 바뀐 때
    for (const t of this.d.todos.listWorkspace(workspaceId)) {
      if (t.status === 'done' || t.status === 'cancelled') add({ kind: 'todo', at: t.updatedAt, title: `TODO ${t.status === 'done' ? '완료' : '취소'}: ${cut(t.title, 100)}`, detail: t.updatedBy === 'user' ? '사용자가 바꿈' : '에이전트가 바꿈' });
      else add({ kind: 'todo', at: t.createdAt, title: `TODO 생김: ${cut(t.title, 100)}`, detail: t.status === 'doing' ? '진행 중' : '' });
    }
    // 커밋과 바꾼 파일 (기준 브랜치에서 갈라진 뒤의 것)
    try {
      const log = await this.d.git.raw(['-C', ws.worktreePath, 'log', '--no-merges', '--max-count=50', '--format=%x1e%H%x1f%ct%x1f%an%x1f%s', '--name-status', `${ws.baseBranch}..HEAD`]);
      for (const rec of log.split('\x1e').filter((x) => x.trim())) {
        const [head, ...lines] = rec.split('\n');
        const [hash, ct, author, subject] = (head ?? '').split('\x1f');
        const files = lines.map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/\t/g, ' '));
        add({ kind: 'commit', at: Number(ct) * 1000, title: `커밋: ${cut(subject ?? '', 100)}`, detail: `${(hash ?? '').slice(0, 7)} · ${author} · 파일 ${files.length}개${files.length ? `: ${cut(files.slice(0, 12).join(', '), 400)}` : ''}` });
      }
    } catch { /* 작업 폴더가 없다 */ }
    // 확인 명령과 리뷰 (마지막 것)
    const v = this.d.verify.status(workspaceId);
    if (v && v.at) add({ kind: 'verify', at: v.at, title: `확인 명령 ${v.state === 'passed' ? '통과' : '실패'}: ${v.command}`, detail: v.state === 'failed' ? cut(v.output, 300) : '', ok: v.state === 'passed' });
    const r = await this.d.review.status(workspaceId).catch(() => null);
    if (r && r.state !== 'running') add({ kind: 'review', at: r.at, title: r.state === 'failed' ? '리뷰를 받지 못함' : `리뷰: ${r.findings.length ? `${r.findings.length}건 (높음 ${r.findings.filter((f) => f.severity === '높음').length})` : '찾은 문제 없음'}`, detail: r.state === 'failed' ? r.error : cut([r.summary, ...r.findings.slice(0, 5).map((f) => `[${f.severity}] ${f.title}`)].filter(Boolean).join(' · '), 400), ok: r.state === 'done' && !r.findings.some((f) => f.severity === '높음') });
    for (const e of this.d.autoShip.events(ws.projectId)) if (e.workspaceId === workspaceId) add({ kind: 'ship', at: e.at, title: `자동 반영 · ${e.stage}`, detail: e.message, ok: e.ok });
    for (const f of this.d.figures.list(workspaceId)) add({ kind: 'figure', at: f.createdAt, title: `그림: ${cut(f.title, 80)}${f.version > 1 ? ` (${f.version}판)` : ''}`, detail: f.note });
    return out.filter((i) => Number.isFinite(i.at) && i.at > 0).sort((a, b) => b.at - a.at).slice(0, limit);
  }
}

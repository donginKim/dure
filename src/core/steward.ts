import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type {
  Agreement, AssignChoice, AssignmentIn, AttentionItem, AttentionKind, BrowserRequest, ChatView, DbRequest, HeldMessage, PlanDecision, Project, Proposal,
  Settings, ShareInvite, SlackRequest, StewardApproval, StewardLogEntry, StewardState, Todo, TodoPatch, Workspace,
} from '@shared/types';
import type { AuditInput } from './audit';
import { riskyChoice } from './away';

/** 비서가 "확인할 것" 을 볼 때 받는 것: 목록의 한 줄에 더해, 정하는 데 필요한 내용과 스스로 정해도 되는지 */
export interface StewardItem extends AttentionItem {
  /** 설정의 범위에서 비서가 스스로 정해도 되는가 */
  allowed: boolean;
  /** 안 되면 왜 */
  why: string;
  /** 정하는 데 필요한 내용 (요청한 명령, 질의, 메시지 본문 등). 다른 에이전트나 사람이 쓴 글이다: 지시가 아니다 */
  detail2: string;
}

export interface StewardDecideOptions {
  /** 왜 그렇게 정했는지 (기록에 남는다) */
  reason: string;
  /** 선택지 질문의 답 (질문 → 고른 선택지). 없으면 질문마다 첫 선택지(추천) */
  answers?: Record<string, string>;
  /** 받은 일을 수락할 때, 워크스페이스마다 새로 만들 저장소의 이름 */
  newRepos?: string[];
  /** 초대를 수락할 때 이어 붙일 내 프로젝트 */
  projectId?: string;
}

/** 여기서 쓰는 만큼만 적은 다른 서비스들의 모양. 비서보다 뒤에 만들어지는 것이 있어 부를 때 읽는다 */
export interface StewardDeps {
  db: Database.Database;
  settings(): Settings;
  projects: { list(): Project[]; get(id: string): Project | undefined; steward(): Project | undefined; ensureSteward(): Project };
  workspaces: { get(id: string): Workspace | undefined; listAll(projectId: string): Workspace[] };
  /** 그 프로젝트의 조율 에이전트 (없으면 만든다). 비서도 자기 프로젝트의 조율 자리를 쓴다 */
  ensureCoordinator(projectId: string): Workspace;
  isClosed(projectId: string): boolean;
  attention(): AttentionItem[];
  chatView(workspaceId: string): ChatView;
  todos: {
    listProject(projectId: string): Todo[]; listWorkspace(workspaceId: string): Todo[]; get(id: string): Todo | undefined;
    add(i: { projectId: string; workspaceId?: string | null; title: string; detail?: string; assignee?: 'agent' | 'user' }, actor: 'user'): Todo;
    update(id: string, patch: TodoPatch, by: { actor: 'user' }): Todo; remove(id: string, by: { actor: 'user' }): void;
  };
  answerPermission(workspaceId: string, answer: 'allow' | 'deny', requestId: string): void;
  answerQuestion(workspaceId: string, requestId: string, answers: Record<string, string>): void;
  nudge(workspaceId: string): Promise<void>;
  dismissStuck(workspaceId: string): void;
  plan: { pending(projectId: string): Proposal | null; approve(id: string, d: PlanDecision): Promise<unknown>; reject(id: string, reason?: string): void };
  dbs: { pending(projectId: string): DbRequest[]; decide(id: string, allow: boolean, o?: { always?: boolean }): unknown };
  slack: { pending(projectId: string): SlackRequest[]; decide(id: string, allow: boolean, o?: { always?: boolean }): unknown };
  browser: { pending(projectId: string): BrowserRequest[]; decide(id: string, allow: boolean): void };
  peers: { held(projectId: string): HeldMessage[]; pass(id: string, workspaceId?: string): void; drop(id: string): void; shareInvites(): ShareInvite[]; acceptInvite(id: string, projectId: string): unknown; declineInvite(id: string): void };
  assignments: {
    incoming(projectId?: string): AssignmentIn[]; accept(id: string, choices: AssignChoice[], o?: { share?: boolean }): Promise<unknown>; decline(id: string): unknown;
    takeBrief(id: string): void; dropBrief(id: string): void;
  };
  agreements: { list(projectId: string, o?: { proposed?: boolean }): Agreement[]; accept(id: string): unknown; remove(id: string): void };
  /** 조율 에이전트에게 글을 전한다 (두레의 알림으로 간다) */
  send(projectId: string, workspaceId: string, body: string, title: string): void;
  audit(i: AuditInput): void;
}

const LEVEL: Record<StewardApproval, number> = { suggest: 0, safe: 1, all: 2 };
/** 종류마다, 비서가 스스로 정하려면 설정이 어디까지 올라가 있어야 하나. null 은 비서가 정할 수 없는 것 */
const NEEDS: Record<AttentionKind, StewardApproval | null> = {
  // 읽기만 하는 승인, 내 에이전트끼리의 약속, 멈춘 에이전트 깨우기
  db: 'safe', slack: 'safe', browser: 'safe', agreement: 'safe', stuck: 'safe',
  // 권한 요청과 질문은 내용에 따라 갈린다 (아래 need())
  agent: 'all',
  // 되돌리기 어렵거나 다른 사람이 끼어 있는 것
  plan: 'all', held: 'all', assign: 'all', brief: 'all', invite: 'all',
  // 연결 확인: 상대 화면의 숫자와 맞춰 봐야 한다. 비서가 볼 수 없다
  pair: null,
  // 상한을 올리거나 모델을 바꾸는 일: 사용자가 화면에서 한다
  budget: null, limit: null, ship: null,
};
const CANNOT: Partial<Record<AttentionKind, string>> = {
  pair: '연결 요청은 상대 화면의 6자리 숫자와 맞춰 봐야 해서 비서가 대신 확인할 수 없습니다. 사용자가 직접 확인합니다.',
  budget: '예산은 사용자가 프로젝트의 현황 탭에서 올리거나 오늘만 더 씁니다.',
  limit: '사용 한도에 걸린 것은 풀릴 때까지 기다리거나 사용자가 다른 모델로 바꿉니다.',
  ship: '자동 반영이 멈춘 것은 사용자가 그 워크스페이스에서 원인을 보고 다시 시도합니다.',
};
const LEVEL_NAME: Record<StewardApproval, string> = { suggest: '추천만', safe: '안전한 것만 스스로', all: '전부 스스로' };
const clip = (s: unknown, max = 2000): string => { const t = String(s ?? ''); return t.length > max ? `${t.slice(0, max)}… (${t.length - max}자 생략)` : t; };
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/**
 * 비서: 모든 프로젝트를 보는 에이전트. 두레가 관리하는 보이지 않는 프로젝트의 조율 자리에 산다.
 * 모든 프로젝트의 현황과 TODO 를 보고 고치고, "확인할 것" 을 설정의 범위 안에서 대신 정한다.
 *
 * 비서는 에이전트의 출력과 다른 사람의 글을 읽는다. 그 글이 비서를 속여 승인하게 만들 수 있으므로:
 *  - 어디까지 스스로 정할지는 사용자가 설정에서 정한다 (기본은 안전한 것만)
 *  - 연결 확인처럼 비서가 판단할 근거가 없는 것은 어느 설정에서도 못 한다
 *  - 정한 것은 모두 기록한다 (감사 기록과 steward_log)
 * 이벤트: 'changed' (기록이나 상태가 바뀜)
 */
export class StewardService extends EventEmitter {
  constructor(private readonly d: StewardDeps) { super(); }

  /** 비서의 자리(프로젝트와 워크스페이스). 없으면 만든다. */
  ensure(): { project: Project; workspace: Workspace } {
    const project = this.d.projects.ensureSteward();
    return { project, workspace: this.d.ensureCoordinator(project.id) };
  }

  isSteward(projectId: string): boolean {
    return this.d.projects.get(projectId)?.kind === 'steward';
  }

  state(): StewardState {
    const { project, workspace } = this.ensure();
    const s = this.d.settings();
    return { project, workspace: this.d.workspaces.get(workspace.id) ?? workspace, name: s.stewardName, approval: s.stewardApproval, auto: s.stewardAuto };
  }

  /** 모든 프로젝트의 현황: 워크스페이스의 상태와 TODO 의 진행, 나를 기다리는 것의 수. */
  overview(): unknown {
    const waiting = this.d.attention();
    return {
      projects: this.d.projects.list().map((p) => {
        const ws = this.d.workspaces.listAll(p.id);
        const big = this.d.todos.listProject(p.id).filter((t) => t.workspaceId === null);
        return {
          id: p.id, name: p.name, status: p.status,
          waiting: waiting.filter((a) => a.projectId === p.id).length,
          project_todos: { done: big.filter((t) => t.status === 'done').length, total: big.filter((t) => t.status !== 'cancelled').length },
          workspaces: ws.map((w) => {
            const todos = this.d.todos.listWorkspace(w.id).filter((t) => t.status !== 'cancelled');
            return {
              id: w.id, name: w.role === 'coordinator' ? '조율 에이전트' : w.name, role: w.role, status: w.status, summary: w.summary,
              todos: { done: todos.filter((t) => t.status === 'done').length, total: todos.length, doing: todos.filter((t) => t.status === 'doing').map((t) => t.title).slice(0, 3) },
            };
          }),
        };
      }),
      waiting_without_project: waiting.filter((a) => !a.projectId).length,
    };
  }

  /** 한 프로젝트의 TODO 전부 (프로젝트의 큰 일과 워크스페이스마다의 일). */
  todos(projectId: string): unknown {
    const p = this.project(projectId);
    const line = (t: Todo): unknown => ({ id: t.id, title: t.title, detail: clip(t.detail, 300), status: t.status, assignee: t.assignee, parent: t.parentId });
    return {
      project: { id: p.id, name: p.name },
      project_todos: this.d.todos.listProject(p.id).filter((t) => t.workspaceId === null).map(line),
      workspaces: this.d.workspaces.listAll(p.id).filter((w) => w.role !== 'coordinator').map((w) => ({ id: w.id, name: w.name, status: w.status, todos: this.d.todos.listWorkspace(w.id).map(line) })),
    };
  }

  addTodo(i: { projectId: string; workspaceId?: string; title: string; detail?: string; assignee?: 'agent' | 'user' }): Todo {
    const p = this.project(i.projectId);
    if (i.workspaceId) this.workspaceOf(p.id, i.workspaceId);
    const t = this.d.todos.add({ projectId: p.id, workspaceId: i.workspaceId ?? null, title: i.title, detail: i.detail, assignee: i.assignee }, 'user');
    this.d.audit({ actor: 'agent', actorName: this.name(), action: 'steward.todo_add', projectId: p.id, workspaceId: i.workspaceId ?? null, target: t.title });
    return t;
  }

  updateTodo(id: string, patch: TodoPatch): Todo {
    const t = this.todo(id);
    const next = this.d.todos.update(t.id, patch, { actor: 'user' });
    this.d.audit({ actor: 'agent', actorName: this.name(), action: 'steward.todo_update', projectId: t.projectId, workspaceId: t.workspaceId, target: next.title, detail: { fields: Object.keys(patch).join(',') } });
    return next;
  }

  removeTodo(id: string): void {
    const t = this.todo(id);
    this.d.todos.remove(t.id, { actor: 'user' });
    this.d.audit({ actor: 'agent', actorName: this.name(), action: 'steward.todo_remove', projectId: t.projectId, workspaceId: t.workspaceId, target: t.title });
  }

  /** 그 프로젝트의 조율 에이전트에게 글을 전한다. */
  tell(projectId: string, text: string): void {
    const p = this.project(projectId);
    const body = String(text ?? '').trim();
    if (!body) throw new Error('전할 글이 없습니다.');
    if (body.length > 4000) throw new Error('글이 너무 깁니다 (4000자까지).');
    const c = this.d.ensureCoordinator(p.id);
    this.d.send(p.id, c.id, body, `${this.name()}가 전합니다`);
    this.d.audit({ actor: 'agent', actorName: this.name(), action: 'steward.tell', projectId: p.id, workspaceId: c.id, target: '조율 에이전트' });
  }

  /** 확인할 것. 비서가 정하는 데 필요한 내용과, 설정의 범위에서 스스로 정해도 되는지를 함께 준다. */
  items(): StewardItem[] {
    const level = this.d.settings().stewardApproval;
    return this.d.attention().map((a) => {
      const detail2 = this.detail(a);
      const need = this.need(a);
      const allowed = need !== null && LEVEL[level] >= LEVEL[need];
      const why = allowed ? '' : need === null ? CANNOT[a.kind] ?? '비서가 정할 수 없는 것입니다.' : `설정의 승인 범위가 "${LEVEL_NAME[level]}" 입니다. 이것은 "${LEVEL_NAME[need]}" 이어야 비서가 정합니다: 사용자에게 추천만 하세요.`;
      return { ...a, allowed, why, detail2 };
    });
  }

  /** 확인할 것 하나를 정한다. 설정의 범위 밖이면 던진다. 무엇을 했는지 한 줄로 돌려준다. */
  async decide(itemId: string, decision: 'approve' | 'deny', o: StewardDecideOptions): Promise<string> {
    if (decision !== 'approve' && decision !== 'deny') throw new Error('approve 나 deny 로 정하세요.');
    const reason = String(o?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!reason) throw new Error('왜 그렇게 정했는지(reason) 적어야 합니다. 기록에 남습니다.');
    const item = this.items().find((a) => a.id === itemId);
    if (!item) throw new Error('그 항목이 없습니다 (이미 처리됐을 수 있습니다). steward_waiting 으로 다시 보세요.');
    if (!item.allowed) { this.log(item, decision, reason, `하지 않음: ${item.why}`); throw new Error(item.why); }
    let outcome = '';
    try {
      outcome = await this.apply(item, decision === 'approve', o);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(item, decision, reason, `실패: ${msg}`);
      this.d.audit({ actor: 'agent', actorName: this.name(), action: 'steward.decide', projectId: item.projectId, workspaceId: item.workspaceId, target: `${item.kind}: ${item.title}`, outcome: 'failed', reason: msg, detail: { decision } });
      throw e;
    }
    this.log(item, decision, reason, outcome);
    this.d.audit({ actor: 'agent', actorName: this.name(), action: 'steward.decide', projectId: item.projectId, workspaceId: item.workspaceId, target: `${item.kind}: ${item.title}`, reason, detail: { decision, level: this.d.settings().stewardApproval } });
    return outcome;
  }

  /** 비서가 처리한 것 (새 것부터). */
  history(limit = 100): StewardLogEntry[] {
    const rows = this.d.db.prepare('SELECT * FROM steward_log ORDER BY at DESC, rowid DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))) as
      { id: string; at: number; item_id: string; kind: string; project_id: string | null; project_name: string; title: string; decision: string; reason: string; outcome: string }[];
    return rows.map((r) => ({ id: r.id, at: r.at, itemId: r.item_id, kind: r.kind, projectId: r.project_id, projectName: r.project_name, title: r.title, decision: r.decision === 'deny' ? 'deny' : 'approve', reason: r.reason, outcome: r.outcome }));
  }

  // ---- 안쪽 ----

  private name(): string { return this.d.settings().stewardName || '비서'; }

  private project(id: string): Project {
    const p = this.d.projects.get(String(id));
    if (!p || p.kind === 'steward') throw new Error(`프로젝트가 없습니다: ${id}. steward_overview 의 id 를 쓰세요.`);
    return p;
  }

  private workspaceOf(projectId: string, workspaceId: string): Workspace {
    const w = this.d.workspaces.get(String(workspaceId));
    if (!w || w.projectId !== projectId || w.role === 'coordinator') throw new Error('그 프로젝트의 워크스페이스가 아닙니다.');
    return w;
  }

  private todo(id: string): Todo {
    const t = this.d.todos.get(String(id));
    if (!t || this.isSteward(t.projectId)) throw new Error('그 TODO 가 없습니다. steward_todos 의 id 를 쓰세요.');
    return t;
  }

  private log(item: AttentionItem, decision: 'approve' | 'deny', reason: string, outcome: string): void {
    this.d.db.prepare('INSERT INTO steward_log (id, at, item_id, kind, project_id, project_name, title, decision, reason, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), Date.now(), item.id, item.kind, item.projectId, item.projectName, item.title, decision, reason, outcome.slice(0, 500));
    this.d.db.prepare('DELETE FROM steward_log WHERE id NOT IN (SELECT id FROM steward_log ORDER BY at DESC, rowid DESC LIMIT 1000)').run();
    this.emit('changed');
  }

  /** 항목의 요청 id (종류: 뒤의 것) */
  private ref(item: AttentionItem): string { return item.id.slice(item.kind.length + 1); }

  /** 이 항목을 비서가 정하려면 설정이 어디까지 올라가 있어야 하나. */
  private need(item: AttentionItem): StewardApproval | null {
    const base = NEEDS[item.kind];
    if (item.kind === 'browser' && base) {
      // 이 PC 의 개발 서버만 가볍게 본다. 바깥 주소는 로그인된 사이트일 수 있다.
      const r = item.projectId ? this.d.browser.pending(item.projectId).find((x) => x.id === this.ref(item)) : undefined;
      return r && LOCAL.test(r.origin) ? 'safe' : 'all';
    }
    if (item.kind === 'agent' && item.workspaceId) {
      const v = this.view(item.workspaceId);
      // 선택지 질문은 되돌리기 어려운 것이 아니면 가볍게 본다 (자리 비움과 같은 선). 명령을 실행해도 되는지는 무겁게 본다.
      if (v?.question) return v.question.questions.some((q) => riskyChoice(`${q.question} ${q.options.map((x) => `${x.label} ${x.description}`).join(' ')}`)) ? 'all' : 'safe';
    }
    return base;
  }

  private view(workspaceId: string): ChatView | null {
    try { return this.d.chatView(workspaceId); } catch { return null; }
  }

  /** 정하는 데 필요한 내용. 다른 에이전트나 사람이 쓴 글이 들어 있다. */
  private detail(item: AttentionItem): string {
    const p = item.projectId; const id = this.ref(item);
    try {
      switch (item.kind) {
        case 'agent': {
          const v = item.workspaceId ? this.view(item.workspaceId) : null;
          if (v?.question) return clip(JSON.stringify({ questions: v.question.questions.map((q) => ({ question: q.question, options: q.options })) }));
          const perm = v?.pendingPermission;
          return perm ? clip(JSON.stringify({ tool: perm.tool, what: perm.summary, input: perm.input, agent_says: perm.explain?.by === 'agent' ? perm.explain.text : undefined, why_asked: perm.reason })) : '';
        }
        case 'plan': {
          const plan = p ? this.d.plan.pending(p) : null;
          return plan ? clip(JSON.stringify({ summary: clip(plan.summary, 1200), new_repos: plan.newRepos.map((r) => r.name), workspaces: plan.items.map((i) => ({ name: i.name, role: i.role, todos: i.todos.length, to: i.owner ? '다른 사람' : '나' })), project_todos: plan.projectTodos.length, suggested_by: plan.suggestedBy?.name }), 3000) : '';
        }
        case 'db': { const r = p ? this.d.dbs.pending(p).find((x) => x.id === id) : undefined; return r ? clip(JSON.stringify({ connection: r.connectionName, sql: r.sql, warnings: r.warnings })) : ''; }
        case 'slack': { const r = p ? this.d.slack.pending(p).find((x) => x.id === id) : undefined; return r ? clip(r.what) : ''; }
        case 'browser': { const r = p ? this.d.browser.pending(p).find((x) => x.id === id) : undefined; return r ? clip(JSON.stringify({ origin: r.origin, url: r.url })) : ''; }
        case 'held': { const h = p ? this.d.peers.held(p).find((x) => x.id === id) : undefined; return h ? clip(JSON.stringify({ from: h.fromLabel, to_me: h.toPerson, body: h.body, attached: h.artifacts.map((a) => a.title) })) : ''; }
        case 'assign': { const a = this.d.assignments.incoming(p ?? undefined).find((x) => x.id === id); return a ? clip(JSON.stringify({ from: a.fromName, summary: clip(a.summary, 800), workspaces: a.items })) : ''; }
        case 'agreement': { const a = p ? this.d.agreements.list(p, { proposed: true }).find((x) => x.id === id) : undefined; return a ? clip(JSON.stringify({ title: a.title, by: a.author, body: a.body })) : ''; }
        case 'invite': { const i = this.d.peers.shareInvites().find((x) => x.id === id); return i ? clip(JSON.stringify({ project: i.name, from: i.fromName, observer: i.observer === true })) : ''; }
        default: return '';
      }
    } catch { return ''; }
  }

  private async apply(item: StewardItem, approve: boolean, o: StewardDecideOptions): Promise<string> {
    const p = item.projectId; const id = this.ref(item);
    switch (item.kind) {
      case 'agent': {
        const wsId = item.workspaceId!;
        const v = this.view(wsId);
        if (v?.question) {
          if (!approve) throw new Error('선택지 질문은 거절할 수 없습니다. answers 에 고른 선택지를 적어 approve 하거나, 사용자에게 남기세요.');
          const answers: Record<string, string> = {};
          for (const q of v.question.questions) {
            const picked = o.answers?.[q.question];
            if (picked !== undefined && !q.options.some((x) => x.label === picked)) throw new Error(`"${q.question}" 의 선택지가 아닙니다: ${picked}`);
            answers[q.question] = picked ?? q.options[0]?.label ?? '';
          }
          this.d.answerQuestion(wsId, v.question.requestId, answers);
          return `질문에 답함: ${Object.values(answers).join(', ')}`;
        }
        const perm = v?.pendingPermission;
        if (!perm?.requestId || !perm.canAnswer) throw new Error('이 승인 창에는 비서가 답할 수 없습니다 (터미널 방식이거나 이미 닫혔습니다). 사용자에게 남기세요.');
        this.d.answerPermission(wsId, approve ? 'allow' : 'deny', perm.requestId);
        return `${approve ? '허용함' : '거부함'}: ${perm.summary}`;
      }
      case 'plan': {
        const plan = p ? this.d.plan.pending(p) : null;
        if (!plan || plan.id !== id) throw new Error('그 계획안이 없습니다.');
        if (!approve) { this.d.plan.reject(plan.id, o.reason); return '계획안을 거절함'; }
        await this.d.plan.approve(plan.id, { newRepos: plan.newRepos, addRepos: plan.addRepos, items: plan.items, projectTodos: plan.projectTodos });
        return `계획안을 올라온 그대로 승인함 (워크스페이스 ${plan.items.length}개)`;
      }
      case 'db': this.d.dbs.decide(id, approve); return approve ? 'DB 조회를 허용함' : 'DB 조회를 거부함';
      case 'slack': this.d.slack.decide(id, approve); return approve ? '슬랙 읽기를 허용함' : '슬랙 읽기를 거부함';
      case 'browser': this.d.browser.decide(id, approve); return approve ? '브라우저 주소를 허용함' : '브라우저 주소를 거부함';
      case 'agreement': if (approve) { this.d.agreements.accept(id); return '약속을 받아들임'; } this.d.agreements.remove(id); return '약속 제안을 버림';
      case 'stuck': {
        const wsId = item.workspaceId!;
        if (approve) { await this.d.nudge(wsId); return '멈춘 에이전트를 다시 깨움'; }
        this.d.dismissStuck(wsId); return '막힘 알림을 닫음';
      }
      case 'held': if (approve) { this.d.peers.pass(id); return '다른 사람의 메시지를 넘겨줌'; } this.d.peers.drop(id); return '다른 사람의 메시지를 버림';
      case 'brief': if (approve) { this.d.assignments.takeBrief(id); return '기획서 정리를 자료로 받음'; } this.d.assignments.dropBrief(id); return '기획서 정리를 버림';
      case 'assign': {
        if (!approve) { this.d.assignments.decline(id); return '받은 일을 거절함'; }
        const a = this.d.assignments.incoming(p ?? undefined).find((x) => x.id === id);
        if (!a) throw new Error('그 배정이 없습니다.');
        const names = o.newRepos ?? [];
        if (names.length !== a.items.length) throw new Error(`받은 일을 수락하려면 워크스페이스마다 새 저장소의 이름을 new_repos 에 적어야 합니다 (${a.items.length}개, 영문·숫자·. _ - 만).`);
        await this.d.assignments.accept(id, names.map((n) => ({ repoId: '', newRepo: String(n) })), { share: true });
        return `받은 일을 수락함 (워크스페이스 ${a.items.length}개)`;
      }
      case 'invite': {
        if (!approve) { this.d.peers.declineInvite(id); return '초대를 거절함'; }
        if (!o.projectId) throw new Error('초대를 수락하려면 이어 붙일 내 프로젝트의 id 를 project 에 적어야 합니다.');
        this.d.peers.acceptInvite(id, this.project(o.projectId).id);
        return '초대에 참여함';
      }
      default: throw new Error(CANNOT[item.kind] ?? '비서가 정할 수 없는 것입니다.');
    }
  }
}

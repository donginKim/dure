import { useCallback, useEffect, useRef, useState } from 'react';
import { isNewRepoId } from '@shared/plan';
import type { CoordinatorInfo, PlanTodo, Project, Proposal, ProposalItem, Repo, Workspace } from '@shared/types';
import { approveLabel, draftRepoId, fromDraft, planCounts, planProblem, specMessage, tidyPlan, toDraft, type PlanDraft } from '../planView';
import { STATUS_LABEL } from '../tree';
import { AssignPanel } from './AssignPanel';
import { ChatPane } from './ChatPane';
import { DbRequests } from './DbRequests';
import type { ConversationData } from './ConversationPanel';
import { Markdown } from './Markdown';
import { describeError } from './WorkspaceView';

/** 계획안의 TODO 목록: 제목을 고치고, 담당을 바꾸고, 빼고, 더한다. */
function TodoEditor({ todos, onChange, agentLabel }: { todos: PlanTodo[]; onChange: (next: PlanTodo[]) => void; agentLabel: string }) {
  const patch = (i: number, p: Partial<PlanTodo>): void => onChange(todos.map((t, k) => (k === i ? { ...t, ...p } : t)));
  return (
    <div className="plan-todos">
      {todos.map((t, i) => (
        <div key={i} className="plan-todo">
          <button
            className={`plan-who${t.assignee === 'user' ? ' me' : ''}`}
            title={t.assignee === 'user' ? '내가 할 일입니다. 누르면 에이전트의 일로 바꿉니다' : `${agentLabel}의 일입니다. 누르면 내가 할 일로 바꿉니다`}
            onClick={() => patch(i, { assignee: t.assignee === 'user' ? 'agent' : 'user' })}
          >{t.assignee === 'user' ? '나' : '에이전트'}</button>
          <div className="plan-todo-text">
            <input type="text" value={t.title} placeholder="할 일" onChange={(e) => patch(i, { title: e.target.value })} />
            {t.detail && <div className="plan-detail">{t.detail}</div>}
          </div>
          <button className="btn ghost" title="이 TODO 는 만들지 않습니다" onClick={() => onChange(todos.filter((_, k) => k !== i))}>빼기</button>
        </div>
      ))}
      <button className="btn ghost plan-add" onClick={() => onChange([...todos, { title: '', detail: '', assignee: 'agent' }])}>+ TODO 더하기</button>
    </div>
  );
}

/**
 * 계획안 검토 화면. 조율 에이전트가 기획서를 분석해 올린 것을 보여 준다: 기획서 정리, 만들 워크스페이스, TODO.
 * 여기서 고치고 승인해야 만들어진다. 승인하면 두레가 본 그대로 만든다.
 */
function PlanReview({ proposal, repos, newRepoDir, people, onBack }: { proposal: Proposal; repos: Repo[]; newRepoDir: string; people: CoordinatorInfo['people']; onBack: () => void }) {
  const [plan, setPlan] = useState<PlanDraft>(() => toDraft(proposal));
  const nextKey = useRef(0);
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  // 저장소마다 지금 체크아웃된 브랜치. 새로 더하거나 저장소를 바꿀 때의 기본 기준 브랜치다.
  const [current, setCurrent] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  // 저장소마다 고를 수 있는 브랜치를 받아 둔다.
  const repoIds = [...new Set([...repos.map((r) => r.id), ...plan.items.map((i) => i.repoId)])].filter((id) => !isNewRepoId(id)).join(',');
  useEffect(() => {
    let alive = true;
    for (const id of repoIds.split(',').filter(Boolean)) {
      window.dure.repos.branches(id).then((list) => { if (alive) setBranches((b) => ({ ...b, [id]: list })); }).catch(() => undefined);
      window.dure.repos.status(id).then((st) => { if (alive && st.ok) setCurrent((c) => ({ ...c, [id]: st.branch })); }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [repoIds]);

  const patchItem = (i: number, p: Partial<ProposalItem>): void => setPlan((d) => ({ ...d, items: d.items.map((it, k) => (k === i ? { ...it, ...p } : it)) }));
  const addItem = (): void => {
    const repo = repos[0];
    const fresh = plan.newRepos[0];
    if (repo) setPlan((d) => ({ ...d, items: [...d.items, { name: '', repoId: repo.id, baseBranch: current[repo.id] ?? '', role: '', todos: [], existing: false }] }));
    else if (fresh) setPlan((d) => ({ ...d, items: [...d.items, { name: '', repoId: draftRepoId(fresh.key), baseBranch: 'main', role: '', todos: [], existing: false }] }));
    // 저장소가 하나도 없어도, 함께하는 사람이 있으면 그 사람에게 나눠 줄 일을 더할 수 있다.
    else if (people[0]) setPlan((d) => ({ ...d, items: [...d.items, { name: '', repoId: '', baseBranch: '', role: '', todos: [], existing: false, owner: people[0]!.peerId }] }));
  };
  // 워크스페이스는 새 저장소를 key 로 가리키므로, 이름을 고쳐도 그 저장소를 쓰는 워크스페이스는 그대로 따라온다.
  const renameRepo = (i: number, name: string): void => setPlan((d) => ({ ...d, newRepos: d.newRepos.map((r, k) => (k === i ? { ...r, name } : r)) }));
  const decision = fromDraft(plan);
  const approve = async (): Promise<void> => {
    setBusy(true); setError('');
    try { await window.dure.coordinator.approve(proposal.id, tidyPlan(decision)); } catch (e) { setError(describeError((e as Error).message)); } finally { setBusy(false); }
  };
  const reject = async (): Promise<void> => {
    setBusy(true); setError('');
    try { await window.dure.coordinator.reject(proposal.id, reason); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const problem = planProblem(decision);
  const counts = planCounts(decision);
  // 맡을 사람을 바꾼다. 나로 돌리면 저장소를 다시 골라야 하니 첫 저장소로 채운다.
  const setOwner = (i: number, owner: string): void => {
    if (owner) { patchItem(i, { owner, repoId: '', baseBranch: '' }); return; }
    const repo = repos[0];
    const fresh = plan.newRepos[0];
    patchItem(i, { owner: '', repoId: repo ? repo.id : fresh ? draftRepoId(fresh.key) : '', baseBranch: repo ? current[repo.id] ?? '' : 'main' });
  };
  const personName = (id: string): string => people.find((p) => p.peerId === id)?.name ?? '함께하지 않는 사람';
  const repoName = (id: string): string => (isNewRepoId(id) ? plan.newRepos.find((r) => draftRepoId(r.key) === id)?.name ?? '' : repos.find((r) => r.id === id)?.name ?? '(알 수 없는 저장소)');

  return (
    <div className="plan">
      <div className="plan-scroll">
        <div className="plan-col">
          <div className="plan-head">
            <div>
              <div className="plan-title">계획안 검토</div>
              <div className="plan-sub">조율 에이전트가 기획서를 분석해 올린 계획입니다. <b>아직 아무것도 만들어지지 않았습니다.</b> 고칠 것을 고친 뒤 승인하면, 여기 보이는 그대로 만들어집니다.</div>
            </div>
            <button className="btn ghost" onClick={onBack} title="계획안은 그대로 두고 대화로 돌아갑니다">대화로 돌아가기</button>
          </div>

          <div className="plan-section">
            <div className="plan-label">기획서 정리</div>
            <div className="plan-summary">{proposal.summary ? <Markdown text={proposal.summary} /> : <span className="muted">조율 에이전트가 정리를 적지 않았습니다.</span>}</div>
            {proposal.note && <div className="plan-note">{proposal.note}</div>}
          </div>

          <div className="plan-section">
            <div className="plan-label">
              새 저장소 <span className="count">{plan.newRepos.length}</span>
              <span className="plan-hint">이 PC 에 빈 git 저장소(폴더)를 만들어 이 프로젝트에 등록합니다. 원격 저장소는 만들지 않습니다</span>
            </div>
            {plan.newRepos.map((r, i) => (
              <div key={r.key} className="plan-ws">
                <div className="plan-ws-line">
                  <span className="plan-kind">새로 만듦</span>
                  <input type="text" className="plan-ws-name" value={r.name} placeholder="저장소 이름 (영문, 숫자, . _ -)" onChange={(e) => renameRepo(i, e.target.value)} />
                  <button className="btn ghost" title="이 저장소는 만들지 않습니다. 이 저장소를 쓰는 워크스페이스는 다른 저장소를 골라야 합니다" onClick={() => setPlan((d) => ({ ...d, newRepos: d.newRepos.filter((_, k) => k !== i) }))}>빼기</button>
                </div>
                <input type="text" className="plan-role" value={r.description} placeholder="무엇이 들어가는 저장소인지 (README 에 적힙니다)" onChange={(e) => setPlan((d) => ({ ...d, newRepos: d.newRepos.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)) }))} />
                <div className="plan-path" title="이 위치에 폴더가 만들어집니다">만들 위치: <code>{newRepoDir}/{r.name || '…'}</code> · README.md 와 첫 커밋, 브랜치 main</div>
              </div>
            ))}
            {plan.newRepos.length === 0 && <div className="plan-none">새로 만들 저장소가 없습니다. 등록된 저장소를 씁니다.</div>}
            <button className="btn ghost plan-add" onClick={() => setPlan((d) => ({ ...d, newRepos: [...d.newRepos, { name: '', description: '', key: `n${nextKey.current++}` }] }))}>+ 새 저장소 더하기</button>
          </div>

          <div className="plan-section">
            <div className="plan-label">
              워크스페이스 <span className="count">{plan.items.length}</span>
              <span className="plan-hint">새로 만드는 것마다 그 저장소에 새 브랜치와 작업 폴더(worktree)가 생깁니다</span>
            </div>
            {plan.items.length === 0 && <div className="rows"><div className="rows-empty">만들 워크스페이스가 없습니다.</div></div>}
            {plan.items.map((it, i) => (
              <div key={i} className="plan-ws">
                <div className="plan-ws-line">
                  <span className={`plan-kind${it.existing ? ' old' : ''}`}>{it.existing ? '이미 있음' : '새로 만듦'}</span>
                  {it.existing
                    ? <span className="plan-ws-name">{it.name}</span>
                    : <input type="text" className="plan-ws-name" value={it.name} placeholder="워크스페이스 이름" onChange={(e) => patchItem(i, { name: e.target.value })} />}
                  {!it.existing && (people.length > 0 || it.owner) && (
                    <select value={it.owner ?? ''} title="맡을 사람: 다른 사람을 고르면 그 사람에게 나눠 줍니다" onChange={(e) => setOwner(i, e.target.value)}>
                      <option value="">내가 맡음</option>
                      {it.owner && !people.some((p) => p.peerId === it.owner) && <option value={it.owner}>(함께하지 않는 사람)</option>}
                      {people.map((p) => <option key={p.peerId} value={p.peerId}>{p.name} 에게{p.online ? '' : ' (지금 안 보임)'}</option>)}
                    </select>
                  )}
                  {it.existing ? <span className="muted">저장소 {repoName(it.repoId)}</span> : it.owner ? null : (
                    <>
                      <select value={it.repoId} title="저장소" onChange={(e) => patchItem(i, { repoId: e.target.value, baseBranch: isNewRepoId(e.target.value) ? 'main' : current[e.target.value] ?? '' })}>
                        {!isNewRepoId(it.repoId) && !repos.some((r) => r.id === it.repoId) && <option value={it.repoId}>(저장소를 고르세요)</option>}
                        {isNewRepoId(it.repoId) && !plan.newRepos.some((r) => draftRepoId(r.key) === it.repoId) && <option value={it.repoId}>(저장소를 고르세요)</option>}
                        {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        {plan.newRepos.map((r) => <option key={r.key} value={draftRepoId(r.key)}>{r.name || '(이름 없는 새 저장소)'} (새 저장소)</option>)}
                      </select>
                      {isNewRepoId(it.repoId) ? <select value="main" disabled title="새 저장소는 첫 커밋이 있는 main 에서 시작합니다"><option value="main">main</option></select> : (
                      <select value={it.baseBranch} title="기준 브랜치: 이 브랜치에서 새 브랜치와 작업 폴더를 만듭니다" onChange={(e) => patchItem(i, { baseBranch: e.target.value })}>
                        <option value="">현재 브랜치{current[it.repoId] ? ` (${current[it.repoId]})` : ''}</option>
                        {it.baseBranch && !(branches[it.repoId] ?? []).includes(it.baseBranch) && <option value={it.baseBranch}>{it.baseBranch}</option>}
                        {(branches[it.repoId] ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
                      </select>
                      )}
                    </>
                  )}
                  <button className="btn ghost" title={it.existing ? '이 워크스페이스에는 TODO 를 더하지 않습니다' : '이 워크스페이스와 그 TODO 는 만들지 않습니다'} onClick={() => setPlan((d) => ({ ...d, items: d.items.filter((_, k) => k !== i) }))}>빼기</button>
                </div>
                {!it.existing && <input type="text" className="plan-role" value={it.role} placeholder="맡을 일" onChange={(e) => patchItem(i, { role: e.target.value })} />}
                {it.owner && <div className="plan-path">승인하면 <b>{personName(it.owner)}</b> 에게 이 일과 기획서 정리를 보냅니다. 그 사람이 자기 두레에서 수락해야 그 사람의 PC 에 만들어집니다 (저장소는 그 사람이 고릅니다). 그 사람이 꺼져 있으면 승인되지 않습니다.</div>}
                <div className="plan-sublabel">TODO <span className="count">{it.todos.length}</span></div>
                <TodoEditor todos={it.todos} agentLabel={`"${it.name || '이 워크스페이스'}" 에이전트`} onChange={(next) => patchItem(i, { todos: next })} />
              </div>
            ))}
            <button className="btn" disabled={repos.length === 0 && plan.newRepos.length === 0 && people.length === 0} onClick={addItem}>+ 워크스페이스 더하기</button>
          </div>

          <div className="plan-section">
            <div className="plan-label">프로젝트 TODO <span className="count">{plan.projectTodos.length}</span><span className="plan-hint">어느 워크스페이스에도 속하지 않는 일, 내가 정해야 하는 것</span></div>
            <TodoEditor todos={plan.projectTodos} agentLabel="조율 에이전트" onChange={(next) => setPlan((d) => ({ ...d, projectTodos: next }))} />
          </div>
        </div>
      </div>
      <div className="plan-foot">
        <div className="plan-col plan-actions">
          {error && <div className="error" style={{ flexBasis: '100%' }}>{error}</div>}
          {rejecting ? (
            <>
              <input type="text" autoFocus className="plan-reason" value={reason} placeholder="거절하는 이유 (조율 에이전트에게 전해집니다. 비워도 됩니다)" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void reject(); }} />
              <button className="btn" disabled={busy} onClick={() => void reject()}>거절하기</button>
              <button className="btn ghost" disabled={busy} onClick={() => setRejecting(false)}>취소</button>
            </>
          ) : (
            <>
              <span className="plan-count">{problem ?? `승인하면 ${counts.repos ? `저장소 ${counts.repos}개, ` : ''}워크스페이스 ${counts.workspaces}개, TODO ${counts.todos}개가 만들어집니다${counts.handed ? `. 워크스페이스 ${counts.handed}개는 다른 사람에게 나눠 줍니다` : ''}`}</span>
              <button className="btn" disabled={busy} onClick={() => setRejecting(true)}>거절</button>
              <button className="btn primary" disabled={busy || problem !== null} onClick={() => void approve()}>{busy ? '만드는 중…' : approveLabel(decision)}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 프로젝트의 "조율" 탭. 조율 에이전트와 대화한다: 기획서를 주면 분석해 계획안을 올리고, 승인하면 일을 나눠 시키고, 모아서 보고한다.
 */
export function CoordinatorPane({ project, repos, everyone, conversation, readOnly }: {
  project: Project; repos: Repo[];
  /** 이 프로젝트의 워크스페이스 전부 (이름을 찾는 데 쓴다) */
  everyone: Workspace[];
  conversation: ConversationData; readOnly: boolean;
}) {
  const [info, setInfo] = useState<CoordinatorInfo | null>(null);
  const [error, setError] = useState('');
  // 계획안이 오면 검토 화면을 연다. 사용자가 대화로 돌아가면 그 계획안에 대해서는 다시 저절로 열지 않는다.
  const [reviewing, setReviewing] = useState(false);
  const seenProposal = useRef<string | null>(null);

  const load = useCallback(() => {
    window.dure.coordinator.get(project.id).then(setInfo).catch((e: Error) => setError(e.message));
  }, [project.id]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'coordinator' || topic === 'workspaces' || topic === 'projects') load(); });
  }, [load]);

  const proposalId = info?.proposal?.id ?? null;
  useEffect(() => {
    if (proposalId === null) { setReviewing(false); return; }
    if (seenProposal.current !== proposalId) { seenProposal.current = proposalId; setReviewing(true); }
  }, [proposalId]);

  if (!info) return <div className="coord"><div className="chat-empty">{error || '조율 에이전트를 준비하는 중…'}</div></div>;
  const ws = info.workspace;
  const hasAgent = ws.status !== 'stopped';
  const start = (): void => {
    setError('');
    window.dure.terminals.startAgent(ws.id, { cols: 120, rows: 40 }).catch((e: Error) => setError(describeError(e.message)));
  };
  // 기획서 파일을 골라 입력창에 넣을 글로 만든다. 보내는 것은 사용자가 내용을 보고 누른다.
  const attach = async (): Promise<string | null> => {
    const spec = await window.dure.coordinator.pickSpec();
    return spec ? specMessage(spec) : null;
  };
  const proposal = readOnly ? null : info.proposal;

  return (
    <div className="coord">
      <div className="coord-bar">
        <span className={`dot ${ws.status}`} />
        <span className="coord-name">조율 에이전트</span>
        <span className="tag">{STATUS_LABEL[ws.status]}</span>
        <span className="coord-help">기획서를 주면 분석해 계획안을 올립니다. 승인하면 일을 나눠 시키고 모아서 보고합니다. 코드는 직접 고치지 않습니다.</span>
        <span className="spacer" />
        {(ws.status === 'working' || ws.status === 'waiting_user') && (
          <button className="btn" title="하던 일을 멈춥니다. 꺼지지 않습니다" onClick={() => { window.dure.workspaces.interrupt(ws.id).catch((e: Error) => setError(e.message)); }}>멈춤</button>
        )}
        {hasAgent && <button className="btn ghost" title="조율 에이전트를 끕니다. 대화는 남아 있어 다시 시작하면 이어집니다" onClick={() => { window.dure.workspaces.stopAgent(ws.id).catch((e: Error) => setError(e.message)); }}>끄기</button>}
      </div>
      {error && <div className="error" style={{ margin: '8px 16px 0' }}>{error}</div>}
      {!readOnly && <DbRequests projectId={project.id} workspaceId={ws.id} workspaces={everyone} />}
      {!(proposal && reviewing) && <AssignPanel projectId={project.id} repos={repos} readOnly={readOnly} />}
      {proposal && reviewing
        ? <PlanReview key={proposal.id} proposal={proposal} repos={repos} newRepoDir={info.newRepoDir} people={info.people} onBack={() => setReviewing(false)} />
        : (
          <ChatPane
            workspace={ws} workspaces={everyone} conversation={conversation} hasAgent={hasAgent} readOnly={readOnly}
            onStartAgent={start}
            attach={readOnly ? undefined : attach}
            blank={repos.length === 0
              ? '기획서 파일을 넣거나 할 일을 쓰세요. 등록된 저장소가 없어도 됩니다: 조율 에이전트가 계획안에 새 저장소를 넣고, 승인하면 두레가 만듭니다. 이미 있는 코드로 일하려면 "현황" 탭에서 그 폴더를 먼저 등록하세요.'
              : '기획서 파일을 넣거나 할 일을 쓰세요. 조율 에이전트가 분석해 계획안(정리, 워크스페이스, TODO)을 올립니다. 검토하고 승인해야 만들어집니다.'}
            banner={proposal ? (
              <div className="plan-banner">
                <span><b>계획안이 승인을 기다립니다.</b> {proposal.newRepos.length > 0 && `새 저장소 ${proposal.newRepos.length}개, `}워크스페이스 {proposal.items.filter((i) => !i.existing).length}개{proposal.items.some((i) => i.owner) && ` (그중 ${proposal.items.filter((i) => i.owner).length}개는 다른 사람에게 나눠 줌)`}, TODO {proposal.items.reduce((n, i) => n + i.todos.length, 0) + proposal.projectTodos.length}개. 아직 만들어진 것은 없습니다.</span>
                <button className="btn primary" onClick={() => setReviewing(true)}>검토하기</button>
              </div>
            ) : null}
          />
        )}
    </div>
  );
}

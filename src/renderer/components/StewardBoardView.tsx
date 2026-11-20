import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StewardBoard, StewardBoardProject } from '@shared/types';

type Kind = 'day' | 'week' | 'month';
type Measure = 'work' | 'done';
const two = (n: number): string => String(n).padStart(2, '0');
const dayStr = (d: Date): string => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const parse = (day: string): Date => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!); };
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const short = (day: string): string => { const d = parse(day); return `${d.getMonth() + 1}/${d.getDate()}`; };
const withWeekday = (day: string): string => `${short(day)} (${WEEKDAY[parse(day).getDay()]})`;
const hours = (ms: number): string => { const min = Math.round(ms / 60_000); const h = Math.floor(min / 60); return h && min % 60 ? `${h}시간 ${min % 60}분` : h ? `${h}시간` : `${min}분`; };
const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const clean = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/** 기간: 오늘·이번 주·이번 달에서 offset 만큼 앞뒤로 옮긴 것 (주는 월요일부터) */
export function rangeOf(kind: Kind, offset: number, now = new Date()): { from: string; to: string } {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (kind === 'day') { d.setDate(d.getDate() + offset); return { from: dayStr(d), to: dayStr(d) }; }
  if (kind === 'week') {
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
    const end = new Date(d); end.setDate(end.getDate() + 6);
    return { from: dayStr(d), to: dayStr(end) };
  }
  const first = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return { from: dayStr(first), to: dayStr(new Date(first.getFullYear(), first.getMonth() + 1, 0)) };
}
const KIND_LABEL: Record<Kind, [string, string, string]> = { day: ['오늘', '어제', '일'], week: ['이번 주', '지난 주', '주'], month: ['이번 달', '지난 달', '달'] };
const rangeLabel = (kind: Kind, offset: number): string => (offset === 0 ? KIND_LABEL[kind][0] : offset === -1 ? KIND_LABEL[kind][1] : offset < 0 ? `${-offset}${KIND_LABEL[kind][2]} 전` : `${offset}${KIND_LABEL[kind][2]} 뒤`);

/**
 * 총괄 현황판: 정한 기간에 모든 프로젝트에서 얼마나, 무엇을 했는지와 지금의 상태.
 * 주간 보고를 이 화면만 보고 쓸 수 있게 한다: 오른쪽의 초안은 화면의 자료로 만든 것이고, 고쳐서 복사하거나 비서에게 다듬어 달라고 한다.
 */
export function StewardBoardView({ name, onOpenProject, onOpenWorkspace, onAsk }: {
  name: string;
  onOpenProject: (id: string) => void;
  onOpenWorkspace: (id: string, projectId: string) => void;
  /** 비서에게 글을 보내고 대화로 돌아간다 */
  onAsk: (text: string) => void;
}) {
  const [kind, setKind] = useState<Kind>('week');
  const [offset, setOffset] = useState(0);
  const [board, setBoard] = useState<StewardBoard | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [edited, setEdited] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  // 날이 바뀌면 "오늘", "이번 주" 도 따라간다.
  const todayKey = dayStr(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeOf(kind, offset), [kind, offset, todayKey]);
  /** 고친 초안이 어느 기간의 자료로 만든 것인가 */
  const [editedFor, setEditedFor] = useState('');
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    window.dure.steward.board(range).then((b) => { if (mine === seq.current) { setBoard(b); setError(''); } }).catch((e: Error) => { if (mine === seq.current) setError(clean(e)); });
  }, [range]);
  useEffect(() => { setPick(null); load(); }, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.dure.onChanged((topic) => {
      if (topic !== 'todos' && topic !== 'workspaces' && topic !== 'projects' && topic !== 'worktime' && topic !== 'attention' && topic !== 'commit') return;
      clearTimeout(timer); timer = setTimeout(load, 600);
    });
    return () => { off(); clearTimeout(timer); };
  }, [load]);
  // 초안은 사용자가 고치기 전까지 자료를 따라간다.
  useEffect(() => { if (board && !edited) setText(board.draft); }, [board, edited]);

  if (!board) return <div className="sb"><div className="chat-empty">{error ? <>{error} <button className="link" onClick={load}>다시 시도</button></> : '현황을 모으는 중…'}</div></div>;
  const t = board.totals;
  const m: Measure = measure ?? (t.workMs > 0 ? 'work' : 'done');
  const value = (d: StewardBoard['days'][number]): number => (m === 'work' ? d.workMs : d.done + d.commits);
  const top = Math.max(...board.days.map(value), m === 'work' ? 8 * 3_600_000 : 4);
  const today = dayStr(new Date());
  const inPick = (day: string): boolean => !pick || day === pick;
  const shown = board.projects.map((p) => ({ p, done: p.done.filter((d) => inPick(d.day)), commits: p.commits.filter((c) => inPick(c.day)) }))
    .filter((x) => !pick || x.done.length > 0 || x.commits.length > 0);
  const toggle = (id: string): void => setClosed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const copy = (): void => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => setError('복사하지 못했습니다.')); };
  const dense = board.days.length > 14;
  const span = board.days.length === 1 ? '일일' : board.days.length <= 7 ? '주간' : board.days.length >= 28 && board.days.length <= 31 ? '월간' : '기간';

  return (
    <div className="sb">
      <div className="sb-bar">
        <div className="sb-seg" role="group" aria-label="기간">
          {(['day', 'week', 'month'] as Kind[]).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => { setKind(k); setOffset(0); }}>{KIND_LABEL[k][0]}</button>
          ))}
        </div>
        <button className="btn ghost" aria-label="앞 기간" onClick={() => setOffset((o) => o - 1)}>◀</button>
        <span className="sb-range"><b>{rangeLabel(kind, offset)}</b> {board.from === board.to ? withWeekday(board.from) : `${withWeekday(board.from)} ~ ${withWeekday(board.to)}`}</span>
        <button className="btn ghost" aria-label="뒤 기간" disabled={offset >= 0} onClick={() => setOffset((o) => Math.min(0, o + 1))}>▶</button>
        {offset !== 0 && <button className="link" onClick={() => setOffset(0)}>지금으로</button>}
        <span className="spacer" />
        {pick && <button className="tag sb-pick" onClick={() => setPick(null)} title="날짜 고르기를 풉니다">{withWeekday(pick)}만 보는 중 ✕</button>}
      </div>
      {error && <div className="error" style={{ margin: '8px 16px 0' }} onClick={() => setError('')}>{error}</div>}
      <div className="sb-body">
        <div className="sb-main">
          <div className="sb-tiles">
            <div className="sb-tile"><div className="sb-tile-n">{t.workMs > 0 ? hours(t.workMs) : '기록 없음'}</div><div className="sb-tile-l">근무시간{t.workDays > 0 ? ` · ${t.workDays}일` : ''}</div></div>
            <div className="sb-tile"><div className="sb-tile-n">{t.done}</div><div className="sb-tile-l">끝낸 일</div></div>
            <div className="sb-tile"><div className="sb-tile-n">{t.commits}</div><div className="sb-tile-l">커밋</div></div>
            <div className="sb-tile"><div className="sb-tile-n">{t.mains}</div><div className="sb-tile-l">기준 브랜치 반영</div></div>
            <div className="sb-tile"><div className="sb-tile-n">{tokens(t.tokens)}</div><div className="sb-tile-l">쓴 토큰</div></div>
          </div>

          {board.days.length > 1 && (
            <div className="sb-card">
              <div className="sb-card-head">
                <span>{m === 'work' ? '날마다의 근무시간' : '날마다 끝낸 일과 커밋'}</span>
                <span className="plan-hint">막대를 누르면 그날 한 일만 봅니다</span>
                <span className="spacer" />
                <div className="sb-seg small" role="group" aria-label="막대가 나타내는 것">
                  <button className={m === 'work' ? 'on' : ''} aria-pressed={m === 'work'} onClick={() => setMeasure('work')}>근무시간</button>
                  <button className={m === 'done' ? 'on' : ''} aria-pressed={m === 'done'} onClick={() => setMeasure('done')}>한 일</button>
                </div>
              </div>
              <div className={`sb-chart${dense ? ' dense' : ''}`} onMouseLeave={() => setHover(null)}>
                {board.days.map((d, i) => {
                  const v = value(d);
                  const tip = `${withWeekday(d.day)} · ${d.workMs > 0 ? `근무 ${hours(d.workMs)}` : '근무 기록 없음'} · 끝낸 일 ${d.done} · 커밋 ${d.commits}${d.mains ? ` · 반영 ${d.mains}` : ''}`;
                  return (
                    <button
                      key={d.day} className={`sb-col${pick === d.day ? ' on' : ''}${pick && pick !== d.day ? ' dim' : ''}${d.day === today ? ' today' : ''}${d.day > today ? ' future' : ''}`}
                      aria-pressed={pick === d.day} aria-label={tip}
                      onMouseEnter={() => setHover(d.day)} onFocus={() => setHover(d.day)} onBlur={() => setHover(null)}
                      onClick={() => setPick((p) => (p === d.day ? null : d.day))}
                    >
                      <span className="sb-col-plot">
                        {hover === d.day && <span className={`sb-tip${i > board.days.length / 2 ? ' left' : ''}`} role="tooltip">{tip}</span>}
                        <span className="sb-col-bar" style={{ height: `${v > 0 ? Math.max(3, (v / top) * 100) : 0}%` }} />
                      </span>
                      <span className="sb-col-day">{dense ? (parse(d.day).getDate() === 1 || parse(d.day).getDay() === 1 ? short(d.day) : '') : WEEKDAY[parse(d.day).getDay()]}</span>
                      {!dense && <span className="sb-col-val">{v > 0 ? (m === 'work' ? `${Math.round(v / 360_000) / 10}h` : v) : ''}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {shown.length === 0 && <div className="pin-empty">{pick ? `${withWeekday(pick)}에 끝낸 일과 커밋이 없습니다.` : '프로젝트가 없습니다. 왼쪽 위에서 프로젝트를 만들면 여기에 모입니다.'}</div>}
          {shown.map(({ p, done, commits }) => (
            <ProjectCard key={p.projectId} p={p} done={done} commits={commits} picked={Boolean(pick)} open={!closed.has(p.projectId)} onToggle={() => toggle(p.projectId)} onOpenProject={onOpenProject} onOpenWorkspace={onOpenWorkspace} />
          ))}

          {!pick && board.waiting.length > 0 && (
            <div className="sb-card">
              <div className="sb-card-head"><span>내 확인을 기다리는 것</span><span className="count">{board.waiting.length}</span></div>
              <ul className="sb-list">
                {board.waiting.map((w, i) => (
                  <li key={i}>{w.projectName && <span className="tag warn">{w.projectName}</span>} {w.title}{w.projectId && <button className="link sb-go" onClick={() => onOpenProject(w.projectId!)}>열기</button>}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside className="sb-draft">
          <div className="sb-card-head">
            <span>{span} 보고 초안</span>
            <span className="spacer" />
            {edited && <button className="link" onClick={() => setEdited(false)} title="고친 것을 버리고 화면의 자료로 다시 만듭니다">다시 만들기</button>}
          </div>
          {edited && editedFor !== `${board.from}~${board.to}`
            ? <div className="sb-draft-hint sb-draft-stale">고친 초안은 다른 기간({editedFor.replace('~', ' ~ ')})의 것입니다. 지금 보는 기간으로 바꾸려면 "다시 만들기" 를 누르세요.</div>
            : <div className="plan-hint sb-draft-hint">왼쪽의 자료로 만든 초안입니다 (없는 일은 적지 않습니다). 고쳐서 복사하세요.{edited ? ' 고친 뒤에는 자료가 바뀌어도 그대로 둡니다.' : ''}</div>}
          <textarea className="sb-draft-text" value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); if (!edited) { setEdited(true); setEditedFor(`${board.from}~${board.to}`); } }} aria-label="보고 초안" />
          <div className="sb-draft-actions">
            <button className="btn primary" onClick={copy}>{copied ? '복사했습니다' : '복사'}</button>
            <button className="btn" title={`${name}가 같은 자료로 성과 중심의 글로 다듬어 대화에 적어 줍니다 (토큰을 씁니다).`}
              onClick={() => onAsk(`${board.from} 부터 ${board.to} 까지의 ${span} 보고를 써 주세요. steward_report 로 그 기간(from ${board.from}, to ${board.to})의 자료를 보고, 프로젝트마다 성과 중심으로 다듬어 주세요. 자료에 없는 일은 적지 마세요.`)}>
              {name}에게 다듬어 달라고 하기
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ProjectCard({ p, done, commits, picked, open, onToggle, onOpenProject, onOpenWorkspace }: {
  p: StewardBoardProject; done: StewardBoardProject['done']; commits: StewardBoardProject['commits'];
  /** 날짜를 골라 보는 중 (지금의 상태는 숨긴다) */
  picked: boolean; open: boolean; onToggle: () => void;
  onOpenProject: (id: string) => void; onOpenWorkspace: (id: string, projectId: string) => void;
}) {
  const [more, setMore] = useState(false);
  const pct = p.progress.total > 0 ? Math.round((p.progress.done / p.progress.total) * 100) : 0;
  const days = [...new Set(done.map((d) => d.day))];
  const commitN = picked ? commits.length : p.commitCount;
  return (
    <div className={`sb-card sb-project${p.state !== 'active' ? ' quiet' : ''}`}>
      <div className="sb-project-head">
        <button className="sb-project-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="sb-caret">{open ? '▾' : '▸'}</span>
          <span className="sb-project-name">{p.name}</span>
          {p.state === 'done' && <span className="tag">완료</span>}
          {p.state === 'gone' && <span className="tag">지운 프로젝트</span>}
        </button>
        <span className="sb-chips">
          <span className={done.length ? 'sb-chip strong' : 'sb-chip'}>끝낸 일 {done.length}</span>
          <span className={commitN ? 'sb-chip strong' : 'sb-chip'}>커밋 {commitN}</span>
          {!picked && p.mains > 0 && <span className="sb-chip">반영 {p.mains}</span>}
          {!picked && p.state === 'active' && <span className="sb-chip">하는 중 {p.doing.length}</span>}
          {!picked && p.state === 'active' && <span className="sb-chip">남은 일 {p.todoCount}</span>}
          {!picked && p.waiting.length > 0 && <span className="sb-chip warn">확인 대기 {p.waiting.length}</span>}
        </span>
        <span className="spacer" />
        {p.progress.total > 0 && (
          <span className="sb-progress" title={`지금까지 TODO ${p.progress.total}건 가운데 ${p.progress.done}건을 끝냈습니다`}>
            <span className="sb-progress-track"><span className="sb-progress-fill" style={{ width: `${pct}%` }} /></span>
            <span className="sb-progress-n">{p.progress.done}/{p.progress.total}</span>
          </span>
        )}
        {p.state !== 'gone' && <button className="link" onClick={() => onOpenProject(p.projectId)}>열기</button>}
      </div>
      {open && (
        <div className="sb-project-body">
          <div className="sb-sec">
            <div className="sb-sec-title">끝낸 일</div>
            {done.length === 0 && <div className="muted">이 기간에 끝낸 일이 없습니다.</div>}
            {days.map((day) => (
              <div key={day} className="sb-day">
                <div className="sb-day-label">{withWeekday(day)}</div>
                <ul className="sb-list">
                  {done.filter((d) => d.day === day).map((d, i) => (
                    <li key={i}><span className="sb-check">✓</span> {d.title}{d.workspace && <span className="muted"> · {d.workspace}</span>}{d.byUser && <span className="tag">직접</span>}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {commits.length > 0 && (
            <div className="sb-sec">
              <div className="sb-sec-title">커밋</div>
              <ul className="sb-list">
                {!picked && p.commitCount > commits.length && <li className="muted">제목이 남지 않은 커밋 {p.commitCount - commits.length}건 (정리한 워크스페이스의 것)</li>}
                {commits.slice(0, more ? 200 : 6).map((c) => (
                  <li key={c.hash}><code className="sb-hash">{c.hash.slice(0, 7)}</code> {c.subject || <span className="muted">(제목을 읽지 못했습니다)</span>}<span className="muted"> · {short(c.day)}{c.workspace ? ` · ${c.workspace}` : ''}</span></li>
                ))}
              </ul>
              {commits.length > 6 && <button className="link" onClick={() => setMore((v) => !v)}>{more ? '접기' : `${commits.length - 6}건 더 보기`}</button>}
            </div>
          )}
          {!picked && p.state === 'active' && (
            <div className="sb-now">
              <div className="sb-sec">
                <div className="sb-sec-title">하는 중</div>
                {p.doing.length === 0 ? <div className="muted">없습니다.</div> : (
                  <ul className="sb-list">{p.doing.map((d, i) => <li key={i}>{d.title}{d.workspace && <span className="muted"> · {d.workspace}</span>}</li>)}</ul>
                )}
              </div>
              <div className="sb-sec">
                <div className="sb-sec-title">남은 일</div>
                {p.todoCount === 0 ? <div className="muted">없습니다.</div> : (
                  <ul className="sb-list">
                    {p.todo.slice(0, 6).map((d, i) => <li key={i}>{d.title}{d.workspace && <span className="muted"> · {d.workspace}</span>}{d.byUser && <span className="tag">직접</span>}</li>)}
                    {p.todoCount > 6 && <li className="muted">외 {p.todoCount - 6}건</li>}
                  </ul>
                )}
              </div>
            </div>
          )}
          {!picked && p.waiting.length > 0 && (
            <div className="sb-sec">
              <div className="sb-sec-title">내 확인을 기다리는 것</div>
              <ul className="sb-list">{p.waiting.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {!picked && p.workspaces.length > 0 && (
            <div className="sb-ws">
              {p.workspaces.map((w) => (
                <button key={w.id} className="sb-ws-item" onClick={() => onOpenWorkspace(w.id, p.projectId)} title={w.summary || '이 워크스페이스를 엽니다'}>
                  <span className={`dot ${w.status}`} /> {w.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

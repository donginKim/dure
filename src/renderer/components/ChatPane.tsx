import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ChatItem, ChatQuestion, ChatStep, ChatView, Message, SlashCommand, Workspace } from '@shared/types';
import { applyMention, elapsed, matchCommands, matchMentions, mergeEntries, stepsLabel, stepsRunning, type Entry, type Mention, type PeerEntry } from '../chatView';
import { clock, deliveryNote, workspaceName } from '../conversationView';
import { Attachment, type ConversationData } from './ConversationPanel';
import { Markdown } from './Markdown';
import { TerminalPane } from './TerminalPane';

const MAX_SHOWN = 20_000;
const cut = (s: string): string => (s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}\n… (${s.length - MAX_SHOWN}자 생략)` : s);
const STEP_STATE: Record<ChatStep['status'], string> = { running: '하는 중', done: '끝남', error: '오류', denied: '실행 안 함' };

function StepRow({ workspaceId, step }: { workspaceId: string; step: ChatStep }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ input: string; output: string | null } | null>(null);
  // 펼쳐 둔 단계가 끝나면 결과를 다시 가져온다.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    window.dure.chat.step(workspaceId, step.id).then((d) => { if (alive) setDetail(d); }).catch(() => undefined);
    return () => { alive = false; };
  }, [open, workspaceId, step.id, step.status]);
  const took = step.endedAt !== null && step.endedAt - step.startedAt >= 1000 ? elapsed(step.endedAt - step.startedAt) : '';
  return (
    <div className={`step ${step.status}`}>
      <button className="step-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`step-mark ${step.status}`} title={STEP_STATE[step.status]} />
        <span className="step-summary">{step.summary}</span>
        {step.status === 'denied' && <span className="step-note">실행 안 함</span>}
        {step.status === 'error' && <span className="step-note bad">오류</span>}
        {took && <span className="step-took">{took}</span>}
        <span className="chat-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="step-detail">
          {detail === null ? <div className="step-loading">불러오는 중…</div> : (
            <>
              {detail.input && <pre className="raw">{cut(detail.input)}</pre>}
              {detail.output !== null
                ? (detail.output ? <pre className={`raw out${step.status === 'error' ? ' bad' : ''}`}>{cut(detail.output)}</pre> : <div className="step-loading">출력 없음</div>)
                : <div className="step-loading">{step.status === 'running' ? '아직 실행 중입니다.' : '결과가 기록되지 않았습니다.'}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const StepsBlock = memo(function StepsBlock({ workspaceId, steps }: { workspaceId: string; steps: ChatStep[] }) {
  const [open, setOpen] = useState(false);
  const running = stepsRunning(steps);
  const failed = steps.filter((s) => s.status === 'error').length;
  return (
    <div className="steps">
      <button className="steps-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="steps-label">{stepsLabel(steps)}</span>
        {running ? <span className="spin" /> : <span className="steps-ok">✓</span>}
        {failed > 0 && <span className="step-note bad">오류 {failed}</span>}
        <span className="chat-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="steps-list">{steps.map((s) => <StepRow key={s.id} workspaceId={workspaceId} step={s} />)}</div>}
    </div>
  );
});

function DureLine({ item }: { item: Extract<ChatItem, { kind: 'dure' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dure-line">
      <button className="dure-head" aria-expanded={open} disabled={!item.text} onClick={() => setOpen((v) => !v)} title="두레가 에이전트에게 전달한 글입니다">
        <span className="dure-badge">두레가 전달</span>
        <span className="dure-title">{item.title}</span>
        {item.text && <span className="chat-caret">{open ? '▾' : '▸'}</span>}
      </button>
      {open && <pre className="dure-body">{item.text}</pre>}
    </div>
  );
}

function peerTitle(e: PeerEntry, workspaces: Workspace[]): string {
  const m = e.message;
  if (e.direction === 'sent') return `${workspaceName(m.toWorkspaceId, workspaces)}에게 보냄`;
  if (m.from.kind === 'user') return '내가 대화에 남긴 말';
  if (m.from.kind === 'system') return '두레 알림';
  return `${workspaceName(m.from.workspaceId, workspaces)}가 보냄`;
}

function PeerCard({ entry, workspaces, conversation }: { entry: PeerEntry; workspaces: Workspace[]; conversation: ConversationData }) {
  const m: Message = entry.message;
  const info = conversation.delivery[m.toWorkspaceId];
  const note = entry.pending && info ? deliveryNote(info) : undefined;
  // 긴 메시지는 접어 둔다: 대화의 흐름이 메시지 한 건에 밀려나지 않게.
  const long = m.body.length > 600 || m.body.split('\n').length > 12;
  const [open, setOpen] = useState(false);
  return (
    <div className={`peer ${entry.direction}${m.from.kind === 'system' ? ' system' : ''}`}>
      <div className="peer-head">
        <span className="peer-icon" aria-hidden>{entry.direction === 'sent' ? '↗' : '↙'}</span>
        <span className="peer-title">{peerTitle(entry, workspaces)}</span>
        <span className="peer-at">{clock(m.createdAt)}</span>
      </div>
      <div className={`peer-body${long && !open ? ' clamp' : ''}`}><Markdown text={m.body} /></div>
      {long && <button className="peer-more" onClick={() => setOpen((v) => !v)}>{open ? '접기' : '전체 보기'}</button>}
      {m.artifactIds.map((id, i) => {
        const a = conversation.artifacts.find((x) => x.id === id);
        return a ? <Attachment key={`${id}-${i}`} artifact={a} /> : null;
      })}
      {entry.pending && <div className={`msg-wait${note?.attention ? ' attention' : ''}`}>전달 대기{note?.text ? ` · ${note.text}` : ''}</div>}
    </div>
  );
}

const EntryView = memo(function EntryView({ entry, workspaceId, workspaces, conversation }: {
  entry: Entry; workspaceId: string; workspaces: Workspace[]; conversation: ConversationData;
}) {
  switch (entry.kind) {
    case 'user': return <div className="bubble-row"><div className="bubble">{entry.text}</div></div>;
    case 'assistant': return <div className="say"><Markdown text={entry.text} /></div>;
    case 'steps': return <StepsBlock workspaceId={workspaceId} steps={entry.steps} />;
    case 'dure': return <DureLine item={entry} />;
    case 'output': return <pre className="raw command-out">{cut(entry.text)}</pre>;
    case 'notice': return <div className="chat-notice"><span>{entry.text}</span></div>;
    case 'peer': return <PeerCard entry={entry} workspaces={workspaces} conversation={conversation} />;
  }
});

/** 에이전트가 여러 선택지 중에서 고르라고 묻는 카드 (채팅 방식). */
function QuestionCard({ question, onAnswer, onDismiss }: { question: ChatQuestion; onAnswer: (answers: Record<string, string>) => void; onDismiss: () => void }) {
  // 질문 번호 → 고른 선택지들, 직접 쓴 답
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const answerOf = (q: ChatQuestion['questions'][number], i: number): string => {
    const own = typed[i]?.trim() ?? '';
    const chosen = picked[i] ?? [];
    // 하나만 고르는 질문은 직접 쓴 답이 선택지를 대신하고, 여러 개 고르는 질문은 함께 낸다.
    return q.multiSelect ? [...chosen, ...(own ? [own] : [])].join(', ') : (own || chosen.join(', '));
  };
  const ready = question.questions.length > 0 && question.questions.every((q, i) => answerOf(q, i));
  const toggle = (q: ChatQuestion['questions'][number], i: number, label: string): void => {
    if (!q.multiSelect) setTyped((t) => ({ ...t, [i]: '' }));
    setPicked((p) => {
      const cur = p[i] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
      return { ...p, [i]: next };
    });
  };
  return (
    <div className="permit ask">
      <div className="permit-title">에이전트가 묻습니다</div>
      {question.questions.map((q, i) => (
        <div key={i} className="ask-q">
          <div className="ask-text">{q.question}{q.multiSelect && <span className="permit-hint"> (여러 개 고를 수 있음)</span>}</div>
          <div className="ask-options">
            {q.options.map((o) => {
              const on = (q.multiSelect || !typed[i]?.trim()) && (picked[i] ?? []).includes(o.label);
              return (
                <button key={o.label} className={`ask-option${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(q, i, o.label)}>
                  <span className="ask-label">{o.label}</span>
                  {o.description && <span className="ask-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            type="text" className="ask-other" placeholder={q.multiSelect ? '그 밖의 답 직접 쓰기' : '직접 쓰기'} value={typed[i] ?? ''}
            onChange={(e) => setTyped((t) => ({ ...t, [i]: e.target.value }))}
          />
        </div>
      ))}
      <div className="permit-actions">
        <button className="btn primary" disabled={!ready} onClick={() => onAnswer(Object.fromEntries(question.questions.map((q, i) => [q.question, answerOf(q, i)])))}>답하기</button>
        <button className="btn" onClick={onDismiss}>답하지 않고 넘기기</button>
      </div>
    </div>
  );
}

const EMPTY: ChatView = { available: true, reason: null, items: [], hidden: 0, workingSince: null, pendingPermission: null, queued: [], canSend: false, engine: 'chat', streaming: null, question: null, lastError: null };

/**
 * 채팅 보기. 에이전트는 터미널에서 돌고, 이 화면은 그 대화 기록을 읽어 보여준다.
 * 입력창의 글과 승인 답은 에이전트의 터미널에 써 넣는다.
 */
export function ChatPane({ workspace, workspaces, conversation, hasAgent, agentTerminalId, readOnly = false, blank, banner, attach, onShowTerminal, onStartAgent }: {
  workspace: Workspace; workspaces: Workspace[]; conversation: ConversationData; hasAgent: boolean;
  /** 완료된 프로젝트다: 지난 대화만 보고 에이전트를 시작하지 않는다 */
  readOnly?: boolean;
  /** 대화가 비어 있을 때 보일 안내 (없으면 기본 안내) */
  blank?: string;
  /** 입력창 위에 끼워 보일 것 (조율 에이전트의 계획안 알림) */
  banner?: ReactNode;
  /** 파일을 골라 입력창에 넣을 글을 돌려준다 (조율 에이전트의 "기획서 파일"). 없으면 버튼을 보이지 않는다 */
  attach?: () => Promise<string | null>;
  /** 살아 있는 에이전트 터미널. 고르는 화면이 뜨면 이 터미널을 채팅 안에 끼워 보인다 */
  agentTerminalId?: string;
  /** 터미널 보기로 넘어간다. 없으면 그 버튼들을 보이지 않는다 (조율 에이전트에는 터미널 화면이 없다) */
  onShowTerminal?: () => void; onStartAgent: () => void;
}) {
  const [view, setView] = useState<ChatView>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [behind, setBehind] = useState(false);
  // 에이전트가 고르는 화면을 띄웠을 때 그 터미널을 채팅 안에 끼워 보이는 창.
  //  slash: 슬래시 명령을 보냈는데 곧바로 결과가 기록되지 않았다 (/model 처럼 고르는 화면이 떴다). count 는 그때의 항목 수
  //  manual: 사용자가 직접 열었다 (승인 창의 다른 선택지 등)
  const [peek, setPeek] = useState<{ why: 'slash'; count: number } | { why: 'manual' } | null>(null);
  const [startingLong, setStartingLong] = useState(false);
  // 입력창에서 고를 수 있는 슬래시 명령 (채팅 방식의 에이전트가 알려 준다)
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [menuAt, setMenuAt] = useState(0);
  const entryCount = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const load = useCallback(() => {
    window.dure.chat.get(workspace.id).then((v) => { setView(v); setLoaded(true); }).catch((e: Error) => setError(e.message));
  }, [workspace.id]);

  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'chat' || topic === 'workspaces') load(); });
  }, [load]);

  useEffect(() => {
    if (view.workingSince === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view.workingSince]);

  const liveChat = view.engine === 'chat' && hasAgent;
  useEffect(() => {
    if (!liveChat) { setCommands([]); return; }
    let alive = true;
    // 목록은 에이전트가 뜬 직후에 온다. 빈 목록이면 조금 뒤에 다시 묻는다.
    const ask = (left: number): void => {
      window.dure.chat.commands(workspace.id).then((list) => {
        if (!alive) return;
        if (list.length) setCommands(list);
        else if (left > 0) setTimeout(() => ask(left - 1), 1500);
      }).catch(() => undefined);
    };
    ask(6);
    return () => { alive = false; };
  }, [liveChat, workspace.id]);
  // Esc 로 목록만 닫는다. 글을 더 치면 다시 뜬다.
  const [menuClosed, setMenuClosed] = useState<string | null>(null);
  const menu = useMemo(() => (menuClosed === draft ? [] : matchCommands(draft, commands)), [draft, commands, menuClosed]);
  useEffect(() => { setMenuAt(0); }, [draft]);
  const pick = (c: SlashCommand): void => { setDraft(`/${c.name} `); input.current?.focus(); };

  // "@" 로 함께하는 사람과 그 사람들의 워크스페이스를 고른다 (함께하는 프로젝트일 때만 뜬다).
  const [mentionable, setMentionable] = useState<Mention[]>([]);
  const [caret, setCaret] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void Promise.all([window.dure.peers.share(workspace.projectId), window.dure.peers.remote(workspace.projectId)]).then(([share, remote]) => {
        if (!alive) return;
        setMentionable([
          ...(share?.members ?? []).filter((m) => !m.me).map((m) => ({ label: `@${m.name}`, hint: `${m.owner ? '프로젝트를 연 사람' : '함께하는 사람'}${m.online ? '' : ' · 지금 안 보임'} · 그 사람에게 직접 묻습니다` })),
          ...remote.map((r) => ({ label: r.label, hint: `${r.peerName} 의 워크스페이스 · 그 에이전트에게 보냅니다` })),
        ]);
      }).catch(() => undefined);
    };
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'peers') load(); });
    return () => { alive = false; off(); };
  }, [workspace.projectId]);
  // 코드가 글을 바꾼 뒤(명령 고르기, 파일 넣기, 보내기)에도 커서 자리를 맞춘다.
  useEffect(() => { const el = input.current; if (el) setCaret(el.selectionStart ?? draft.length); }, [draft]);
  const mention = useMemo(() => (menuClosed === draft ? null : matchMentions(draft, caret, mentionable)), [draft, caret, mentionable, menuClosed]);
  const pickMention = (m: Mention): void => {
    if (!mention) return;
    const next = applyMention(draft, caret, mention.start, m.label);
    setDraft(next.text); setCaret(next.caret);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  };

  const messages = useMemo(() => Object.values(conversation.messages).flat(), [conversation.messages]);
  const entries = useMemo(() => mergeEntries(view.items, messages, workspace.id), [view.items, messages, workspace.id]);

  // 맨 아래를 보고 있었으면 새 내용을 따라간다. 위를 읽는 중이면 그대로 두고 알려만 준다.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight - el.scrollTop - el.clientHeight >= 60) setBehind(true);
    else stick.current = true; // 내용이 다 보이면 맨 아래에 있는 것이다
  }, [entries, view.pendingPermission, view.queued, view.streaming, view.question]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (stick.current) setBehind(false);
  };
  const toBottom = (): void => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setBehind(false);
    el.scrollTop = el.scrollHeight;
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      await window.dure.chat.send(workspace.id, text);
      if (text.startsWith('/') && !text.includes('\n')) {
        // 바로 끝나는 명령(/context 등)은 1초 안에 결과가 기록된다. 그렇지 않으면 고르는 화면이 떠 있는 것이다.
        const count = entryCount.current;
        setTimeout(() => { if (entryCount.current === count) setPeek({ why: 'slash', count }); }, 1200);
      }
      setDraft('');
      stick.current = true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 사람 목록이 떠 있으면 ↑↓ 로 고르고 Tab 이나 Enter 로 넣는다.
    if (mention && !e.nativeEvent.isComposing) {
      const n = mention.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenuAt((i) => (i + 1) % n); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenuAt((i) => (i - 1 + n) % n); return; }
      const chosen = mention.items[Math.min(menuAt, n - 1)]!;
      // 이미 다 친 이름이면 Enter 는 보내기다.
      const typed = draft.slice(mention.start, caret) === chosen.label;
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !typed)) { e.preventDefault(); pickMention(chosen); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenuClosed(draft); return; }
    }
    // 슬래시 명령 목록이 떠 있으면 ↑↓ 로 고르고 Tab 이나 Enter 로 넣는다.
    if (menu.length && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenuAt((i) => (i + 1) % menu.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenuAt((i) => (i - 1 + menu.length) % menu.length); return; }
      const chosen = menu[Math.min(menuAt, menu.length - 1)]!;
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && draft !== `/${chosen.name}`)) { e.preventDefault(); pick(chosen); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenuClosed(draft); return; }
    }
    // 한글 조합 중의 Enter 는 글자를 확정하는 것이지 보내기가 아니다.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const answer = (a: 'allow' | 'deny' | 'always'): void => {
    setError('');
    window.dure.chat.answerPermission(workspace.id, a, view.pendingPermission?.requestId).catch((e: Error) => setError(e.message));
  };

  entryCount.current = entries.length;
  // 고르는 화면을 닫으면 명령의 결과가 기록되어 항목이 는다. 그때 끼워 보이던 창을 닫는다.
  useEffect(() => {
    if (peek?.why === 'slash' && entries.length > peek.count) setPeek(null);
  }, [entries.length, peek]);
  const statusNow = workspace.status;
  useEffect(() => {
    if (statusNow !== 'waiting_user') setPeek((p) => (p?.why === 'manual' ? null : p));
    if (statusNow !== 'starting') { setStartingLong(false); return; }
    // 시작이 오래 걸리면 무언가를 묻고 있는 것이다 (로그인, 넘기지 못한 신뢰 창 등).
    const t = setTimeout(() => setStartingLong(true), 5000);
    return () => clearTimeout(t);
  }, [statusNow]);

  // 채팅 방식에서는 대화 기록을 못 읽어도 입력창과 승인·질문 카드는 남긴다: 그것들이 에이전트에 답하는 유일한 길이다.
  if (loaded && !view.available && view.engine !== 'chat') {
    return (
      <div className="chat">
        <div className="chat-empty">
          <div>{view.reason}</div>
          {onShowTerminal && <button className="btn" onClick={onShowTerminal}>터미널 보기로</button>}
        </div>
      </div>
    );
  }

  const status = workspace.status;
  const permission = status === 'waiting_user' ? view.pendingPermission : null;
  const working = status === 'working' && view.workingSince !== null;
  // 채팅만으로는 답할 수 없는 창이 떠 있다: 그 터미널을 여기에 끼워 보인다.
  const mustPeek = status === 'waiting_user' ? !permission?.canAnswer : status === 'starting' && startingLong;
  const showPeek = Boolean(agentTerminalId) && hasAgent && (mustPeek || peek !== null);
  const peekTitle = status === 'starting' ? '에이전트가 시작하면서 무언가를 묻고 있습니다'
    : status === 'waiting_user' ? '에이전트가 고르기를 기다립니다'
      : '고르는 화면이 열려 있습니다';

  let composer;
  if (!hasAgent) {
    composer = (
      <div className="composer-off">
        <span>{readOnly ? '완료된 프로젝트입니다. 프로젝트를 다시 열면 이어서 일할 수 있습니다.' : view.lastError ? `에이전트가 오류로 끝났습니다: ${view.lastError}` : '에이전트가 꺼져 있습니다.'}</span>
        {!readOnly && <button className="btn primary" onClick={onStartAgent}>에이전트 시작</button>}
      </div>
    );
  } else if (view.question) {
    composer = (
      <QuestionCard
        key={view.question.requestId}
        question={view.question}
        onAnswer={(answers) => { setError(''); window.dure.chat.answerQuestion(workspace.id, view.question!.requestId, answers).catch((e: Error) => setError(e.message)); }}
        onDismiss={() => { setError(''); window.dure.chat.dismissQuestion(workspace.id, view.question!.requestId).catch((e: Error) => setError(e.message)); }}
      />
    );
  } else if (status === 'waiting_user') {
    composer = (
      <div className="permit">
        <div className="permit-title">{permission ? '에이전트가 이것을 실행해도 되는지 묻습니다' : '에이전트가 터미널에서 답을 기다립니다'}</div>
        {permission && (
          <>
            <div className="permit-what">{permission.summary}</div>
            {permission.input && permission.input !== permission.summary && <pre className="raw">{cut(permission.input)}</pre>}
          </>
        )}
        <div className="permit-actions">
          {permission?.canAnswer && <button className="btn primary" onClick={() => answer('allow')}>허용</button>}
          {permission?.canAnswer && <button className="btn" onClick={() => answer('deny')}>거부</button>}
          {permission?.canAlways && <button className="btn" onClick={() => answer('always')} title="허용하고, 이번 대화 동안 같은 것은 묻지 않습니다">허용하고 이번 대화에서는 묻지 않기</button>}
          {permission?.canAlways && permission.alwaysRule && <span className="permit-hint">묻지 않게 될 것: <code>{permission.alwaysRule}</code></span>}
          {(permission?.more ?? 0) > 0 && <span className="permit-hint">이 뒤에 {permission!.more}건이 더 기다립니다</span>}
          {permission?.canAnswer && view.engine === 'terminal' && !showPeek && <button className="btn" onClick={() => setPeek({ why: 'manual' })} title={'"다시 묻지 않기" 같은 다른 선택지를 직접 고릅니다'}>다른 선택지</button>}
          {!permission?.canAnswer && view.engine === 'terminal' && <span className="permit-hint">위 창에서 ↑↓ 로 고르고 Enter 를 누르세요.</span>}
        </div>
      </div>
    );
  } else if (!view.canSend) {
    composer = (
      <div className="composer-off">
        <span>{status === 'starting' ? '에이전트가 시작하는 중입니다. 오래 걸리면 터미널에서 무엇을 묻고 있는지 확인하세요.' : '터미널에서 확인이 필요합니다.'}</span>
        {onShowTerminal && <button className="btn" onClick={onShowTerminal}>터미널로</button>}
      </div>
    );
  } else {
    composer = (
      <div className="composer">
        {menu.length > 0 && (
          <div className="slash-menu" role="listbox">
            {menu.map((c, i) => (
              <button key={c.name} role="option" aria-selected={i === menuAt} className={`slash-item${i === menuAt ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setMenuAt(i)}>
                <span className="slash-name">/{c.name}{c.argumentHint && <span className="slash-arg"> {c.argumentHint}</span>}</span>
                <span className="slash-desc">{c.description}</span>
              </button>
            ))}
            <div className="slash-foot">↑↓ 고르기 · Tab 넣기 · Esc 닫기</div>
          </div>
        )}
        {mention && (
          <div className="slash-menu" role="listbox">
            {mention.items.map((m, i) => (
              <button key={m.label} role="option" aria-selected={i === menuAt} className={`slash-item${i === menuAt ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickMention(m); }} onMouseEnter={() => setMenuAt(i)}>
                <span className="slash-name">{m.label}</span>
                <span className="slash-desc">{m.hint}</span>
              </button>
            ))}
            <div className="slash-foot">↑↓ 고르기 · Tab 넣기 · Esc 닫기 · 에이전트가 그 사람에게 물어봅니다</div>
          </div>
        )}
        {attach && (
          <button
            className="btn attach" title="기획서 파일을 고릅니다. 내용이 입력창에 들어가고, 보내기를 눌러야 전달됩니다"
            onClick={() => { setError(''); attach().then((text) => { if (text) { setDraft((d) => (d.trim() ? `${d}\n\n${text}` : text)); input.current?.focus(); } }).catch((e: Error) => setError(e.message)); }}
          >기획서 파일</button>
        )}
        <textarea
          ref={input}
          value={draft}
          rows={Math.min(8, Math.max(1, draft.split('\n').length))}
          placeholder={status === 'working' ? '작업 중에 보내면 에이전트가 다음 단계에서 읽습니다' : `에이전트에게 시킬 일을 쓰세요${commands.length ? ' · / 로 명령 고르기' : ''}${mentionable.length ? ' · @ 로 사람 고르기' : ''}`}
          onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKey}
        />
        <button className="btn primary" disabled={!draft.trim() || sending} onClick={() => void send()} title="보내기 (Enter) · 줄바꿈은 Shift+Enter">보내기</button>
      </div>
    );
  }

  return (
    <div className="chat">
      {working && (
        <div className="chat-status">
          <span className="spin" />
          <span>{elapsed(now - view.workingSince!)} 작업 중</span>
        </div>
      )}
      <div className="chat-main">
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-col">
          {view.hidden > 0 && <div className="chat-notice"><span>앞쪽 {view.hidden}개 항목은 줄였습니다. 전부 보려면 터미널 보기를 쓰세요.</span></div>}
          {loaded && !view.available && <div className="chat-notice"><span>{view.reason}</span></div>}
          {loaded && view.available && entries.length === 0 && view.queued.length === 0 && !view.streaming && (
            <div className="chat-blank">
              <div className="chat-blank-title">아직 대화가 없습니다</div>
              {blank ? <div>{blank}</div> : (
                <>
                  <div>{hasAgent ? '아래에 시킬 일을 쓰면 여기에 대화가 쌓입니다.' : '에이전트를 시작하면 여기에 대화가 쌓입니다.'}</div>
                  <div>에이전트가 한 일은 한 줄로 접혀 보이고, 누르면 실행한 명령과 출력이 그대로 펼쳐집니다.</div>
                </>
              )}
            </div>
          )}
          {entries.map((e) => <EntryView key={e.id} entry={e} workspaceId={workspace.id} workspaces={workspaces} conversation={conversation} />)}
          {view.streaming && (
            <div className="say streaming"><Markdown text={view.streaming} /><span className="typing" aria-hidden /></div>
          )}
          {view.queued.map((q) => (
            <div key={q.id} className="bubble-row queued">
              <div className="bubble">{q.text}</div>
              <div className="bubble-note">{status === 'working' ? '에이전트가 다음 단계에서 읽습니다' : '아직 전달되지 않았습니다. 다음에 보내는 글과 함께 전달됩니다'}</div>
            </div>
          ))}
        </div>
      </div>
      {behind && <button className="chat-jump" onClick={toBottom}>새 내용 ↓</button>}
      </div>
      <div className="chat-foot">
        <div className="chat-col">
          {error && <div className="error chat-error">{error}</div>}
          {banner}
          {showPeek && agentTerminalId && (
            <div className="peek">
              <div className="peek-head">
                <span className="peek-title">{peekTitle}</span>
                <span className="peek-hint">이 창을 누르고 ↑↓ 이동 · Enter 선택 · Esc 취소</span>
                {onShowTerminal && <button className="btn ghost" onClick={onShowTerminal}>크게 보기</button>}
                {!mustPeek && <button className="btn ghost" onClick={() => setPeek(null)}>닫기</button>}
              </div>
              <div className="peek-term"><TerminalPane key={agentTerminalId} terminalId={agentTerminalId} /></div>
            </div>
          )}
          {composer}
        </div>
      </div>
    </div>
  );
}

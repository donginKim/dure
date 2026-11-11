import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatItem, ChatStep, ChatView, Message, Workspace } from '@shared/types';
import { elapsed, mergeEntries, stepsLabel, stepsRunning, type Entry, type PeerEntry } from '../chatView';
import { clock, deliveryNote, workspaceName } from '../conversationView';
import { Attachment, type ConversationData } from './ConversationPanel';
import { Markdown } from './Markdown';

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
    case 'notice': return <div className="chat-notice"><span>{entry.text}</span></div>;
    case 'peer': return <PeerCard entry={entry} workspaces={workspaces} conversation={conversation} />;
  }
});

const EMPTY: ChatView = { available: true, reason: null, items: [], hidden: 0, workingSince: null, pendingPermission: null, canSend: false };

/**
 * 채팅 보기. 에이전트는 터미널에서 돌고, 이 화면은 그 대화 기록을 읽어 보여준다.
 * 입력창의 글과 승인 답은 에이전트의 터미널에 써 넣는다.
 */
export function ChatPane({ workspace, workspaces, conversation, hasAgent, onShowTerminal, onStartAgent }: {
  workspace: Workspace; workspaces: Workspace[]; conversation: ConversationData; hasAgent: boolean;
  onShowTerminal: () => void; onStartAgent: () => void;
}) {
  const [view, setView] = useState<ChatView>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [behind, setBehind] = useState(false);
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

  const messages = useMemo(() => Object.values(conversation.messages).flat(), [conversation.messages]);
  const entries = useMemo(() => mergeEntries(view.items, messages, workspace.id), [view.items, messages, workspace.id]);

  // 맨 아래를 보고 있었으면 새 내용을 따라간다. 위를 읽는 중이면 그대로 두고 알려만 준다.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight - el.scrollTop - el.clientHeight >= 60) setBehind(true);
    else stick.current = true; // 내용이 다 보이면 맨 아래에 있는 것이다
  }, [entries, view.pendingPermission]);

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
    // 한글 조합 중의 Enter 는 글자를 확정하는 것이지 보내기가 아니다.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const answer = (a: 'allow' | 'deny'): void => {
    setError('');
    window.dure.chat.answerPermission(workspace.id, a).catch((e: Error) => setError(e.message));
  };

  if (loaded && !view.available) {
    return (
      <div className="chat">
        <div className="chat-empty">
          <div>{view.reason}</div>
          <button className="btn" onClick={onShowTerminal}>터미널 보기로</button>
        </div>
      </div>
    );
  }

  const status = workspace.status;
  const permission = status === 'waiting_user' ? view.pendingPermission : null;
  const working = status === 'working' && view.workingSince !== null;

  let composer;
  if (!hasAgent) {
    composer = (
      <div className="composer-off">
        <span>에이전트가 꺼져 있습니다.</span>
        <button className="btn primary" onClick={onStartAgent}>에이전트 시작</button>
      </div>
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
          <button className="btn" onClick={onShowTerminal}>터미널에서 보기</button>
          {permission && !permission.canAnswer && <span className="permit-hint">선택지가 여럿이거나 터미널에서 이미 조작했습니다. 터미널에서 답하세요.</span>}
          {permission?.canAnswer && <span className="permit-hint">"다시 묻지 않기" 같은 다른 선택지는 터미널에 있습니다.</span>}
        </div>
      </div>
    );
  } else if (!view.canSend) {
    composer = (
      <div className="composer-off">
        <span>{status === 'starting' ? '에이전트가 시작하는 중입니다. 오래 걸리면 터미널에서 무엇을 묻고 있는지 확인하세요.' : '터미널에서 확인이 필요합니다.'}</span>
        <button className="btn" onClick={onShowTerminal}>터미널로</button>
      </div>
    );
  } else {
    composer = (
      <div className="composer">
        <textarea
          ref={input}
          value={draft}
          rows={Math.min(8, Math.max(1, draft.split('\n').length))}
          placeholder={working ? '작업 중에 보내면 다음 차례에 읽습니다' : '에이전트에게 시킬 일을 쓰세요'}
          onChange={(e) => setDraft(e.target.value)}
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
          {loaded && entries.length === 0 && (
            <div className="chat-blank">
              <div className="chat-blank-title">아직 대화가 없습니다</div>
              <div>{hasAgent ? '아래에 시킬 일을 쓰면 여기에 대화가 쌓입니다.' : '에이전트를 시작하면 여기에 대화가 쌓입니다.'}</div>
              <div>에이전트가 한 일은 한 줄로 접혀 보이고, 누르면 실행한 명령과 출력이 그대로 펼쳐집니다.</div>
            </div>
          )}
          {entries.map((e) => <EntryView key={e.id} entry={e} workspaceId={workspace.id} workspaces={workspaces} conversation={conversation} />)}
        </div>
      </div>
      {behind && <button className="chat-jump" onClick={toBottom}>새 내용 ↓</button>}
      </div>
      <div className="chat-foot">
        <div className="chat-col">
          {error && <div className="error chat-error">{error}</div>}
          {composer}
        </div>
      </div>
    </div>
  );
}

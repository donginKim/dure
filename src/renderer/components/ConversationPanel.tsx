import { useState } from 'react';
import type { DeliveryInfo } from '@shared/ipc';
import type { Artifact, Message, ProjectFlow, Thread, Workspace } from '@shared/types';
import { clock, deliveryNote, senderName, threadNotice, workspaceName } from '../conversationView';

export interface ConversationData {
  threads: Thread[];
  messages: Record<string, Message[]>;
  artifacts: Artifact[];
  flow: ProjectFlow;
  delivery: Record<string, DeliveryInfo>;
}

const KIND_LABEL: Record<Artifact['kind'], string> = { result: '결과', decision: '결정', 'api-spec': 'API 형식', note: '메모' };

function Attachment({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(false);
  if (artifact.path) {
    return <div className="att"><span className="att-kind">{KIND_LABEL[artifact.kind]}</span>{artifact.title}<code className="att-path">{artifact.path}</code></div>;
  }
  return (
    <div className="att">
      <button className="att-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="att-kind">{KIND_LABEL[artifact.kind]}</span>{artifact.title}<span className="caret">{open ? '접기' : '펼치기'}</span>
      </button>
      {open && <pre className="att-body">{artifact.body}</pre>}
    </div>
  );
}

function MessageRow({ m, workspaces, artifacts, info }: { m: Message; workspaces: Workspace[]; artifacts: Artifact[]; info?: DeliveryInfo }) {
  const fromUser = m.from.kind === 'user';
  const waiting = m.deliveredAt === null && !m.failed;
  const note = info ? deliveryNote(info) : undefined;
  return (
    <div className={`msg${fromUser ? ' from-user' : ''}${m.from.kind === 'system' ? ' from-system' : ''}`}>
      <div className="msg-head">
        <span className="who">{senderName(m, workspaces)}</span>
        <span className="arrow">→</span>
        <span className="to">{workspaceName(m.toWorkspaceId, workspaces)}</span>
        <span className="at">{clock(m.createdAt)}</span>
      </div>
      <div className="msg-body">{m.body}</div>
      {m.artifactIds.map((id, i) => {
        const a = artifacts.find((x) => x.id === id);
        return a ? <Attachment key={`${id}-${i}`} artifact={a} /> : null;
      })}
      {waiting && (
        <div className={`msg-wait${note?.attention ? ' attention' : ''}`}>
          전달 대기{note?.text ? ` · ${note.text}` : ''}
        </div>
      )}
      {m.failed && <div className="msg-wait attention">전달 못 함 · 받는 워크스페이스가 지워졌습니다</div>}
    </div>
  );
}

function ThreadCard({ thread, data, workspaces, projectId, open, onToggle }: {
  thread: Thread; data: ConversationData; workspaces: Workspace[]; projectId: string; open: boolean; onToggle: () => void;
}) {
  const msgs = data.messages[thread.id] ?? [];
  const last = msgs[msgs.length - 1];
  // 기본 받는 쪽: 마지막 메시지를 보낸 워크스페이스 (사용자가 보낸 것이면 그 받는 쪽)
  const lastPeer = last ? (last.from.kind === 'workspace' ? last.from.workspaceId : last.toWorkspaceId) : '';
  // 그 워크스페이스가 지워졌으면 남아 있는 첫 워크스페이스로 한다 (없는 id 로 보내면 실패한다).
  const defaultTo = workspaces.some((w) => w.id === lastPeer) ? lastPeer : (workspaces[0]?.id ?? '');
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const target = to && workspaces.some((w) => w.id === to) ? to : defaultTo;
  const notice = threadNotice(thread, data.flow);
  const capped = thread.capped || data.flow.capped;
  const people = [...new Set(msgs.flatMap((m) => [senderName(m, workspaces), workspaceName(m.toWorkspaceId, workspaces)]))];
  const run = (p: Promise<unknown>): void => { p.catch((e: Error) => setError(e.message)); };

  const send = async (): Promise<void> => {
    if (!body.trim() || !target) return;
    try {
      await window.dure.messages.send({ projectId, toWorkspaceId: target, body, threadId: thread.id });
      setBody('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className={`thread${open ? ' open' : ''}${notice ? ' stopped' : ''}`}>
      <button className="thread-head" aria-expanded={open} onClick={onToggle}>
        <span className="thread-title">{thread.title}</span>
        <span className="thread-meta">{people.join(', ')} · {msgs.length}건{last ? ` · ${clock(last.createdAt)}` : ''}</span>
      </button>
      {open && (
        <div className="thread-body">
          {notice && (
            <div className="thread-notice">
              <span className="grow">{notice}</span>
              {capped && <button className="btn accent" onClick={() => run(window.dure.messages.resume(projectId))}>계속</button>}
            </div>
          )}
          {msgs.map((m) => <MessageRow key={m.id} m={m} workspaces={workspaces} artifacts={data.artifacts} info={data.delivery[m.toWorkspaceId]} />)}
          {error && <div className="error" style={{ margin: '6px 0 0' }}>{error}</div>}
          <form className="thread-reply" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <select value={target} aria-label="받는 워크스페이스" onChange={(e) => setTo(e.target.value)}>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} 에게</option>)}
            </select>
            <input type="text" value={body} aria-label="메시지" placeholder="대화에 끼어들기" onChange={(e) => setBody(e.target.value)} />
            <button
              type="button"
              className="btn ghost"
              title={thread.paused ? '이 대화의 전달을 다시 시작' : '이 대화의 전달만 멈춤 (에이전트가 하던 일은 계속)'}
              onClick={() => run(window.dure.messages.pauseThread(thread.id, !thread.paused))}
            >{thread.paused ? '재개' : '멈춤'}</button>
          </form>
        </div>
      )}
    </div>
  );
}

/** 대화 스레드 목록. 워크스페이스 패널과 프로젝트 화면이 같이 쓴다. */
export function ConversationList({ projectId, threads, data, workspaces, empty }: {
  projectId: string; threads: Thread[]; data: ConversationData; workspaces: Workspace[]; empty: string;
}) {
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  // 아무것도 고르지 않았으면 가장 최근 스레드를 펼친다. 사용자가 접었으면(null) 그대로 둔다.
  const current = openId === undefined ? threads[0]?.id : openId;
  if (threads.length === 0) return <div className="muted conv-empty">{empty}</div>;
  return (
    <div className="threads">
      {threads.map((t) => (
        <ThreadCard
          key={t.id}
          thread={t}
          data={data}
          workspaces={workspaces}
          projectId={projectId}
          open={current === t.id}
          onToggle={() => setOpenId(current === t.id ? null : t.id)}
        />
      ))}
    </div>
  );
}

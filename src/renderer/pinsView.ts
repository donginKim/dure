import type { Pin, PinInput, Workspace } from '@shared/types';
import type { Entry, PeerEntry } from './chatView';
import { workspaceName } from './conversationView';

/** 에이전트끼리 주고받은 메시지 카드의 머리글: 누가 누구에게 보냈나. */
export function peerTitle(e: PeerEntry, workspaces: Workspace[]): string {
  const m = e.message;
  if (e.direction === 'sent') return `${workspaceName(m.toWorkspaceId, workspaces)}에게 보냄`;
  if (m.from.kind === 'user') return '내가 대화에 남긴 말';
  if (m.from.kind === 'system') return '두레 알림';
  return `${workspaceName(m.from.workspaceId, workspaces)}가 보냄`;
}

/**
 * 핀이 글을 가리키는 id. 두레가 전달한 글은 짝이 되는 메시지를 찾으면 카드로 바뀌어 그려지는데 (id 가 달라진다),
 * 찾기 전후로 같은 글을 가리키도록 원래 대화 항목의 id 를 쓴다.
 */
export function pinKey(entry: Entry): string {
  return (entry.kind === 'peer' && entry.anchorId) || entry.id;
}

/**
 * 이 글에 핀을 꽂을 때 담을 것. 꽂을 수 없는 글이면 null.
 * 접힌 작업 줄(steps)과 안내 줄(notice)은 다시 볼 내용이 아니라서 꽂지 않는다.
 */
export function pinInput(entry: Entry, workspaceId: string, workspaces: Workspace[]): PinInput | null {
  const make = (kind: PinInput['kind'], source: string, body: string): PinInput | null =>
    (body.trim() ? { workspaceId, itemId: pinKey(entry), kind, source, body } : null);
  switch (entry.kind) {
    case 'user': return make('user', '나', entry.text);
    case 'assistant': return make('assistant', '에이전트', entry.text);
    case 'dure': return make('dure', '두레가 전달', [entry.title, entry.text].filter((t) => t.trim()).join('\n\n'));
    case 'output': return make('output', '명령의 출력', entry.text);
    case 'peer': return make('peer', peerTitle(entry, workspaces), entry.message.body);
    default: return null;
  }
}

/** 목록에 보일 "누가 쓴 글인지". */
export function pinSourceLabel(pin: Pin): string {
  return pin.source || { user: '나', assistant: '에이전트', dure: '두레가 전달', output: '명령의 출력', peer: '메시지' }[pin.kind];
}

/** 그 핀의 글이 지금 화면에 있는가. 없으면 null (지난 대화이거나 앞쪽이 줄어든 것). */
export function findEntry(entries: Entry[], pin: Pin): Entry | null {
  return entries.find((e) => pinKey(e) === pin.itemId) ?? null;
}

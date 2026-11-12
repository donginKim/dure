/**
 * 다른 사람의 두레에 있는 워크스페이스를 가리키는 id. 메시지의 보낸 쪽·받는 쪽 칸에 워크스페이스 id 대신 들어간다.
 * 내 워크스페이스의 id (UUID) 와 겹치지 않는다.
 */
const PREFIX = 'remote:';
export const remoteRef = (peerId: string, workspaceId: string): string => `${PREFIX}${peerId}:${workspaceId}`;
export const isRemoteRef = (id: string): boolean => id.startsWith(PREFIX);
export function parseRemoteRef(id: string): { peerId: string; workspaceId: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.indexOf(':');
  return at > 0 && at < rest.length - 1 ? { peerId: rest.slice(0, at), workspaceId: rest.slice(at + 1) } : null;
}
/** 에이전트와 화면에 보이는 이름: 워크스페이스 이름@사람 이름 */
export const remoteLabel = (workspaceName: string, peerName: string): string => `${workspaceName}@${peerName}`;

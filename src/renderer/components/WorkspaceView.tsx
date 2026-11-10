import type { Workspace } from '@shared/types';

// 터미널 화면은 Task 12 에서 채운다.
export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  return <div className="empty">{workspace.name}</div>;
}

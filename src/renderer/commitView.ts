import type { ChangedFile, CommitState } from '@shared/types';

const STATUS: Record<ChangedFile['status'], string> = { added: '추가', modified: '수정', deleted: '삭제', renamed: '이름 바뀜', untracked: '새 파일' };

export function statusLabel(status: ChangedFile['status']): string {
  return STATUS[status];
}

export function fileLabel(f: ChangedFile): string {
  return f.from ? `${f.from} → ${f.path}` : f.path;
}

/** 커밋할 때 git 에 넘길 경로. 이름이 바뀐 파일은 옛 경로도 함께 넘겨야 삭제가 같이 커밋된다. */
export function pathsToCommit(files: ChangedFile[], checked: Set<string>): string[] {
  return files.filter((f) => checked.has(f.path)).flatMap((f) => (f.from ? [f.path, f.from] : [f.path]));
}

/** push 버튼 옆에 보일 한 줄: 어디로 나가는지, 누를 수 있는지. */
export function pushHint(s: CommitState): { text: string; canPush: boolean } {
  if (!s.remoteUrl) return { text: '원격 저장소(origin)가 없어 push 할 수 없습니다.', canPush: false };
  if (s.ahead === 0) return { text: 'push 할 커밋이 없습니다.', canPush: false };
  const what = s.ahead === null ? '처음 push 하는 브랜치입니다' : `커밋 ${s.ahead}개`;
  return { text: `${s.branch} → ${s.remoteUrl} · ${what}`, canPush: true };
}

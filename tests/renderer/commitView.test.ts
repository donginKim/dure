import { fileLabel, pushHint, statusLabel } from '../../src/renderer/commitView';
import type { CommitState } from '@shared/types';

const state = (over: Partial<CommitState>): CommitState => ({ branch: 'dure/프론트', files: [], draft: null, remoteUrl: null, ahead: null, ...over });

test('statusLabel', () => {
  expect((['added', 'modified', 'deleted', 'renamed', 'untracked'] as const).map(statusLabel)).toEqual(['추가', '수정', '삭제', '이름 바뀜', '새 파일']);
});

test('fileLabel: 이름 바뀜은 옛 경로 → 새 경로', () => {
  expect(fileLabel({ path: 'new.txt', status: 'renamed', from: 'old.txt', added: null, removed: null })).toBe('old.txt → new.txt');
  expect(fileLabel({ path: 'a b.txt', status: 'modified', added: 1, removed: 0 })).toBe('a b.txt');
});

test('pushHint: 원격 없음', () => {
  expect(pushHint(state({}))).toEqual({ text: '원격 저장소(origin)가 없어 push 할 수 없습니다.', canPush: false });
});

test('pushHint: 보낼 커밋 없음', () => {
  expect(pushHint(state({ remoteUrl: 'git@host:team/repo.git', ahead: 0 }))).toEqual({ text: 'push 할 커밋이 없습니다.', canPush: false });
});

test('pushHint: 보낼 커밋 있음', () => {
  expect(pushHint(state({ remoteUrl: 'git@host:team/repo.git', ahead: 2 })))
    .toEqual({ text: 'dure/프론트 → git@host:team/repo.git · 커밋 2개', canPush: true });
});

test('pushHint: 처음 push 하는 브랜치', () => {
  expect(pushHint(state({ remoteUrl: 'git@host:team/repo.git', ahead: null })))
    .toEqual({ text: 'dure/프론트 → git@host:team/repo.git · 처음 push 하는 브랜치입니다', canPush: true });
});

import { fileLabel, pushHint, statusLabel } from '../../src/renderer/commitView';
import type { CommitState } from '@shared/types';

const state = (over: Partial<CommitState>): CommitState => ({ branch: 'dure/프론트', files: [], draft: null, remoteUrl: null, ahead: null, merging: false, ...over });

test('statusLabel', () => {
  expect((['added', 'modified', 'deleted', 'renamed', 'untracked'] as const).map(statusLabel)).toEqual(['추가', '수정', '삭제', '이름 바뀜', '새 파일']);
});

test('fileLabel: 이름 바뀜은 옛 경로 → 새 경로', () => {
  expect(fileLabel({ path: 'new.txt', status: 'renamed', from: 'old.txt', added: null, removed: null })).toBe('old.txt → new.txt');
  expect(fileLabel({ path: 'a b.txt', status: 'modified', added: 1, removed: 0 })).toBe('a b.txt');
});

test('pushHint: 브랜치가 아닌 상태', () => {
  expect(pushHint(state({ branch: 'HEAD', remoteUrl: 'x', ahead: 1 }))).toEqual({ text: '브랜치가 아닌 상태(분리된 HEAD)라 push 할 수 없습니다.', canPush: false });
});

test('rememberEdit / recallEdit: 고치던 메시지는 창을 닫아도 남고, 커밋하면 지워진다', async () => {
  const { rememberEdit, recallEdit, forgetEdit } = await import('../../src/renderer/commitView');
  expect(recallEdit('w1')).toBeUndefined();
  rememberEdit('w1', { base: '초안', message: '초안을 고친 글', draftAt: 5 });
  expect(recallEdit('w1')).toEqual({ base: '초안', message: '초안을 고친 글', draftAt: 5 });
  expect(recallEdit('w2')).toBeUndefined(); // 다른 워크스페이스에는 보이지 않는다
  forgetEdit('w1');
  expect(recallEdit('w1')).toBeUndefined();
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

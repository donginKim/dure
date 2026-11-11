/** 계획안에서 "아직 없는, 승인하면 만들 저장소" 를 가리키는 저장소 id. 진짜 저장소 id (UUID) 와 겹치지 않는다. */
const PREFIX = 'new:';
export const newRepoId = (name: string): string => `${PREFIX}${name}`;
export const isNewRepoId = (id: string): boolean => id.startsWith(PREFIX);
export const newRepoName = (id: string): string => id.slice(PREFIX.length);
/** 새 저장소 이름으로 쓸 수 있는 글자: 폴더 이름이 되므로 영문, 숫자, . _ - 만 받는다. */
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

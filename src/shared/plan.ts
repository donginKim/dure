/** 계획안에서 "아직 없는, 승인하면 만들 저장소" 를 가리키는 저장소 id. 진짜 저장소 id (UUID) 와 겹치지 않는다. */
const PREFIX = 'new:';
export const newRepoId = (name: string): string => `${PREFIX}${name}`;
export const isNewRepoId = (id: string): boolean => id.startsWith(PREFIX);
export const newRepoName = (id: string): string => id.slice(PREFIX.length);
/** 새 저장소 이름으로 쓸 수 있는 글자: 폴더 이름이 되므로 영문, 숫자, . _ - 만 받는다. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
/** 화면과 코어가 같은 규칙으로 본다. 끝의 점은 일부 파일 시스템에서 사라지므로 받지 않는다. */
export const validRepoName = (name: string): boolean => REPO_NAME.test(name) && !name.endsWith('.');

/** 계획안에서 "PC 에 이미 있지만 아직 이 프로젝트에 등록하지 않은 저장소 폴더" 를 가리키는 저장소 id. 승인하면 그 폴더를 등록한다. */
const FOLDER = 'path:';
export const folderRepoId = (path: string): string => `${FOLDER}${path}`;
export const isFolderRepoId = (id: string): boolean => id.startsWith(FOLDER);
export const folderRepoPath = (id: string): string => id.slice(FOLDER.length);

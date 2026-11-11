import { execFile } from 'node:child_process';
import type { ChangedFile, CommitResult } from '@shared/types';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface Git {
  /** git 을 인자 그대로 실행하고 표준 출력을 돌려준다. */
  raw(args: string[]): Promise<string>;
  isGitRepo(path: string): Promise<boolean>;
  listBranches(repoPath: string): Promise<string[]>;
  currentBranch(repoPath: string): Promise<string>;
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  deleteBranch(repoPath: string, branch: string): Promise<void>;
  uncommittedCount(path: string): Promise<number>;
  /** 작업 폴더에서 바뀐 파일 (스테이징 여부와 무관, 추적 안 된 파일 포함) */
  changedFiles(path: string): Promise<ChangedFile[]>;
  /** 고른 파일만 커밋한다. 사용자의 git 설정(hook, 서명)을 그대로 따른다 */
  commitFiles(o: { path: string; files: string[]; message: string }): Promise<CommitResult>;
  /** 원격 주소. 그 원격이 없으면 null */
  remoteUrl(path: string, remote?: string): Promise<string | null>;
  /** origin/<branch> 보다 앞선 커밋 수. 원격에 그 브랜치가 없으면 null */
  aheadCount(path: string, branch: string): Promise<number | null>;
  /** 브랜치를 origin 으로 보낸다. 강제로 밀지 않는다. git 이 낸 글을 돌려준다 */
  push(o: { path: string; branch: string }): Promise<string>;
  addWorktree(o: { repoPath: string; worktreePath: string; branch: string; baseBranch: string }): Promise<void>;
  removeWorktree(o: { repoPath: string; worktreePath: string }): Promise<void>;
}

interface Failure { spawnFailed: boolean; detail: string }

/**
 * 주어진 환경으로 git 을 실행하는 함수 묶음을 만든다.
 * 앱은 로그인 셸 환경을 넘긴다: Finder 에서 띄운 앱의 빈약한 PATH 로는 git-lfs 같은 보조 프로그램을 못 찾는다.
 */
export function createGit(env?: Record<string, string>): Git {
  // 셸을 거치지 않고 인자 배열로 실행한다. 경로에 공백과 한글이 있어도 안전하다.
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const detail = (stderr || err.message).trim();
        const failure: Failure = {
          // 실행 파일이 없거나(ENOENT), 개발자 도구가 없어 git 자체가 못 도는 경우(xcrun)
          spawnFailed: (err as NodeJS.ErrnoException).code === 'ENOENT' || /xcrun: error|xcode-select/i.test(detail),
          detail,
        };
        reject(failure);
      });
    });

  // git push 처럼 진행 상황을 표준 오류로 내는 명령의 출력을 모두 받는다.
  const runBoth = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
        const all = `${stdout}${stderr}`.trim();
        if (!err) return resolve(all);
        reject(new GitError(`git ${args[0] === '-C' ? args[2] : args[0]} 실패: ${all || err.message}`, all || err.message));
      });
    });

  const raw = async (args: string[]): Promise<string> => {
    try {
      return await run(args);
    } catch (f) {
      const { spawnFailed, detail } = f as Failure;
      if (spawnFailed) throw new GitError(`git 을 실행할 수 없습니다: ${detail}`, detail);
      throw new GitError(`git ${args[0] === '-C' ? args[2] : args[0]} 실패: ${detail}`, detail);
    }
  };

  const git: Git = {
    raw,

    async isGitRepo(path) {
      try {
        return (await run(['-C', path, 'rev-parse', '--is-inside-work-tree'])).trim() === 'true';
      } catch (f) {
        const { spawnFailed, detail } = f as Failure;
        // "저장소가 아님" 과 "git 을 못 돌림" 을 섞으면 멀쩡한 저장소를 거절하게 된다.
        if (spawnFailed) throw new GitError(`git 을 실행할 수 없습니다: ${detail}`, detail);
        return false;
      }
    },

    async listBranches(repoPath) {
      const out = await raw(['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
      return out.split('\n').filter(Boolean);
    },

    async currentBranch(repoPath) {
      return (await raw(['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    },

    async branchExists(repoPath, branch) {
      try {
        await run(['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        return true;
      } catch {
        return false;
      }
    },

    async deleteBranch(repoPath, branch) {
      await raw(['-C', repoPath, 'branch', '-D', branch]);
    },

    async uncommittedCount(path) {
      return (await raw(['-C', path, 'status', '--porcelain'])).split('\n').filter(Boolean).length;
    },

    async changedFiles(path) {
      // -z: 이름을 따옴표로 감싸거나 이스케이프하지 않고 NUL 로 끊어 준다. 공백·한글·따옴표가 든 이름이 깨지지 않는다.
      const out = await raw(['-C', path, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const parts = out.split('\0');
      const files: ChangedFile[] = [];
      for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (entry.length < 4) continue;
        const xy = entry.slice(0, 2);
        const file: ChangedFile = { path: entry.slice(3), status: 'modified', added: null, removed: null };
        if (xy === '??') file.status = 'untracked';
        else if (xy.includes('R') || xy.includes('C')) { file.status = 'renamed'; file.from = parts[++i]; } // 옛 경로가 다음 칸에 온다
        else if (xy.includes('D')) file.status = 'deleted';
        else if (xy.includes('A')) file.status = 'added';
        files.push(file);
      }
      // 줄 수. 커밋이 하나도 없는 저장소에서는 HEAD 가 없어 실패하므로 그때는 비워 둔다.
      let stat = '';
      try { stat = await run(['-C', path, 'diff', '--numstat', '-z', 'HEAD']); } catch { /* 줄 수 없이 보여준다 */ }
      const cells = stat.split('\0');
      for (let i = 0; i < cells.length; i++) {
        const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(cells[i]);
        if (!m) continue;
        // 이름이 바뀐 항목은 경로 칸이 비고 옛 경로와 새 경로가 다음 두 칸에 온다.
        const target = m[3] === '' ? cells[(i += 2)] : m[3];
        const file = files.find((f) => f.path === target);
        if (file && m[1] !== '-') { file.added = Number(m[1]); file.removed = Number(m[2]); }
      }
      return files;
    },

    async commitFiles(o) {
      if (o.files.length === 0) throw new Error('커밋할 파일을 고르세요.');
      const message = o.message.trim();
      if (!message) throw new Error('커밋 메시지를 입력하세요.');
      // 경로 앞에는 항상 -- 를 두고, 메시지는 한 인자 안에 넣는다: 어느 쪽도 옵션으로 읽히지 않는다.
      await raw(['-C', o.path, 'add', '-A', '--', ...o.files]);
      await runBoth(['-C', o.path, 'commit', `--message=${message}`, '--', ...o.files]);
      return {
        hash: (await raw(['-C', o.path, 'rev-parse', '--short', 'HEAD'])).trim(),
        subject: (await raw(['-C', o.path, 'log', '-1', '--format=%s'])).trim(),
      };
    },

    async remoteUrl(path, remote = 'origin') {
      try {
        return (await run(['-C', path, 'remote', 'get-url', remote])).trim() || null;
      } catch {
        return null;
      }
    },

    async aheadCount(path, branch) {
      try {
        await run(['-C', path, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
      } catch {
        return null;
      }
      return Number((await raw(['-C', path, 'rev-list', '--count', `origin/${branch}..${branch}`])).trim());
    },

    async push(o) {
      return runBoth(['-C', o.path, 'push', '-u', 'origin', o.branch]);
    },

    async addWorktree(o) {
      await raw(['-C', o.repoPath, 'worktree', 'add', '-b', o.branch, o.worktreePath, o.baseBranch]);
    },

    /** worktree 를 지운다. 폴더가 이미 없어도 git 쪽 기록을 정리한다. 브랜치는 남긴다. */
    async removeWorktree(o) {
      try {
        await raw(['-C', o.repoPath, 'worktree', 'remove', '--force', o.worktreePath]);
      } catch (e) {
        // 폴더가 사라진 worktree 는 remove 가 실패한다. prune 이 기록을 치운다.
        await raw(['-C', o.repoPath, 'worktree', 'prune']);
        const list = await raw(['-C', o.repoPath, 'worktree', 'list', '--porcelain']);
        if (list.split('\n').includes(`worktree ${o.worktreePath}`)) throw e;
        return;
      }
      await raw(['-C', o.repoPath, 'worktree', 'prune']);
    },
  };
  return git;
}

// 현재 프로세스 환경으로 실행하는 기본 묶음.
const defaultGit = createGit();
export const {
  isGitRepo, listBranches, currentBranch, branchExists, deleteBranch, uncommittedCount, addWorktree, removeWorktree,
  changedFiles, commitFiles, remoteUrl, aheadCount, push,
} = defaultGit;

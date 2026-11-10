import { execFile } from 'node:child_process';

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
export const { isGitRepo, listBranches, currentBranch, branchExists, deleteBranch, uncommittedCount, addWorktree, removeWorktree } = defaultGit;

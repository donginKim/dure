import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

// 셸을 거치지 않고 인자 배열로 실행한다. 경로에 공백과 한글이 있어도 안전하다.
function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message).trim();
        reject(new GitError(`git ${args[0] === '-C' ? args[2] : args[0]} 실패: ${detail}`, detail));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(['-C', path, 'rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await git(['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return out.split('\n').filter(Boolean);
}

export async function currentBranch(repoPath: string): Promise<string> {
  return (await git(['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function addWorktree(o: { repoPath: string; worktreePath: string; branch: string; baseBranch: string }): Promise<void> {
  await git(['-C', o.repoPath, 'worktree', 'add', '-b', o.branch, o.worktreePath, o.baseBranch]);
}

/** worktree 를 지운다. 폴더가 이미 없어도 git 쪽 기록을 정리한다. 브랜치는 남긴다. */
export async function removeWorktree(o: { repoPath: string; worktreePath: string }): Promise<void> {
  try {
    await git(['-C', o.repoPath, 'worktree', 'remove', '--force', o.worktreePath]);
  } catch (e) {
    // 폴더가 사라진 worktree 는 remove 가 실패한다. prune 이 기록을 치운다.
    await git(['-C', o.repoPath, 'worktree', 'prune']);
    const list = await git(['-C', o.repoPath, 'worktree', 'list', '--porcelain']);
    if (list.split('\n').includes(`worktree ${o.worktreePath}`)) throw e;
    return;
  }
  await git(['-C', o.repoPath, 'worktree', 'prune']);
}

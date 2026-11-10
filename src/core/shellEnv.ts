import { execFile } from 'node:child_process';

const MARKER = '__DURE_ENV_START__';

function fallback(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return env;
}

/**
 * 사용자의 로그인 셸 환경을 읽는다.
 * Finder 에서 띄운 앱은 PATH 가 빈약해 `claude`, `codex` 를 못 찾기 때문에 필요하다.
 * 실패하거나 시간이 넘으면 현재 프로세스 환경을 돌려준다.
 */
export function resolveShellEnv(shell = process.env.SHELL || '/bin/zsh', timeoutMs = 5000): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}'; env -0`],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const at = stdout?.indexOf(MARKER) ?? -1;
        if (err || at < 0) return resolve(fallback());
        const env: Record<string, string> = {};
        for (const entry of stdout.slice(at + MARKER.length).split('\0')) {
          const eq = entry.indexOf('=');
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
        if (!env.PATH) return resolve(fallback());
        // 테스트·개발 실행에서 물려받은 값이 에이전트로 새지 않게 한다.
        delete env.ELECTRON_RUN_AS_NODE;
        resolve(env);
      },
    );
  });
}

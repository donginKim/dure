import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardDecision, guardPromptReason } from '@core/agents/guard';

const W = '/work/tree';
const bash = (command: string) => guardDecision('Bash', { command }, W);

test.each([
  'rm victim.txt', 'rm -rf node_modules', 'sudo rm -rf /tmp/x', 'mkdir -p d && cd d && rm ../victim.txt', 'ls | xargs rm', '/bin/rm x',
  'rmdir empty', 'unlink a', 'shred -u secret', 'bash -c "rm -rf build"', 'find . -name "*.log" -delete', 'find . -name x -exec rm {} \\;',
  'git clean -fd', 'git rm old.ts', 'git -C ../repo clean -fdx', 'rsync -a --delete src/ dst/', 'trash old', 'dropdb shop',
  'python3 -c "import os; os.remove(\'a\')"', 'python -c "import shutil; shutil.rmtree(\'d\')"', 'node -e "require(\'fs\').rmSync(\'d\', {recursive: true})"',
])('파일을 지우는 명령은 묻는다: %s', (command) => {
  expect(bash(command).decision).toBe('ask');
});

test.each([
  'psql -c "DELETE FROM users WHERE id = 1"', 'psql -c "drop table users"', 'mysql -e "TRUNCATE TABLE orders"', 'sqlite3 a.db "delete from t"',
  'psql -c "ALTER TABLE t DROP COLUMN c"', 'mongosh --eval "db.users.deleteMany({})"', 'mongosh --eval "db.users.drop()"', 'redis-cli FLUSHALL', 'redis-cli del key',
  'docker system prune -af', 'docker rmi img', 'docker volume rm data', 'docker compose down -v', 'kubectl delete pod x', 'helm uninstall app',
  'terraform destroy -auto-approve', 'aws s3 rm s3://b/k', 'aws ec2 delete-volume --volume-id v', 'gh repo delete me/x', 'gcloud compute instances delete vm',
])('데이터를 지우는 명령은 묻는다: %s', (command) => {
  expect(bash(command).decision).toBe('ask');
});

test.each([
  'git reset --hard', 'git reset --hard HEAD~1', 'git checkout -- src/a.ts', 'git checkout .', 'git checkout -f main', 'git restore src/a.ts', 'git restore --staged --worktree a',
  'git branch -D feature', 'git branch --delete feature', 'git stash drop', 'git stash clear', 'git worktree remove ../w', 'git push --force', 'git push origin --delete b', 'git push -f',
  'git tag -d v1',
])('작업한 것을 날리는 git 명령은 묻는다: %s', (command) => {
  expect(bash(command).decision).toBe('ask');
});

test.each([
  'ls -la', 'npm test', 'node --test', 'curl -s https://example.com -o out.html', 'mkdir -p src && touch src/a.ts', 'cat a > b', 'mv a b', 'cp -r a b',
  'docker run --rm -it node', 'git status', 'git add -A', 'git diff', 'git checkout main', 'git checkout -b feature', 'git restore --staged a.ts', 'git reset HEAD a.ts',
  'git reset --soft HEAD~1', 'git stash', 'git stash pop', 'git branch feature', 'git log --oneline', 'git commit -m "clean up the form"', 'git push origin main',
  'sed -i "" s/a/b/ file', 'npx tsc --noEmit', 'echo "$PATH"', 'psql -c "select * from users"', 'kubectl get pods', 'docker ps', 'python3 script.py', 'grep -rn "format" src',
  'npm install', 'chmod +x run.sh', 'find . -name "*.ts"', 'terraform plan',
])('그 밖의 명령은 묻지 않는다: %s', (command) => {
  expect(bash(command)).toEqual({ decision: 'allow' });
});

test('묻는 이유를 알려 준다', () => {
  expect(bash('rm -rf build').reason).toContain('rm');
  expect(bash('git reset --hard').reason).toContain('git reset --hard');
  expect(bash('psql -c "delete from t"').reason).toMatch(/데이터/);
});

test('승인 창에 보일 이유: 지우는 일로 물은 것만 있고, 다른 까닭으로 뜬 승인 창에는 없다', () => {
  expect(guardPromptReason('Bash', 'rm hello.txt')).toBe('삭제만 묻기: 파일을 지우는 명령입니다 (rm)');
  expect(guardPromptReason('Bash', 'npm test')).toBeUndefined();
  expect(guardPromptReason('Bash', '  ')).toBeUndefined();
  expect(guardPromptReason('Write', '/etc/hosts')).toBeUndefined();
  expect(guardPromptReason('mcp__files__delete_file', '')).toContain('mcp__files__delete_file');
});

test('파일을 고치는 도구: 작업 폴더 안은 묻지 않고, 밖은 평소 승인에 맡긴다', () => {
  expect(guardDecision('Edit', { file_path: '/work/tree/src/a.ts' }, W)).toEqual({ decision: 'allow' });
  expect(guardDecision('Write', { file_path: '/work/tree/new.txt', content: 'x' }, W)).toEqual({ decision: 'allow' });
  expect(guardDecision('Write', { file_path: '/Users/me/.zshrc', content: 'x' }, W).decision).toBe('pass');
  expect(guardDecision('Edit', { file_path: '/work/tree/../other/a.ts' }, W).decision).toBe('pass');
  expect(guardDecision('Edit', { file_path: '/work/tree-other/a.ts' }, W).decision).toBe('pass');
  expect(guardDecision('Edit', {}, W).decision).toBe('pass');
  expect(guardDecision('NotebookEdit', { notebook_path: '/work/tree/n.ipynb', edit_mode: 'delete' }, W).decision).toBe('ask');
  expect(guardDecision('NotebookEdit', { notebook_path: '/work/tree/n.ipynb', edit_mode: 'replace' }, W)).toEqual({ decision: 'allow' });
});

test('읽기와 찾기, 웹 가져오기는 묻지 않는다', () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task']) expect(guardDecision(tool, {}, W)).toEqual({ decision: 'allow' });
});

test('사용자에게 묻는 도구와 두레의 도구는 건드리지 않는다 (평소대로)', () => {
  expect(guardDecision('AskUserQuestion', { questions: [] }, W).decision).toBe('pass');
  expect(guardDecision('ExitPlanMode', {}, W).decision).toBe('pass');
  expect(guardDecision('mcp__dure__todo_update', {}, W).decision).toBe('pass');
});

test('이름이 지우는 일로 보이는 다른 도구는 묻는다', () => {
  expect(guardDecision('mcp__files__delete_file', { path: 'a' }, W).decision).toBe('ask');
  expect(guardDecision('mcp__db__drop_collection', {}, W).decision).toBe('ask');
  expect(guardDecision('mcp__store__removeItem', {}, W).decision).toBe('ask');
  expect(guardDecision('mcp__files__read_file', { path: 'a' }, W)).toEqual({ decision: 'allow' });
});

test.each([
  // 경로를 덮어쓰는 checkout 과 같은 뜻의 명령
  'git checkout HEAD a.ts', 'git checkout origin/main package.json', 'git checkout HEAD~1 src/', 'git checkout --ours a.ts', 'git checkout -B main',
  'git switch --discard-changes main', 'git switch -f main', 'git reset --merge', 'git reset --keep HEAD~1',
  // 앞의 것이 괜찮아도 뒤의 것을 본다
  'git restore --staged a.ts && git restore a.ts', 'git restore --staged .\ngit restore .', 'git status; git clean -fd',
  // DB 를 비우는 흔한 명령
  'npx prisma migrate reset --force', 'npx prisma db push --force-reset', 'rails db:drop', 'rails db:reset', 'python manage.py flush', 'php artisan migrate:fresh',
  'supabase db reset', 'mysqladmin drop shop', 'psql -c "DROP FUNCTION f"', 'psql -c "drop materialized view mv"',
  // HTTP DELETE 와 콜론 꼴 하위 명령
  'curl -X DELETE https://api/x', 'curl -XDELETE localhost:9200/idx', 'gh api -X DELETE repos/a/b', 'heroku apps:destroy app', 'firebase firestore:delete --all-collections',
  'aws s3 rb s3://b --force', 'aws s3 sync . s3://b --delete', 'aws ecr batch-delete-image --repository-name r',
  // 한 줄 코드와 rm 의 모양 변형
  'node -e "fs.promises.rm(\'d\')"', 'node -e "require(\'fs/promises\').rm(\'d\',{recursive:true})"', 'python3 -c "from shutil import rmtree; rmtree(\'d\')"',
  'python3 -c "from os import remove; remove(\'a\')"', 'perl -e \'unlink("a")\'', '\\rm x', 'npx -y rimraf@5 dist', 'rm\\\n -rf x', 'command rm x', 'FOO=1 rm x', 'echo $(rm x)',
  // 내용을 비우는 꼴
  'truncate -s 0 a.log', ': > a.log', '> a.log', 'cp /dev/null a.log', 'mv a /dev/null',
])('빠뜨리기 쉬운 지우는 명령도 묻는다: %s', (command) => {
  expect(bash(command).decision).toBe('ask');
});

test.each([
  // 글 안의 낱말일 뿐인 것
  'grep -rn "rm -rf" .', 'grep -n "unlink" a.c', 'which rm', 'echo rm', 'ls src/trash', 'cat notes/rm.md',
  'python3 -c "df = df.drop(columns=[\'a\'])"', 'node -e "el.classList.remove(\'a\')"',
  // 지우지 않는 변형
  'git clean -n', 'git clean --dry-run -d', 'git rm --cached secret.env', 'git checkout -b feature origin/main', 'git checkout --track origin/dev', 'git switch main', 'git switch -c feature',
  'git commit -m "rm old file"', 'npm rm lodash', 'npm uninstall lodash', 'pnpm remove react', 'curl -X POST https://api/x', 'echo hi >> a.log', 'npm test 2>&1 | tail -5',
  'echo hello > hello.txt', 'docker compose down', 'aws s3 ls', 'rails db:migrate',
])('지우지 않는 것은 묻지 않는다: %s', (command) => {
  expect(bash(command)).toEqual({ decision: 'allow' });
});

test('아주 긴 명령은 가리지 않고 묻는다 (오래 걸려 앱이 멈추지 않게)', () => {
  const started = Date.now();
  expect(bash('aws '.repeat(50_000)).decision).toBe('ask');
  expect(bash(`echo ${'docker ps '.repeat(1500)}`)).toEqual({ decision: 'allow' });
  expect(Date.now() - started).toBeLessThan(1000);
});

test('모르는 도구: 이름은 낱말로 가리고, 입력에 든 명령과 질의를 본다', () => {
  expect(guardDecision('mcp__postgres__query', { sql: 'DROP TABLE users' }, W).decision).toBe('ask');
  expect(guardDecision('mcp__supabase__execute_sql', { query: 'delete from users' }, W).decision).toBe('ask');
  expect(guardDecision('mcp__shell__run_command', { command: 'rm -rf build' }, W).decision).toBe('ask');
  expect(guardDecision('mcp__postgres__query', { sql: 'select 1' }, W)).toEqual({ decision: 'allow' });
  expect(guardDecision('mcp__slack__post_message', { text: 'rm 으로 지웠어요' }, W)).toEqual({ decision: 'allow' });
  // 낱말의 일부일 뿐인 것은 묻지 않는다
  expect(guardDecision('mcp__ui__select_dropdown', {}, W)).toEqual({ decision: 'allow' });
  expect(guardDecision('mcp__mail__untrash_message', {}, W)).toEqual({ decision: 'allow' });
  expect(guardDecision('mcp__x__undelete', {}, W)).toEqual({ decision: 'allow' });
  expect(guardDecision('mcp__x__reset_database', {}, W).decision).toBe('ask');
  expect(guardDecision('mcp__git__git_reset', {}, W).decision).toBe('ask');
  // 쓰는 도구가 작업 폴더 밖을 가리키면 평소 승인에 맡긴다
  expect(guardDecision('mcp__filesystem__write_file', { path: '/etc/hosts', content: 'x' }, W).decision).toBe('pass');
  expect(guardDecision('mcp__filesystem__write_file', { path: '/work/tree/a.txt', content: 'x' }, W)).toEqual({ decision: 'allow' });
  expect(guardDecision('mcp__filesystem__read_file', { path: '/etc/hosts' }, W)).toEqual({ decision: 'allow' });
});

test('작업 폴더 안의 링크가 밖을 가리키면 밖으로 본다', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  const tree = join(root, 'tree'); const outside = join(root, 'outside');
  mkdirSync(tree); mkdirSync(outside);
  symlinkSync(outside, join(tree, 'link'));
  expect(guardDecision('Write', { file_path: join(tree, 'a.txt'), content: 'x' }, tree)).toEqual({ decision: 'allow' });
  expect(guardDecision('Write', { file_path: join(tree, 'new', 'deep', 'a.txt'), content: 'x' }, tree)).toEqual({ decision: 'allow' });
  expect(guardDecision('Write', { file_path: join(tree, 'link', 'out.txt'), content: 'x' }, tree).decision).toBe('pass');
  expect(guardDecision('Edit', { file_path: 'link/out.txt' }, tree).decision).toBe('pass');
  expect(guardDecision('Edit', { file_path: 'src/a.ts' }, tree)).toEqual({ decision: 'allow' });
});

test('명령이 없거나 글자가 아니면 평소 승인에 맡긴다', () => {
  expect(guardDecision('Bash', {}, W).decision).toBe('pass');
  expect(guardDecision('Bash', { command: 42 }, W).decision).toBe('pass');
  expect(guardDecision('Bash', null, W).decision).toBe('pass');
});

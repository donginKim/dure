import { guardDecision } from '@core/agents/guard';

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

test('명령이 없거나 글자가 아니면 평소 승인에 맡긴다', () => {
  expect(guardDecision('Bash', {}, W).decision).toBe('pass');
  expect(guardDecision('Bash', { command: 42 }, W).decision).toBe('pass');
  expect(guardDecision('Bash', null, W).decision).toBe('pass');
});

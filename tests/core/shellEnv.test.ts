import { resolveShellEnv } from '@core/shellEnv';

test('resolveShellEnv 는 PATH 를 포함한다', async () => {
  const env = await resolveShellEnv();
  expect(env.PATH).toBeTruthy();
  expect(env.PATH.split(':')).toContain('/usr/bin');
});

test('resolveShellEnv 는 셸이 없으면 process.env 를 돌려준다', async () => {
  const env = await resolveShellEnv('/nonexistent/shell');
  expect(env.PATH).toBe(process.env.PATH);
});

test('resolveShellEnv 는 값에 줄바꿈이 있어도 깨지지 않는다', async () => {
  process.env.DURE_TEST_MULTILINE = 'a\nb=c';
  try {
    const env = await resolveShellEnv('/bin/sh');
    expect(env.DURE_TEST_MULTILINE).toBe('a\nb=c');
  } finally {
    delete process.env.DURE_TEST_MULTILINE;
  }
});

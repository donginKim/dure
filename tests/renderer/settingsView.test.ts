import { isClaudeModel } from '../../src/renderer/settingsView';

test.each([
  ['claude-opus-5-5', 'Opus 5.5', true],
  ['fable', 'Fable 5.2', true],
  ['claude/claude-haiku-5-5[1m]', 'Haiku', true],
  ['sonnet', 'Sonnet 5.5', true],
  ['gemini-3-pro', 'Gemini 3 Pro', false],
  ['gpt-6', 'GPT-6', false],
  ['o5-mini', 'o5 mini', false],
])('isClaudeModel(%s, %s) = %s', (value, name, expected) => {
  expect(isClaudeModel({ value, name })).toBe(expected);
});

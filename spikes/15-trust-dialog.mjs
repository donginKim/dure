// 실험 15: 폴더 신뢰 창의 실제 화면과, 아래 화살표·Enter 로 넘어가는지.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeTempRepo, runAgent, sleep } from './lib/harness.mjs';

const repo = makeTempRepo();
const agent = runAgent({ name: '15-trust-dialog', command: 'claude', cwd: repo, args: [] });
await agent.settle(2500, 20000);
const first = agent.tail(900);
const rawTail = agent.raw().slice(-1500);
writeFileSync(resolve(import.meta.dirname, 'out/15-trust-raw.json'), JSON.stringify({ first, rawTail }));
console.log('--- 처음 화면 ---\n' + first);
const cursorOn = (t) => (/❯\s*\d\.\s*([^\n]+)/.exec(t) ?? [])[1]?.trim();
console.log('cursor on:', cursorOn(first));
if (!/trust/i.test(first)) { console.log('신뢰 창이 아님'); agent.kill(); process.exit(0); }
let t = first;
for (let i = 0; i < 3 && !/^Yes, I trust/.test(cursorOn(t) ?? ''); i++) { agent.write('\x1b[B'); await sleep(900); t = agent.tail(600); }
console.log('--- 이동 뒤 ---\ncursor on:', cursorOn(t));
if (/^Yes, I trust/.test(cursorOn(t) ?? '')) { agent.write('\r'); await agent.settle(2500, 15000); console.log('--- Enter 뒤 ---\n' + agent.tail(500)); }
agent.kill(); process.exit(0);

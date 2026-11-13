import { useEffect, useState } from 'react';
import type { Repo } from '@shared/types';
import type { TreeNode } from '../tree';

const HIDE_KEY = 'dure.onboarding.hidden';
const hidden = (): boolean => { try { return window.localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };

type Doctor = { claude: string | null; git: string | null; loggedIn: boolean | null };

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className={`onb-step${done ? ' done' : ''}`}>
      <span className="onb-n">{done ? '✓' : n}</span>
      <div className="grow">
        <div className="onb-title">{title}</div>
        <div className="onb-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * 처음 켤 때 안내. 준비(Claude Code, git, 로그인) → 프로젝트 만들기 → 저장소 → 기획서 주기.
 * 해 둔 것은 저절로 체크된다. 닫으면 다시 뜨지 않는다 (프로젝트 화면의 "시작 안내" 로 다시 연다).
 */
export function Onboarding({ tree, repos, onCreate, onOpenProject, force, onClose }: {
  tree: TreeNode[]; repos: Repo[]; onCreate: (name: string) => Promise<void>; onOpenProject: (id: string) => void; force?: boolean; onClose?: () => void;
}) {
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(hidden());
  useEffect(() => { window.dure.doctor().then(setDoctor).catch(() => setDoctor(null)); }, []);
  const hasProject = tree.length > 0;
  const hasRepo = repos.length > 0;
  const hasWork = tree.some((n) => n.workspaces.some((w) => w.role !== 'coordinator'));
  const ready = Boolean(doctor?.claude && doctor.git && doctor.loggedIn !== false);
  // 네 단계를 다 했으면 따로 닫지 않아도 접힌다 ("시작 안내" 버튼으로 다시 연다).
  const allDone = ready && hasProject && hasRepo && hasWork;
  if (!force && hasProject && (closed || allDone)) return null;
  const first = tree[0]?.project.id;
  const close = (): void => { try { window.localStorage.setItem(HIDE_KEY, '1'); } catch { /* 못 기억해도 된다 */ } setClosed(true); onClose?.(); };
  const create = (): void => {
    if (!name.trim()) return;
    setBusy(true); setError('');
    onCreate(name.trim()).then(() => setName('')).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="onboarding">
      <div className="onb-head">
        <div className="grow">
          <b>두레 시작하기</b>
          <div className="muted">여러 AI 에이전트에게 일을 나눠 시키는 순서입니다. 해 둔 것은 저절로 체크됩니다.</div>
        </div>
        {hasProject && <button className="btn ghost" onClick={close}>닫기</button>}
      </div>
      <Step n={1} done={ready} title="이 PC 준비">
        {!doctor ? '확인하는 중…' : (
          <ul className="onb-list">
            <li className={doctor.claude ? 'ok' : 'bad'}>Claude Code: {doctor.claude ? <code>{doctor.claude}</code> : <>없습니다. 터미널에서 설치하세요 (<a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">설치 안내</a>). 다른 곳에 있으면 설정에서 경로를 적습니다.</>}</li>
            <li className={doctor.git ? 'ok' : 'bad'}>git: {doctor.git ?? <>없습니다. 터미널에서 <code>xcode-select --install</code> 로 설치하세요.</>}</li>
            {doctor.claude && <li className={doctor.loggedIn ? 'ok' : doctor.loggedIn === false ? 'bad' : ''}>로그인: {doctor.loggedIn ? '확인됨' : doctor.loggedIn === false ? <>로그인이 필요합니다. 터미널에서 <code>claude</code> 를 한 번 실행해 로그인하세요.</> : '확인하지 못했습니다 (에이전트를 띄워 보면 압니다)'}</li>}
          </ul>
        )}
      </Step>
      <Step n={2} done={hasProject} title="프로젝트 만들기">
        <div>프로젝트는 함께 움직이는 저장소들의 묶음입니다 (예: 쇼핑몰 = 화면 + API).</div>
        {!hasProject && (
          <form className="onb-form" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <input type="text" value={name} placeholder="프로젝트 이름 (예: 쇼핑몰)" onChange={(e) => setName(e.target.value)} />
            <button className="btn primary" disabled={busy || !name.trim()}>만들기</button>
          </form>
        )}
        {error && <div className="error">{error}</div>}
      </Step>
      <Step n={3} done={hasRepo} title="저장소 등록 (없으면 건너뛰어도 됩니다)">
        <div>이미 있는 코드로 일하려면 프로젝트의 <b>현황</b> 탭에서 "저장소 추가" 로 git 저장소 폴더를 고릅니다. 새로 시작하면 조율 에이전트가 계획안에 새 저장소를 넣고, 승인하면 두레가 만듭니다.</div>
        {hasProject && !hasRepo && first && <button className="btn" onClick={() => onOpenProject(first)}>프로젝트 열기</button>}
      </Step>
      <Step n={4} done={hasWork} title="기획서 주기">
        <div>프로젝트의 <b>조율</b> 탭에 기획서 파일을 끌어 넣거나 할 일을 씁니다. 조율 에이전트가 계획안(정리, 워크스페이스, TODO)을 올리면 검토하고 승인합니다. 승인하면 저장소마다 에이전트가 일을 시작합니다.</div>
        {hasProject && !hasWork && first && <button className="btn" onClick={() => onOpenProject(first)}>조율 탭으로</button>}
      </Step>
      <div className="onb-tips">
        <b>알아 두면 좋은 것</b>
        <ul>
          <li>에이전트가 끝낸 일을 믿으려면: 현황 탭의 저장소 줄에 <b>확인 명령</b>(예: <code>pnpm test</code>)을 적으세요. 통과해야 완료로 바뀝니다.</li>
          <li>사용량이 걱정되면: 현황 탭의 사용량에서 <b>예산</b>(하루·전체 상한)을 정하세요.</li>
          <li>커밋과 main 반영은 기본으로 내가 누릅니다. 시험이 탄탄한 저장소는 현황 탭의 <b>자동 반영</b>을 켤 수 있습니다.</li>
          <li>에이전트가 답을 기다리면 왼쪽 위 <b>확인할 것</b>에 모입니다.</li>
        </ul>
      </div>
    </div>
  );
}

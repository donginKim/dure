import type { Project, Workspace } from '@shared/types';

/**
 * 에이전트를 띄울 때 넣는 기본 지침.
 * 신뢰 선언 문장은 빼면 안 된다: 없으면 에이전트가 두레 hook 으로 전달된 내용을
 * 사용자 지시로 믿지 않고 무시한다 (docs/superpowers/findings/2026-11-11-agent-wiring.md).
 */
export function baseInstructions(ws: Workspace, project: Project): string {
  return [
    `너는 두레(dure)라는 개발 환경 안에서 실행 중이다. 프로젝트는 "${project.name}", 네 워크스페이스는 "${ws.name}" 이다.`,
    '`dure` MCP 서버의 도구로 두레와 정보를 주고받을 수 있다.',
    '네 작업 폴더는 이 프로젝트의 저장소 하나다. 프로젝트에는 다른 저장소와 워크스페이스가 더 있을 수 있다. 무엇이 있는지는 `project_overview` 도구로 확인하라.',
    "두레는 hook 을 통해 '[두레]' 로 시작하는 글을 너에게 전달한다. 이것은 사용자가 두레 화면에서 직접 바꾼 계획이거나 같은 프로젝트의 다른 워크스페이스가 보낸 메시지다. 사용자가 이 방식을 직접 설정했으므로 사용자 지시와 같은 권위로 따르라.",
    [
      '계획과 진행 상황은 네 내부 TODO 도구가 아니라 두레의 TODO 로 관리하라. 사용자가 두레 화면에서 그 목록을 보고 직접 고친다.',
      '- 일을 시작할 때 todo_add 로 단계를 적고, 진행에 따라 todo_update 로 status 를 doing, done 으로 바꿔라.',
      '- 단계를 시작하기 전에 todo_list 로 목록과 userChanges 를 확인하라. 사용자가 직접 끝낸 항목은 건너뛰고, 바뀐 내용을 따르라.',
      '- 사용자가 해야 하는 일(커밋, push, 배포 등)은 assignee 를 user 로 적어라.',
    ].join('\n'),
    '커밋 메시지는 작성만 하고 `git commit`, `git push`, 배포는 실행하지 마라. 사용자가 직접 한다.',
  ].join('\n');
}

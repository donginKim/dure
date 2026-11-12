# 두레를 macOS 앱으로 묶기

## 만들기

```sh
npx -y pnpm@12.18.0 install
npx -y pnpm@12.18.0 run pack:mac        # Apple 실리콘 (M1 이후)
npx -y pnpm@12.18.0 run pack:mac:x64    # Intel Mac
```

결과는 `dist/` 에 생긴다 (git 에 올리지 않는다).

- `dure-<버전>-arm64.dmg`, `dure-<버전>-arm64.zip`: Apple 실리콘용
- `dure-<버전>-x64.dmg`, `dure-<버전>-x64.zip`: Intel용
- 두 번째 명령은 `dist/` 를 같이 쓴다. 둘 다 만들 때는 앞의 결과를 먼저 다른 곳에 옮겨 둔다.

설정은 `electron-builder.yml` 에 있다.

## 받는 사람이 처음 열 때

이 앱은 Apple 개발자 인증서로 서명하지 않았고 공증도 받지 않았다 (임시 서명만 돼 있다). 그래서 내려받은 앱을 처음 열면 macOS 가 막는다.

1. `.dmg` 를 열고 Dure 를 "응용 프로그램" 폴더로 옮긴다.
2. 터미널에서 한 번 실행한다: `xattr -dr com.apple.quarantine /Applications/Dure.app`
3. Dure 를 연다.

2번 대신 "시스템 설정 → 개인정보 보호 및 보안" 의 맨 아래에서 "그래도 열기" 를 눌러도 된다 (macOS 15 부터는 Finder 의 우클릭 → 열기로는 풀리지 않는다).

## 받는 사람의 PC 에 있어야 하는 것

- macOS 12 이상
- `git`
- Claude Code (`claude` 명령) 와 로그인. 두레는 사용자의 로그인 셸에서 `PATH` 를 읽어 `claude` 를 찾는다.

## 알아 둘 것

- 파일 이름은 `Dure.app` 이다. 한글 이름("두레.app")으로 묶으면 Electron 45 가 시작하자마자 죽는다 (2026-11-12 실측). 창 제목과 Dock 의 이름은 "두레" 다.
- 데이터는 `~/Library/Application Support/dure` 에 있다. 개발 모드(`electron-vite dev`)로 띄운 두레와 같은 폴더다: 둘을 동시에 띄우지 않는다.
- 키체인: 두레는 DB 비밀번호와 연결용 열쇠를 macOS 키체인의 "dure Safe Storage" 로 암호화한다. 서명이 임시라서 앱을 새로 받을 때마다 (또는 개발 모드로 쓰다가 묶인 앱을 처음 열 때) macOS 가 "Dure 가 키체인의 dure Safe Storage 를 쓰려고 합니다" 라고 묻는다. "항상 허용" 을 누른다. 이 창이 떠 있는 동안 앱이 멈춘 것처럼 보인다.
- "다른 사람과 연결" 을 처음 켜면 macOS 가 "로컬 네트워크의 기기를 찾도록 허용" 과 방화벽의 "들어오는 연결 허용" 을 물을 수 있다. 둘 다 허용해야 다른 PC 가 찾고 연결할 수 있다.
- 아이콘은 Electron 기본 아이콘이다. 바꾸려면 `build/icon.icns` 를 둔다.
- 자동 업데이트는 없다. 새 판은 다시 받아 덮어쓴다.

## 확인한 것 (2026-11-12)

- Apple 실리콘 묶음: 실행, 프로젝트·저장소·워크스페이스(작업 폴더와 브랜치) 생성, 터미널 실행 ✅
- Intel 묶음: Rosetta 로 실행, 프로젝트 생성 ✅ (진짜 Intel Mac 에서는 확인하지 않았다 ⚠️)
- 확인하지 않은 것 ⚠️: Finder 에서 더블클릭으로 열었을 때의 `PATH` (터미널에서 띄운 것만 확인), 다른 PC 에서의 첫 실행, 다른 PC 와의 연결.

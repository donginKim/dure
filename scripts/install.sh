#!/bin/bash
# 두레를 소스에서 설치한다 (macOS).
# 쓰는 법: 저장소를 받은 폴더에서
#   bash scripts/install.sh
# 하는 일: 필요한 패키지를 받고, 이 Mac 에서 앱을 만들어 "응용 프로그램" 에 Dure 를 넣고 연다.
# 이 Mac 에서 직접 만든 앱이라 macOS 가 "확인되지 않은 개발자" 라고 막지 않는다. 관리자 암호는 묻지 않는다.
# 다시 실행하면 새 소스로 다시 만들어 바꾼다 (데이터는 ~/Library/Application Support/dure 에 그대로 남는다).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="${DURE_INSTALL_DIR:-/Applications}"
pnpm_version="12.18.0"
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n설치하지 못했습니다: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS 에서만 됩니다."
command -v git >/dev/null 2>&1 || die "git 이 없습니다. 터미널에서 'xcode-select --install' 로 설치하세요."
command -v node >/dev/null 2>&1 || die "Node.js 가 없습니다. https://nodejs.org 에서 설치하세요 (22 이상)."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node.js 22 이상이 필요합니다 (지금 $(node -v))."
[ -f "$root/package.json" ] || die "저장소 폴더가 아닙니다: $root"

# 이 Mac 의 칩 (Rosetta 로 돌린 터미널에서도 진짜 칩을 본다)
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then arch=arm64; out="dist/mac-arm64"; else arch=x64; out="dist/mac"; fi

if pgrep -f "$dest/Dure.app/Contents/MacOS/Dure" >/dev/null 2>&1; then die "Dure 가 켜져 있습니다. 끄고 다시 실행하세요."; fi
mkdir -p "$dest"
[ -w "$dest" ] || die "$dest 에 쓸 수 없습니다."

cd "$root"
pnpm() { npx -y "pnpm@$pnpm_version" "$@"; }

say "패키지를 받습니다 (처음에는 몇 분 걸립니다)"
pnpm install

say "앱을 만듭니다 ($arch)"
pnpm exec electron-vite build
rm -rf "$out"
# --dir: 설치 파일(dmg)은 만들지 않고 앱만 만든다. "-" 는 임시 서명이다 (Apple 실리콘에서는 서명이 전혀 없으면 실행되지 않는다).
pnpm exec electron-builder --mac "--$arch" --dir -c.mac.identity=- -c.mac.hardenedRuntime=false
[ -d "$out/Dure.app" ] || die "앱이 만들어지지 않았습니다 ($out/Dure.app)."

say "$dest 에 넣습니다"
rm -rf "$dest/Dure.app"
ditto "$out/Dure.app" "$dest/Dure.app" || die "복사하지 못했습니다."
xattr -dr com.apple.quarantine "$dest/Dure.app" 2>/dev/null || true

# 어디서 만들어 어디에 넣었는지 적어 둔다: 두레가 이것을 보고 새 버전을 확인하고 업데이트한다.
info="${DURE_INSTALL_INFO:-$HOME/Library/Application Support/dure/install.json}"
mkdir -p "$(dirname "$info")"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ sourceDir: process.argv[2], app: process.argv[3], commit: process.argv[4], installedAt: Date.now() }) + "\n")' \
  "$info" "$root" "$dest/Dure.app" "$(git -C "$root" rev-parse HEAD)" || printf '\n주의: 설치 정보를 적지 못했습니다. 앱 안의 업데이트는 쓸 수 없고, 이 스크립트를 다시 실행해 업데이트합니다.\n'

shell="${SHELL:-/bin/zsh}"
"$shell" -lic "command -v claude" >/dev/null 2>&1 || printf '\n주의: Claude Code (claude 명령) 가 없습니다. 설치하고 로그인해야 에이전트가 뜹니다: https://claude.com/claude-code\n'

say "설치했습니다: $dest/Dure.app"
if [ "${DURE_NO_OPEN:-}" != "1" ]; then open "$dest/Dure.app"; fi

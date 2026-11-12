#!/bin/bash
# 두레 설치 스크립트 (macOS).
# 쓰는 법: 이 파일과 dure-*.dmg 를 같은 폴더에 두고, 터미널에서
#   bash install-dure.sh
# 하는 일: 이 Mac 의 칩에 맞는 dmg 를 골라 "응용 프로그램" 에 Dure 를 넣고, macOS 가 막지 않게 격리 표시를 지운 뒤 연다.
# 인터넷에서 아무것도 내려받지 않고, 관리자 암호도 묻지 않는다.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dest="${DURE_INSTALL_DIR:-/Applications}"
say() { printf '%s\n' "$*"; }
die() { printf '설치하지 못했습니다: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS 에서만 됩니다."

# 이 Mac 의 칩 (Rosetta 로 돌린 터미널에서도 진짜 칩을 본다)
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then arch=arm64; else arch=x64; fi

# dmg 고르기: 인자로 준 파일, 없으면 같은 폴더에서 칩에 맞는 가장 새 파일
dmg="${1:-}"
if [ -z "$dmg" ]; then
  dmg="$(ls -t "$here"/dure-*-"$arch".dmg 2>/dev/null | head -1 || true)"
  [ -n "$dmg" ] || die "이 폴더에 dure-*-$arch.dmg 가 없습니다 (이 Mac 은 $arch 입니다). 같은 폴더에 두거나, bash install-dure.sh <dmg 경로> 로 알려 주세요."
fi
[ -f "$dmg" ] || die "파일이 없습니다: $dmg"
say "설치할 파일: $dmg"

# 이미 떠 있으면 먼저 끄게 한다 (덮어쓰는 동안 돌고 있으면 안 된다)
if pgrep -f "$dest/Dure.app/Contents/MacOS/Dure" >/dev/null 2>&1; then die "Dure 가 켜져 있습니다. 끄고 다시 실행하세요."; fi

mount="$(mktemp -d /tmp/dure-install.XXXXXX)"
cleanup() { hdiutil detach "$mount" -quiet 2>/dev/null || true; rmdir "$mount" 2>/dev/null || true; }
trap cleanup EXIT
hdiutil attach "$dmg" -nobrowse -readonly -quiet -mountpoint "$mount" || die "dmg 를 열 수 없습니다 (내려받다 끊겼을 수 있습니다)."
[ -d "$mount/Dure.app" ] || die "dmg 안에 Dure.app 이 없습니다."

mkdir -p "$dest"
[ -w "$dest" ] || die "$dest 에 쓸 수 없습니다."
# 앞의 판은 지우고 넣는다 (데이터는 ~/Library/Application Support/dure 에 따로 있어 그대로 남는다)
rm -rf "$dest/Dure.app"
ditto "$mount/Dure.app" "$dest/Dure.app" || die "복사하지 못했습니다."

# macOS 가 "확인되지 않은 개발자" / "손상됨" 이라며 막는 것을 푼다
xattr -dr com.apple.quarantine "$dest/Dure.app" 2>/dev/null || true
say "설치했습니다: $dest/Dure.app"

# 두레가 쓰는 것이 있는지 알려 준다 (없어도 설치는 된다)
shell="${SHELL:-/bin/zsh}"
has() { "$shell" -lic "command -v $1" >/dev/null 2>&1; }
has git || say "주의: git 이 없습니다. 터미널에서 'xcode-select --install' 로 설치하세요."
has claude || say "주의: Claude Code (claude 명령) 가 없습니다. 설치하고 로그인해야 에이전트가 뜹니다: https://claude.com/claude-code"

if [ "${DURE_NO_OPEN:-}" != "1" ]; then open "$dest/Dure.app"; say "Dure 를 열었습니다."; fi

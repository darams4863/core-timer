#!/bin/zsh
# 코어타이머 — macOS 소스 빌드 & 설치 스크립트
# 사용법: 터미널에서  zsh <이 스크립트 경로>  [소스 zip 경로]
#   - zip 경로를 안 주면 ① 스크립트와 같은 폴더 ② 현재 폴더 ③ ~/Downloads 순서로 찾는다.
#   - 스크립트 파일을 터미널 창에 끌어다 놓으면 경로가 자동으로 입력된다.
set -e

SCRIPT_DIR=${0:A:h}
if [[ -n "$1" ]]; then
  ZIP=${1:A}
  [[ -f "$ZIP" ]] || { echo "❌ 파일이 없어요: $1"; exit 1; }
else
  zips=("$SCRIPT_DIR"/core-timer-source*.zip(N.om) "$PWD"/core-timer-source*.zip(N.om) ~/Downloads/core-timer-source*.zip(N.om))
  ZIP=${zips[1]}
fi
[[ -z "$ZIP" ]] && { echo "❌ core-timer-source*.zip 을 못 찾았어요. 스크립트와 같은 폴더에 두거나, zip 경로를 인자로 주세요."; exit 1; }
echo "▶ 소스: $ZIP"

# 1) Xcode Command Line Tools
if ! xcode-select -p >/dev/null 2>&1; then
  echo "▶ Xcode Command Line Tools 설치 창이 뜹니다. 설치 완료 후 이 스크립트를 다시 실행하세요."
  xcode-select --install; exit 1
fi

# 2) Rust
[[ -f ~/.cargo/env ]] && source ~/.cargo/env
if ! command -v cargo >/dev/null; then
  echo "▶ Rust 설치"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source ~/.cargo/env
fi

# 3) Node 22.12+
export NVM_DIR="$HOME/.nvm"; [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
need_node() { ! command -v node >/dev/null || ! node -e 'const[a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a==22&&b>=12)?0:1)'; }
if need_node; then
  if command -v nvm >/dev/null; then nvm install 22; nvm use 22
  else echo "❌ Node.js 22.12 이상이 필요해요 (brew install node 또는 nvm)."; exit 1; fi
fi
echo "▶ node $(node -v)"

# 4) pnpm
command -v pnpm >/dev/null || npm install -g pnpm
echo "▶ pnpm $(pnpm -v)"

# 5) 실행 중이면 종료
pkill -x core-timer 2>/dev/null || true

# 6) 압축 해제 & 빌드
WORK=~/core-timer-build
rm -rf "$WORK"; mkdir -p "$WORK"
unzip -q "$ZIP" -d "$WORK"
cd "$WORK"/core-timer/
pnpm install --frozen-lockfile
pnpm tauri build --bundles app

# 7) 응용 프로그램에 설치
APP=$(ls -d src-tauri/target/release/bundle/macos/*.app | head -1)
DEST="/Applications/CoreTimer.app"
[[ -w /Applications ]] || { mkdir -p ~/Applications; DEST="$HOME/Applications/CoreTimer.app"; }
rm -rf "$DEST"; cp -R "$APP" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true
echo "✅ 설치 완료: $DEST"
echo "   메뉴 막대 오른쪽에 자물쇠 아이콘이 생겨요. 위젯은 드래그로 옮기고, 우클릭하면 설정이 열려요."
open "$DEST"

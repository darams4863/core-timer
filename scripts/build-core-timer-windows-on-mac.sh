#!/bin/zsh
# 코어타이머 — Mac에서 Windows 설치 파일(.exe) 만들기 (교차 빌드)
# 사용법: core-timer-source.zip 과 같은 폴더에서  zsh build-core-timer-windows-on-mac.sh
set -e

SCRIPT_DIR=${0:A:h}
zips=("$SCRIPT_DIR"/core-timer-source*.zip(N.om) "$PWD"/core-timer-source*.zip(N.om) ~/Downloads/core-timer-source*.zip(N.om))
ZIP=${zips[1]}
[[ -z "$ZIP" ]] && { echo "❌ core-timer-source*.zip 을 못 찾았어요."; exit 1; }
echo "▶ 소스: $ZIP"

command -v brew >/dev/null || { echo "❌ Homebrew가 필요해요: https://brew.sh"; exit 1; }
[[ -f ~/.cargo/env ]] && source ~/.cargo/env
export NVM_DIR="$HOME/.nvm"; [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"

echo "▶ 교차 빌드 도구 설치 (NSIS, LLVM, cargo-xwin) — 처음 한 번만 오래 걸려요"
brew list nsis >/dev/null 2>&1 || brew install nsis
brew list llvm >/dev/null 2>&1 || brew install llvm
export PATH="$(brew --prefix llvm)/bin:$PATH"
rustup target add x86_64-pc-windows-msvc
command -v cargo-xwin >/dev/null || cargo install --locked cargo-xwin
command -v pnpm >/dev/null || npm install -g pnpm

WORK=~/core-timer-win-build
rm -rf "$WORK"; mkdir -p "$WORK"
unzip -q "$ZIP" -d "$WORK"
cd "$WORK"/core-timer/
pnpm install --frozen-lockfile
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc

EXE=$(ls src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe | head -1)
cp "$EXE" ~/Downloads/
echo "✅ 완료: ~/Downloads/$(basename "$EXE")"

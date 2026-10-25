#!/usr/bin/env bash
# 작업 공간을 처음 만들 때 한 번 돈다.
# practice 를 먼저 깐다(이게 있어야 과제를 받는다). Codex 설치가 막혀도 practice 는 남는다.
set -u

echo "[1/3] practice 명령을 설치합니다"
# npm 이 잠깐 실패하는 경우가 있어 한 번 더 해 본다
if ! npm i -g ./tools/practice; then
  echo "practice 설치가 한 번 실패해서 다시 시도합니다."
  sleep "${PRACTICE_INSTALL_RETRY_WAIT:-3}"
  npm i -g ./tools/practice || true
fi
if ! command -v practice >/dev/null 2>&1; then
  echo "practice 설치에 실패했습니다. 터미널에서 npm i -g ./tools/practice 를 한 번 더 실행해 주세요."
fi

echo "[2/3] Codex 를 설치합니다"
if ! npm i -g @openai/codex; then
  echo "Codex 설치에 실패했습니다. 터미널에서 npm i -g @openai/codex 를 한 번 더 실행해 주세요."
fi

echo "[3/3] 터미널에 친 명령이 바로 기록되게 합니다"
if ! grep -q "practice-history" "$HOME/.bashrc" 2>/dev/null; then
  {
    echo ""
    echo "# practice-history"
    echo "shopt -s histappend"
    echo "PROMPT_COMMAND=\"history -a\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}\""
  } >> "$HOME/.bashrc"
fi

# practice 가 없으면 README 1번에서 「practice: command not found」를 처음 만난다. 끝 문구로 준비가 된 것처럼 말하지 않는다
if command -v practice >/dev/null 2>&1; then
  echo "준비가 끝났습니다. README.md 의 순서대로 진행하세요."
else
  echo "practice 가 아직 없습니다. 터미널에서 npm i -g ./tools/practice 를 실행해 설치한 뒤 README.md 의 순서대로 진행하세요."
fi

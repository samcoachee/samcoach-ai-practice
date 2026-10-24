#!/usr/bin/env bash
# 작업 공간을 처음 만들 때 한 번 돈다.
# practice 를 먼저 깐다(이게 있어야 과제를 받는다). Codex 설치가 막혀도 practice 는 남는다.
set -u

echo "[1/3] practice 명령을 설치합니다"
npm i -g ./tools/practice

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

echo "준비가 끝났습니다. README.md 의 순서대로 진행하세요."

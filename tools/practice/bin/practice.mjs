#!/usr/bin/env node
// practice — AI 업무 과제 연습실 명령줄 도구
import { login, makeContext, start, status, submit, watch } from '../lib/commands.mjs';
import { PracticeError } from '../lib/http.mjs';
import { CLI_VERSION } from '../lib/util.mjs';

const HELP = `practice ${CLI_VERSION} — AI 업무 과제 연습실

  practice login <접속 코드>   연습실 창에서 받은 prac_ 코드로 연결합니다
  practice start               과제를 받고 시간을 시작합니다
  practice submit              지금 상태로 제출합니다 (보통은 연습실 창의 제출 단추를 씁니다)
  practice status              남은 시간과 연결 상태, AI 사용량을 봅니다
  practice watch               사용량을 보내고 제출 요청을 기다립니다 (start 가 뒤에서 켭니다)

서버 주소를 바꾸려면 환경 변수 PRACTICE_SERVER 를 씁니다.`;

const COMMANDS = { login, start, submit, status, watch };

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    console.log(HELP);
    return;
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    console.log(CLI_VERSION);
    return;
  }
  const fn = COMMANDS[name];
  if (!fn) {
    console.error(`모르는 명령입니다: ${name}\n`);
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  await fn(makeContext(), rest);
}

main().catch((e) => {
  if (e instanceof PracticeError) console.error(e.message);
  else console.error(`예상하지 못한 오류가 났습니다. ${e && e.message ? e.message : e}`);
  if (process.env.PRACTICE_DEBUG) console.error(e && e.stack ? e.stack : e);
  process.exitCode = 1;
});

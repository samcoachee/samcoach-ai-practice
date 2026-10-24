// 설정 파일 ~/.practice/config.json 읽기 · 쓰기. 서버 주소 해석.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODE_PREFIX } from './util.mjs';

export const DEFAULT_SERVER = 'https://careerxp.work';

/**
 * 모든 함수는 opts = { env, home } 를 받는다. 시험에서는 임시 폴더를 home 으로 준다.
 */
function ctxOf(opts = {}) {
  return { env: opts.env || process.env, home: opts.home || os.homedir() };
}

export function practiceHome(opts) {
  const { env, home } = ctxOf(opts);
  return env.PRACTICE_HOME ? path.resolve(env.PRACTICE_HOME) : path.join(home, '.practice');
}

export const configPath = (opts) => path.join(practiceHome(opts), 'config.json');
export const pidPath = (opts) => path.join(practiceHome(opts), 'watch.pid');
export const logPath = (opts) => path.join(practiceHome(opts), 'watch.log');

export function readConfig(opts) {
  try {
    const raw = fs.readFileSync(configPath(opts), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeConfig(cfg, opts) {
  const file = configPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 권한 바꾸기를 지원하지 않는 곳(윈도)은 건너뛴다
  }
  return cfg;
}

export function updateConfig(patch, opts) {
  return writeConfig({ ...readConfig(opts), ...patch }, opts);
}

/** 환경 변수 PRACTICE_SERVER > 설정 파일 > 기본값 */
export function resolveServer(cfg, opts) {
  const { env } = ctxOf(opts);
  const raw = (env.PRACTICE_SERVER || (cfg && cfg.server) || DEFAULT_SERVER).trim();
  return raw.replace(/\/+$/, '');
}

/** 접속 코드 모양 검사. 맞으면 null, 틀리면 손님에게 보일 한국어 */
export function codeProblem(code) {
  const c = String(code || '').trim();
  if (!c) return '접속 코드를 같이 적어 주세요. 예: practice login prac_xxxxxxxx (연습실 창의 작업 패널에서 받습니다)';
  if (!c.startsWith(CODE_PREFIX)) return `접속 코드는 ${CODE_PREFIX} 로 시작합니다. 연습실 창에 보이는 코드를 그대로 붙여넣어 주세요.`;
  if (/\s/.test(c) || c.length < CODE_PREFIX.length + 4) return '접속 코드가 끝까지 복사되지 않은 것 같습니다. 연습실 창의 코드를 다시 복사해 주세요.';
  return null;
}

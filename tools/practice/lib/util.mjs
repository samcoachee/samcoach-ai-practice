// practice CLI 공용 도구. 외부 패키지 없이 Node 내장만 쓴다.
import path from 'node:path';

export const CLI_VERSION = '1.0.0';
export const CODE_PREFIX = 'prac_';
/** 제출 묶음 최대 크기 — 서버(AXP_LIMITS.bundleMaxBytes)와 같은 값 */
export const BUNDLE_MAX_BYTES = 20 * 1024 * 1024;
/** 결과물 글 합계 최대 — 서버(AXP_LIMITS.deliverablesMaxBytes)와 같은 값 */
export const DELIVERABLES_MAX_BYTES = 1024 * 1024;
export const DIFF_MAX_BYTES = 200 * 1024;
export const PROMPT_MAX_CHARS = 2000;
export const HEARTBEAT_MS = 30_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

export function tail(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(s.length - max) : s;
}

/** 숫자가 아닌 값은 0 */
export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 129000 -> 「2분 9초」 */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

export function fmtTokens(n) {
  return Number(n || 0).toLocaleString('en-US');
}

const SECRET_KEY_VALUE =
  /(["']?[\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential)[\w.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}"']+)/gi;
const SECRET_TOKENS =
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|prac_[A-Za-z0-9_-]{6,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

/** 셸 기록 · 설정 파일에 섞여 들어갈 수 있는 비밀 값을 가린다 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(BEARER, 'Bearer ***')
    .replace(SECRET_KEY_VALUE, (_m, key) => `${key}"***"`)
    .replace(SECRET_TOKENS, '***');
}

/**
 * 서버가 준 상대 경로를 root 안쪽 절대 경로로 바꾼다.
 * 절대 경로 · .. · 빈 값은 던진다(서버가 이상한 경로를 줘도 밖에 쓰지 않는다).
 */
export function safeJoin(root, rel) {
  const raw = String(rel ?? '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0')) throw new Error(`쓸 수 없는 파일 경로입니다: ${JSON.stringify(raw)}`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error(`쓸 수 없는 파일 경로입니다: ${raw}`);
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) throw new Error(`쓸 수 없는 파일 경로입니다: ${raw}`);
  const abs = path.join(root, ...parts);
  const relBack = path.relative(root, abs);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) throw new Error(`쓸 수 없는 파일 경로입니다: ${raw}`);
  return abs;
}

export const toPosix = (p) => String(p).split(path.sep).join('/');

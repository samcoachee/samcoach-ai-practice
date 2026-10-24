// practice CLI 공용 도구. 외부 패키지 없이 Node 내장만 쓴다.
import path from 'node:path';

export const CLI_VERSION = '1.1.0';
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

// 비밀 값 가리기 — 서버의 src/lib/ax-practice/redact.ts 와 같은 규칙이다(시험 ax-practice-redact.test.ts 가 두 쪽을 맞춰 본다).
// Bearer · Basic 인증, 이름에 token · secret · password · key 가 든 변수의 값, 주소 안의 아이디:비밀번호,
// --password · --token · --api-key 뒤의 값, curl -u 아이디:비밀번호, 개인 키 블록, 잘 알려진 키 모양
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// 긴 한 줄(압축된 JSON, base64 같은)에서 시간이 길이의 제곱으로 늘지 않게 낱말이 시작하는 자리에서만 보고 앞뒤 길이를 묶는다(10/25 — 1MB 한 줄에 19분 걸렸다)
const URL_CRED = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s:/@]{1,256}:[^\s@/]{1,256}@/gi;
const FLAG_VALUE = /(--(?:password|passwd|token|api-key|apikey|secret|access-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const CURL_USER = /(\s-u\s+)[^\s:]+:\S+/g;
const KEY_VALUE =
  /((?<![\w.-])["']?[\w.-]{0,64}(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|credential|private[_-]?key|access[_-]?key|_key)[\w.-]{0,64}["']?\s{0,8}[:=]\s{0,8})("[^"]{0,4096}"|'[^']{0,4096}'|[^\s,}"']+)/gi;
const TOKENS =
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{10,}|sbp_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]{20,}|prac_[A-Za-z0-9_-]{6,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
// 한글 문장 속 「비밀번호는 abc123」 「토큰: abc123」 — 이름이 한글이라 위 이름 규칙에 안 걸린다. 이름 뒤에 조사나 : = 가 있고 영문 · 숫자 · 기호 4자 이상이 올 때만 가린다
const KO_SECRET =
  /((?:비밀번호|비번|패스워드|암호|비밀 ?키|시크릿(?: ?키)?|토큰|인증 ?키|액세스 ?키|api ?키)(?:(?:은|는|이|가)?\s*[:=]\s*|(?:은|는|이|가)\s+))["']?[!#-&(-~]{4,}["']?/gi;

/** 셸 기록 · 설정 · 변경 내용 · 지시 글에 섞여 들어갈 수 있는 비밀 값을 가린다 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(PEM, '***')
    .replace(BEARER, '$1 ***')
    .replace(URL_CRED, '$1***@')
    .replace(FLAG_VALUE, (_m, flag) => `${flag}***`)
    .replace(CURL_USER, '$1***')
    .replace(KEY_VALUE, (_m, key) => `${key}"***"`)
    .replace(KO_SECRET, '$1***')
    .replace(TOKENS, '***');
}

/** 올리지 않는 파일 — 비밀이 들기 쉬운 이름. 파일 목록 · 변경 내용에서 뺀다 */
export function isSecretFile(relPath) {
  const name = String(relPath ?? '').replace(/\\/g, '/').split('/').pop() || '';
  return /^\.env(\..*)?$/.test(name) || /\.(pem|key|p12|pfx)$/i.test(name) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(name) || name === '.npmrc' || name === '.netrc';
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

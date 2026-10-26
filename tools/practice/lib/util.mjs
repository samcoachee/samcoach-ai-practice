// practice CLI 공용 도구. 외부 패키지 없이 Node 내장만 쓴다.
import path from 'node:path';

// 서버(AXP_MIN_CLI)보다 낮으면 서버가 409 CLI_OUTDATED 로 막는다. 올릴 때는 package.json 의 version 도 같이 올린다(시험이 맞춰 본다)
export const CLI_VERSION = '1.3.0';
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
// Bearer · Basic 인증, 이름에 token · secret · password · pass · pwd · cookie · session id · key 가 든 변수의 값, 주소 안의 아이디:비밀번호,
// --password · --token · --api-key 뒤의 값, curl -u 아이디:비밀번호, Cookie 머리말, 개인 키 블록, 잘 알려진 키 모양
// 개인 키 블록은 BEGIN 만 수만 번 되풀이되는 글에서 시간이 제곱으로 늘지 않게(1MB 에 16초) 다음 BEGIN 을 만나면 그 자리 시도를 접고 8000자까지만 본다(10/25 2차 검토)
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S]){0,8000}?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// 긴 한 줄(압축된 JSON, base64 같은)에서 시간이 길이의 제곱으로 늘지 않게 낱말이 시작하는 자리에서만 보고 앞뒤 길이를 묶는다(10/25 — 1MB 한 줄에 19분 걸렸다)
const URL_CRED = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s:/@]{1,256}:[^\s@/]{1,256}@/gi;
const FLAG_VALUE = /(--(?:password|passwd|token|api-key|apikey|secret|access-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const CURL_USER = /(\s-u\s+)[^\s:]+:\S+/g;
// pass · pwd · cookie 는 bypass · compass · passed · cookies 가 걸리지 않게 앞뒤에 영문자가 붙지 않은 낱말일 때만 본다(DB_PASS · db-pwd · PHPSESSID 는 걸린다)
const KEY_VALUE =
  /((?<![\w.-])["']?[\w.-]{0,128}(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|credential|private[_-]?key|access[_-]?key|_key|(?<![a-z])(?:pass|pwd)(?![a-z])|cookie(?![a-z])|sess(?:ion)?[_-]?id)[\w.-]{0,128}["']?\s{0,8}[:=]\s{0,8})("[^"]{0,4096}"|'[^']{0,4096}'|[^\s,}"']+)/gi;
// Cookie · Set-Cookie 머리말은 「이름=값; 이름=값」이 한 줄에 이어져서 위 규칙으로는 첫 쌍만 가려진다. 따옴표 앞까지 줄 나머지를 가린다
const COOKIE_HEADER = /((?<![\w.-])(?:set-)?cookie\s{0,8}:[ \t]{0,8})[^\s"'][^\r\n"']{0,4095}/gi;
const TOKENS =
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{10,}|sbp_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]{20,}|prac_[A-Za-z0-9_-]{6,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
// 한글 문장 속 「비밀번호는 abc123」 「토큰: abc123」 — 이름이 한글이라 위 이름 규칙에 안 걸린다. 이름 뒤에 조사나 : = 가 있고 영문 · 숫자 · 기호 4자 이상이 올 때만 가린다
const KO_SECRET =
  /((?:비밀번호|비번|패스워드|암호|비밀 ?키|시크릿(?: ?키)?|토큰|인증 ?키|액세스 ?키|api ?키)(?:(?:은|는|이|가)?\s*[:=]\s*|(?:은|는|이|가)\s+))["']?[!#-&(-~]{4,}["']?/gi;

/** 셸 기록 · 설정 · 변경 내용 · 지시 글에 섞여 들어갈 수 있는 비밀 값을 가린다 */
// eslint-disable-next-line no-control-regex
const NUL_CHARS = /\u0000/g;
// NUL(\u0000)은 먼저 지운다 - 비밀 값 가운데 하나만 끼어 있어도 위 규칙이 못 알아보고, DB(jsonb)는 NUL 이 든 글을 거부한다
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(NUL_CHARS, '')
    .replace(PEM, '***')
    .replace(BEARER, '$1 ***')
    .replace(URL_CRED, '$1***@')
    .replace(FLAG_VALUE, (_m, flag) => `${flag}***`)
    .replace(CURL_USER, '$1***')
    .replace(COOKIE_HEADER, '$1***')
    .replace(KEY_VALUE, (_m, key) => `${key}"***"`)
    .replace(KO_SECRET, '$1***')
    .replace(TOKENS, '***');
}

/**
 * 올리지 않는 파일 — 비밀이 들기 쉬운 이름(맨 끝 이름 기준, 대소문자는 가리지 않는다).
 * 파일 목록에서 빼는 isSecretFile 과 변경 내용에서 빼는 목록(manifest.mjs DIFF_EXCLUDES)이 모두 이 한 곳에서 나온다.
 * 예전엔 두 목록을 따로 적어 KEY.PEM 이 파일 목록에서는 빠지고 변경 내용에는 남았다(10/25 2차 검토).
 */
export const SECRET_FILE_GLOBS = ['.env', '.env.*', '.envrc', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '.npmrc', '.netrc'];

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
}
const SECRET_FILE_RES = SECRET_FILE_GLOBS.map(globToRegExp);

/** 올리지 않는 파일 — 비밀이 들기 쉬운 이름. 파일 목록 · 변경 내용에서 뺀다 */
export function isSecretFile(relPath) {
  const name = String(relPath ?? '').replace(/\\/g, '/').split('/').pop() || '';
  return SECRET_FILE_RES.some((re) => re.test(name));
}

/**
 * 문자열 안의 NUL(\u0000)을 모두 지운다(배열 · 객체 안쪽, 객체의 키까지).
 * PostgreSQL jsonb 는 NUL 이 든 문자열을 거부해서, 테스트 출력이나 지시 글에 하나만 섞여도 제출 저장이 매번 실패한다.
 * 비밀 가리기보다 먼저 지운다 - NUL 이 비밀 값 가운데 끼어 있으면 가리기 규칙이 못 알아본다.
 */
export function stripNul(value) {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replace(NUL_CHARS, '') : value;
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[stripNul(k)] = stripNul(v);
    return out;
  }
  return value;
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

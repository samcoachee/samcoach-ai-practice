// 제출 때 모으는 것들. 순수 함수(파서 · 조립)와 파일 · git 읽기를 한곳에 둔다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PracticeError } from './http.mjs';
import { toolHomes } from './sessions.mjs';
import {
  CLI_VERSION,
  DELIVERABLES_MAX_BYTES,
  DIFF_MAX_BYTES,
  PROMPT_MAX_CHARS,
  SECRET_FILE_GLOBS,
  clip,
  isSecretFile,
  redactSecrets,
  safeJoin,
  stripAnsi,
  stripNul,
  tail,
  toPosix,
} from './util.mjs';

/* ───────────────────────── 프로세스 ───────────────────────── */

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    // 이미 끝났다
  }
}

/**
 * 명령 실행. 출력은 maxBytes 까지만 모은다.
 * 반환: { code, stdout, stderr, truncated, timedOut, error }
 */
export function runCapture(command, args, opts = {}) {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args || [], {
        cwd: opts.cwd,
        env: { ...(opts.env || process.env), NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
        shell: Boolean(opts.shell),
        detached: process.platform !== 'win32' && Boolean(opts.shell),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', truncated: false, timedOut: false, error: e });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
        error,
      });
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
          // 죽은 뒤에도 close 가 안 오는 경우를 대비
          setTimeout(() => finish(-1), 2000).unref();
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (b) => {
      if (outBytes >= maxBytes) {
        truncated = true;
        if (opts.killOnLimit) killTree(child);
        return;
      }
      const room = maxBytes - outBytes;
      out.push(b.length > room ? b.subarray(0, room) : b);
      outBytes += Math.min(b.length, room);
      if (b.length > room) {
        truncated = true;
        if (opts.killOnLimit) killTree(child);
      }
    });
    child.stderr.on('data', (b) => {
      if (err.reduce((n, x) => n + x.length, 0) < 256 * 1024) err.push(b);
    });
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/* ───────────────────────── git ───────────────────────── */

const GIT_ID = ['-c', 'user.name=practice', '-c', 'user.email=practice@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

async function git(args, cwd, opts = {}) {
  const r = await runCapture('git', [...GIT_ID, ...args], { cwd, timeoutMs: 60_000, ...opts });
  if (r.error && r.error.code === 'ENOENT') {
    throw new PracticeError('git 을 찾지 못했습니다. 이 작업 공간에는 git 이 들어 있어야 합니다. 작업 공간을 새로 만들어 다시 시도해 주세요.');
  }
  return r;
}

const DEFAULT_GITIGNORE = ['node_modules/', '.venv/', '__pycache__/', '*.pyc', '.DS_Store', '.env', '.env.*', '.envrc', '*.pem', ''].join('\n');

// 변경 내용에서 뺄 파일 — 비밀이 들기 쉬운 것과, 크기만 크고 채점에 쓰지 않는 잠금 파일(앞에서 잘리면 src 변경이 빠진다)
// 비밀 파일 이름은 util.mjs SECRET_FILE_GLOBS 한 곳에서 가져온다(파일 목록의 isSecretFile 과 같은 목록). git 의 icase 로 KEY.PEM · .ENV 같은 대문자도 뺀다(10/25 2차 검토)
export const DIFF_EXCLUDES = [
  ...SECRET_FILE_GLOBS.map((g) => `:(glob,icase,exclude)**/${g}`),
  ':(glob,exclude)**/package-lock.json',
  ':(glob,exclude)**/node_modules/**',
];

/** assignment/ 에 git 을 만들고 첫 커밋(기준점)을 남긴다. 기준점 커밋 해시를 돌려준다. sessionId 가 있으면 저장소 설정에 적어 둔다 */
export async function initRepo(dir, sessionId = null) {
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, DEFAULT_GITIGNORE, 'utf8');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    let r = await git(['init', '-b', 'main'], dir);
    if (r.code !== 0) r = await git(['init'], dir);
    if (r.code !== 0) throw new PracticeError(`git 저장소를 만들지 못했습니다. ${tail(r.stderr, 200)}`);
  }
  await tagRepoSession(dir, sessionId);
  await git(['add', '-A'], dir);
  const c = await git(['commit', '--allow-empty', '-m', 'practice: 시작 기준점'], dir);
  if (c.code !== 0) throw new PracticeError(`첫 커밋을 만들지 못했습니다. ${tail(c.stderr, 200)}`);
  const head = await git(['rev-parse', 'HEAD'], dir);
  const sha = head.stdout.trim();
  if (!sha) throw new PracticeError('기준점 커밋을 확인하지 못했습니다.');
  return sha;
}

/**
 * 이 저장소가 어느 응시(세션)의 작업 폴더인지 .git/config 에 적어 둔다. .git 안이라 변경 내용에 섞이지 않는다.
 * 작업 공간을 다시 만든 뒤(홈 폴더의 설정이 사라진 뒤) 같은 응시의 폴더인지 알아보는 표시다(10/25 2차 검토).
 */
export async function tagRepoSession(dir, sessionId) {
  if (!sessionId) return;
  await git(['config', 'practice.session', String(sessionId)], dir);
}

/** tagRepoSession 으로 적어 둔 응시 번호. .git 이 없거나 적힌 게 없으면 null (상위 폴더의 저장소를 잘못 읽지 않게 .git 부터 본다) */
export async function readRepoSession(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const r = await git(['config', '--get', 'practice.session'], dir);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** 저장소에서 가장 오래된 커밋(practice 가 남긴 시작 기준점) 해시 */
export async function repoBaseline(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const r = await git(['rev-list', '--max-parents=0', 'HEAD'], dir);
  if (r.code !== 0) return null;
  const oldest = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return oldest && /^[0-9a-f]{40}$/.test(oldest) ? oldest : null;
}

/** git log --shortstat 출력 해석(순수) */
export function parseGitLog(raw) {
  const commits = [];
  for (const rec of String(raw || '').split('\x1e')) {
    if (!rec.trim()) continue;
    const lines = rec.split('\n');
    const head = lines[0].split('\x1f');
    if (head.length < 2) continue;
    const stat = lines.slice(1).join(' ');
    const files = Number((stat.match(/(\d+)\s+files?\s+changed/) || [])[1] || 0);
    const insertions = Number((stat.match(/(\d+)\s+insertions?\(\+\)/) || [])[1] || 0);
    const deletions = Number((stat.match(/(\d+)\s+deletions?\(-\)/) || [])[1] || 0);
    commits.push({ at: head[0].trim(), message: clip(head.slice(1).join('\x1f').trim(), 300), files, insertions, deletions });
  }
  return commits;
}

export async function getCommits(dir, base) {
  const r = await git(['log', '--reverse', '--format=%x1e%cI%x1f%s', '--shortstat', `${base}..HEAD`], dir);
  if (r.code !== 0) return [];
  return parseGitLog(r.stdout);
}

/** 기준점 대비 작업 폴더 전체의 diff(새 파일 포함). 앞 200KB 까지 */
export async function getDiff(dir, base) {
  await git(['add', '-A', '-N'], dir); // 새 파일도 diff 에 나오게 한다(내용은 담지 않는다)
  const r = await git(['diff', '--no-color', '--no-ext-diff', base, '--', '.', ...DIFF_EXCLUDES], dir, { maxBytes: DIFF_MAX_BYTES + 1, killOnLimit: true, timeoutMs: 60_000 });
  const buf = Buffer.from(r.stdout, 'utf8');
  const truncated = r.truncated || buf.length > DIFF_MAX_BYTES;
  let diff = buf.length > DIFF_MAX_BYTES ? buf.subarray(0, DIFF_MAX_BYTES).toString('utf8') : r.stdout;
  if (truncated) diff = diff.replace(/�+$/, '');
  return { diff, truncated };
}

/* ───────────────────────── 테스트 결과 ───────────────────────── */

// node --test 의 spec 출력이 성공 줄 앞에 붙이는 표시 세 가지(실패 표시는 아래 정규식에 있다)
const SPEC_PASS = '\u2714\u2713\u221a';

/** 정규식에 넣기 전에 줄을 자르는 길이. 공백이 수만 자 이어진 줄에서 정규식이 제곱 시간으로 느려지는 것을 막는다(10/25 2차 검토) */
const OUTPUT_LINE_MAX = 500;
/** 값 비교 줄(「2 == 3」 「a !== b」) 모양 - 숨은 테스트의 기대값이 이 줄에 실려 나온다 */
const COMPARE_LINE = /!==|===|==|!=/;

/**
 * 실패 이유 줄들 -> 한 줄 message.
 * 보이는 테스트는 앞 세 줄을 이어 붙인다. 숨은 테스트는 첫 줄만 쓴다 - 둘째 줄부터는 「3 !== 4」처럼 기대값이 실려 나오고,
 * 리포트에 그대로 적히면 손님이 숨은 요구사항을 알아낼 수 있다. 첫 줄이 값 비교 모양(assert.equal 의 「2 == 3」)이면 그 줄도 쓰지 않는다.
 */
export function failMessage(lines, hidden = false) {
  const useful = (lines || []).map((l) => String(l).trim()).filter(Boolean);
  if (useful.length === 0) return '';
  if (!hidden) return clip(useful.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim(), 300);
  const first = useful[0];
  return COMPARE_LINE.test(first) ? '결과가 기대한 값과 다릅니다' : clip(first.replace(/\s+/g, ' '), 300);
}

/**
 * node --test 출력(spec · tap)을 해석한다. 모르는 줄은 건너뛴다.
 * 같은 이름이 두 번 나오면(실패 요약 등) 하나라도 실패면 실패.
 * tap 은 여러 줄 오류를 「error: |-」 아래 들여쓴 블록으로 쓴다(assert.strictEqual · deepEqual 이 실패한 경우). 그 블록을 모아 message 로 쓴다.
 */
export function parseTestOutput(raw, hidden = false) {
  const text = stripAnsi(raw);
  const byName = new Map();
  const order = [];
  const add = (name, passed, message) => {
    const n = name.trim();
    if (!n) return;
    const old = byName.get(n);
    if (old) {
      old.passed = old.passed && passed;
      if (message && !old.message) old.message = message;
    } else {
      const t = { name: n, passed, hidden };
      if (message) t.message = message;
      byName.set(n, t);
      order.push(n);
    }
  };

  let inFailSummary = false;
  let failName = null;
  let failLines = [];
  const flushFail = () => {
    if (failName && failLines.length) {
      const msg = failMessage(failLines, hidden);
      const t = byName.get(failName);
      if (t && !t.message && msg) t.message = msg;
    }
    failName = null;
    failLines = [];
  };

  let lastTapFail = null;
  // \u300cerror: |-\u300d \ube14\ub85d\uc744 \ubaa8\uc73c\ub294 \uc911\uc774\uba74 { name, indent, lines }. indent \ub294 error: \uc904\uc758 \ub4e4\uc5ec\uc4f0\uae30
  let tapBlock = null;
  const flushTapBlock = () => {
    if (tapBlock) {
      const msg = failMessage(tapBlock.lines, hidden);
      const t = byName.get(tapBlock.name);
      if (t && !t.message && msg) t.message = msg;
    }
    tapBlock = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.length > OUTPUT_LINE_MAX ? rawLine.slice(0, OUTPUT_LINE_MAX) : rawLine;
    if (tapBlock) {
      const indent = line.length - line.trimStart().length;
      // \ube48 \uc904\uc774\uac70\ub098 error: \ubcf4\ub2e4 \ub354 \ub4e4\uc5ec\uc4f4 \uc904\uc774\uba74 \ube14\ub85d \uc548\ucabd. \uac19\uac70\ub098 \ub35c \ub4e4\uc5ec\uc4f4 \uc904(code: \ub4f1)\uc5d0\uc11c \ube14\ub85d\uc774 \ub05d\ub098\uace0, \uadf8 \uc904\uc740 \uc544\ub798\uc5d0\uc11c \ub2e4\uc2dc \ubcf8\ub2e4
      if (!line.trim() || indent > tapBlock.indent) {
        tapBlock.lines.push(line);
        continue;
      }
      flushTapBlock();
    }
    if (/^\s*[\u2716\u2717\u00d7]\s+failing tests:/.test(line)) {
      inFailSummary = true;
      continue;
    }
    const spec = line.match(/^\s*([\u2714\u2713\u221a\u2716\u2717\u00d7])\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (spec) {
      const passed = SPEC_PASS.includes(spec[1]);
      if (inFailSummary && !passed) {
        flushFail();
        failName = spec[2].trim();
        if (!byName.has(failName)) add(failName, false);
      } else if (!inFailSummary) {
        add(spec[2], passed);
      }
      continue;
    }
    const tap = line.match(/^\s*(not ok|ok)\s+\d+\s*(?:-\s*)?(.*)$/);
    if (tap) {
      let name = tap[2];
      const directive = name.match(/\s+#\s*(SKIP|TODO)\b/i);
      if (directive) {
        lastTapFail = null;
        continue;
      }
      name = name.replace(/\s+#\s.*$/, '');
      const passed = tap[1] === 'ok';
      add(name, passed);
      lastTapFail = passed ? null : name.trim();
      continue;
    }
    if (lastTapFail) {
      const block = line.match(/^(\s*)error:\s*[|>][+-]?\s*$/);
      if (block) {
        tapBlock = { name: lastTapFail, indent: block[1].length, lines: [] };
        lastTapFail = null;
        continue;
      }
      const e = line.match(/^\s*error:\s*(.+)$/);
      if (e) {
        const t = byName.get(lastTapFail);
        const msg = failMessage([e[1].replace(/^['"]|['"]$/g, '')], hidden);
        if (t && !t.message && msg) t.message = msg;
        lastTapFail = null;
      }
    }
    if (inFailSummary && failName) {
      if (/^\s*test at /.test(line)) flushFail();
      else if (line.trim() && /^\s{2,}/.test(line)) failLines.push(line.trim());
    }
  }
  flushTapBlock();
  flushFail();
  return order.map((n) => byName.get(n));
}

/** 테스트 명령 한 번 돌리기. 실행 자체가 안 되면 실패 한 줄로 남긴다 */
export async function runTests({ command, cwd, hidden, timeoutMs, env }) {
  const r = await runCapture(command, [], { cwd, shell: true, timeoutMs: timeoutMs ?? 120_000, maxBytes: 4 * 1024 * 1024, env });
  const combined = `${r.stdout}\n${r.stderr}`;
  const tests = parseTestOutput(combined, hidden);
  if (r.timedOut) {
    tests.push({ name: '(테스트 실행)', passed: false, message: '시간 안에 끝나지 않았습니다', hidden });
  } else if (tests.length === 0 && r.code !== 0) {
    const firstLine = stripAnsi(combined).split('\n').map((l) => l.trim()).find(Boolean) || '테스트 명령이 실패했습니다';
    tests.push({ name: '(테스트 실행)', passed: false, message: clip(firstLine, 300), hidden });
  }
  return { tests, tail: tail(stripAnsi(combined).trim(), 3000), code: r.code, timedOut: r.timedOut };
}

/* ───────────────────────── 파일 ───────────────────────── */

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', 'dist', 'build', '.cache']);

/** assignment/ 안의 파일 목록(상대 경로, 크기). git · node_modules 등은 뺀다 */
export function listFiles(dir, max = 3000) {
  const out = [];
  const walk = (d, rel) => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), r);
      } else if (e.isFile() && !isSecretFile(r)) {
        try {
          out.push({ path: r, bytes: fs.statSync(path.join(d, e.name)).size });
        } catch {
          // 읽는 사이 지워졌다
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

/** 결과물 글: 정해진 경로의 파일만 읽는다. 합계 1MB 까지 */
export function readDeliverables(dir, paths, maxTotal = DELIVERABLES_MAX_BYTES) {
  const out = {};
  let used = 0;
  for (const p of paths || []) {
    let abs;
    try {
      abs = safeJoin(dir, p);
    } catch {
      continue;
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const room = maxTotal - used;
    if (room <= 0) break;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (Buffer.byteLength(text, 'utf8') > room) text = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8').replace(/�+$/, '');
    out[toPosix(p)] = text;
    used += Buffer.byteLength(text, 'utf8');
  }
  return out;
}

/* ───────────────────────── Skills · MCP · 셸 기록 ───────────────────────── */

function listNames(dir, label, max = 100) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.name.endsWith('.md')))
      .slice(0, max)
      .map((e) => `${label}/${e.name}`);
  } catch {
    return [];
  }
}

export function readSkills({ assignmentDir, workspaceDir, ...homeOpts }) {
  const homes = toolHomes(homeOpts);
  const out = [
    ...listNames(path.join(homes.claude, 'skills'), '~/.claude/skills'),
    ...listNames(path.join(homes.codex, 'skills'), '~/.codex/skills'),
    ...listNames(path.join(assignmentDir, '.claude', 'skills'), 'assignment/.claude/skills'),
  ];
  if (workspaceDir && path.resolve(workspaceDir) !== path.resolve(assignmentDir)) {
    out.push(...listNames(path.join(workspaceDir, '.claude', 'skills'), '.claude/skills'));
  }
  return out.slice(0, 200);
}

/** codex config.toml 에서 [mcp_servers...] 표만 뽑는다(순수) */
export function extractMcpToml(toml) {
  const kept = [];
  let inMcp = false;
  for (const line of String(toml || '').split(/\r?\n/)) {
    const h = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/);
    if (h) inMcp = h[1].startsWith('mcp_servers');
    if (inMcp) kept.push(line);
  }
  return kept.join('\n').trim();
}

export function readMcp({ assignmentDir, workspaceDir, ...homeOpts }) {
  const parts = [];
  const seen = new Set();
  const cands = [path.join(assignmentDir, '.mcp.json')];
  if (workspaceDir) cands.push(path.join(workspaceDir, '.mcp.json'));
  for (const f of cands) {
    const key = path.resolve(f);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const body = fs.readFileSync(f, 'utf8').trim();
      if (body) parts.push(`# ${path.basename(path.dirname(f)) || '.'}/.mcp.json\n${redactSecrets(body)}`);
    } catch {
      // 없으면 건너뛴다
    }
  }
  try {
    const toml = fs.readFileSync(path.join(toolHomes(homeOpts).codex, 'config.toml'), 'utf8');
    const mcp = extractMcpToml(toml);
    if (mcp) parts.push(`# ~/.codex/config.toml\n${redactSecrets(mcp)}`);
  } catch {
    // 없으면 건너뛴다
  }
  return parts.length ? clip(parts.join('\n\n'), 6000) : null;
}

function historyFiles({ env = process.env, home = os.homedir() } = {}) {
  const cands = [];
  if (env.HISTFILE) cands.push(env.HISTFILE);
  cands.push(path.join(home, '.bash_history'), path.join(home, '.zsh_history'));
  if (env.APPDATA) cands.push(path.join(env.APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'));
  return cands;
}

/** 시작할 때 셸 기록이 몇 줄이었는지 — 그 뒤에 친 줄만 이번 응시의 기록으로 보낸다 */
export function shellHistoryMark(opts = {}) {
  for (const f of historyFiles(opts)) {
    try {
      return { file: f, lines: fs.readFileSync(f, 'utf8').split(/\r?\n/).length };
    } catch {
      // 없는 파일
    }
  }
  return null;
}

/**
 * 셸 기록 마지막 200줄. 비밀 값은 가린다.
 * mark 가 있으면 시작한 뒤에 친 줄만(앞 과제의 npm test 가 이번 응시의 「테스트를 돌림」으로 섞이지 않게 — 10/25 검토).
 */
export function readShellHistory({ env = process.env, home = os.homedir(), mark = null } = {}) {
  for (const f of historyFiles({ env, home })) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    let raw = text.split(/\r?\n/);
    if (mark && mark.file === f && Number.isInteger(mark.lines) && mark.lines > 0 && mark.lines <= raw.length) raw = raw.slice(mark.lines - 1);
    const lines = raw
      .map((l) => l.replace(/^: \d+:\d+;/, '').trim())
      .filter((l) => l && !l.startsWith('#'))
      .slice(-200)
      .map((l) => clip(redactSecrets(l), 500));
    if (lines.length || mark) return lines;
  }
  return [];
}

/* ───────────────────────── 조립 ───────────────────────── */
// 작업 폴더 묶음(tar)은 1.1 부터 만들지 않는다 — 확인 문제와 채점은 이 manifest 만 읽는다(서버 cli/submit/init 410)

/** SubmitManifest 로 맞춘다(순수). 길이 · 개수 상한을 여기서 건다 */
// 서버(src/lib/ax-practice/server.ts sanitizeManifest)가 받는 개수와 같게 — 더 보내면 서버가 앞쪽만 남겨 최근 지시가 빠졌다(10/25 시스템 검토 #55)
const SEND_PROMPTS_HEAD = 50;
const SEND_PROMPTS_TAIL = 250;
const SEND_FILES_MAX = 2000;
const SEND_TESTS_MAX = 500;
/** 서버는 본문이 3MB 를 넘으면 413 으로 돌려보낸다. 여유를 두고 이 크기 안으로 줄여 보낸다 */
export const SEND_MAX_BYTES = 2_600_000;

/** 지시 글이 많으면 처음 몇 개와 최근 것을 남긴다(처음 지시와 마지막 마무리를 둘 다 본다) */
function keepHeadTail(list, head, tail) {
  return list.length <= head + tail ? list : [...list.slice(0, head), ...list.slice(list.length - tail)];
}

/**
 * 보낼 본문이 SEND_MAX_BYTES 를 넘으면 채점에 덜 쓰이는 것부터 줄인다 — 지시 글 길이, 지시 글 개수, 테스트 출력, 파일 목록, 변경 내용 순.
 * 결과물 글은 채점 대상이라 줄이지 않는다(서버가 결과물 합계 1MB 를 따로 본다).
 */
export function fitManifest(m, maxBytes = SEND_MAX_BYTES) {
  const size = () => Buffer.byteLength(JSON.stringify({ manifest: m }), 'utf8');
  if (size() <= maxBytes) return m;
  m.prompts = m.prompts.map((p) => ({ ...p, text: clip(p.text, 800) }));
  if (size() <= maxBytes) return m;
  m.prompts = keepHeadTail(m.prompts, 20, 130);
  if (size() <= maxBytes) return m;
  m.testOutputTail = tail(m.testOutputTail, 2000);
  m.shellHistory = m.shellHistory.slice(-80);
  if (size() <= maxBytes) return m;
  m.files = m.files.slice(0, 800);
  if (size() <= maxBytes) return m;
  const cut = Buffer.from(m.diff, 'utf8').subarray(0, 60_000).toString('utf8').replace(/�+$/, '');
  if (cut.length < m.diff.length) {
    m.diff = cut;
    m.diffTruncated = true;
  }
  return m;
}

export function assembleManifest(rawParts) {
  // NUL(\u0000)은 서버 DB 가 거부해서 제출 저장이 매번 실패한다. 비밀 가리기보다 먼저, 모든 글에서 지운다
  const parts = stripNul(rawParts || {});
  const diffBuf = Buffer.from(parts.diff || '', 'utf8');
  const diffTooLong = diffBuf.length > DIFF_MAX_BYTES;
  const diff = diffTooLong ? diffBuf.subarray(0, DIFF_MAX_BYTES).toString('utf8').replace(/�+$/, '') : parts.diff || '';
  // 비밀 값은 보내기 전에 가린다 — 변경 내용 · 지시 글 · 결과물 · 테스트 출력까지(10/25 검토). 서버도 한 번 더 가린다
  const prompts = keepHeadTail(
    [...(parts.prompts || [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    SEND_PROMPTS_HEAD,
    SEND_PROMPTS_TAIL,
  ).map((p) => ({ at: p.at, tool: p.tool, text: redactSecrets(clip(p.text, PROMPT_MAX_CHARS)) }));
  const deliverables = {};
  for (const [k, v] of Object.entries(parts.deliverables || {})) deliverables[k] = redactSecrets(v);
  return fitManifest({
    cliVersion: parts.cliVersion || CLI_VERSION,
    commits: (parts.commits || []).slice(0, 500).map((c) => ({ ...c, message: redactSecrets(c.message) })),
    diff: redactSecrets(diff),
    diffTruncated: Boolean(parts.diffTruncated) || diffTooLong,
    tests: (parts.tests || []).slice(0, SEND_TESTS_MAX).map((t) => {
      const row = { name: clip(t.name, 300), passed: Boolean(t.passed), hidden: Boolean(t.hidden) };
      if (t.message) row.message = redactSecrets(clip(t.message, 300));
      return row;
    }),
    testOutputTail: redactSecrets(tail(parts.testOutputTail || '', 6000)),
    files: (parts.files || []).slice(0, SEND_FILES_MAX),
    deliverables,
    prompts,
    usage: parts.usage || [],
    skills: (parts.skills || []).slice(0, 200),
    mcp: parts.mcp ?? null,
    shellHistory: (parts.shellHistory || []).slice(-200),
    bundleKey: null,
    bundleBytes: 0,
  });
}

// practice 명령: login · start · watch · submit · status
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  codeProblem,
  logPath,
  pidPath,
  practiceHome,
  readConfig,
  resolveServer,
  updateConfig,
  writeConfig,
} from './config.mjs';
import { PracticeError, request } from './http.mjs';
import {
  assembleManifest,
  getCommits,
  getDiff,
  initRepo,
  listFiles,
  readDeliverables,
  readMcp,
  readRepoSession,
  readShellHistory,
  readSkills,
  repoBaseline,
  runTests,
  shellHistoryMark,
} from './manifest.mjs';
import { collectSessions } from './sessions.mjs';
import { sysSnapshot } from './sys.mjs';
import { CLI_VERSION, HEARTBEAT_MS, fmtDuration, fmtTokens, safeJoin, sleep } from './util.mjs';

const TERMINAL_STATUS = new Set(['submitted', 'verifying', 'graded', 'expired']);

/** 시간 안에 제출하지 못해 끝난 응시(expired)를 가리키는 문장. 서버 · 연습실 창과 같은 말을 쓴다 */
export const EXPIRED_TEXT = '시간 안에 제출하지 못해 끝난 응시입니다. 내 과제에서 다시 풀 수 있습니다.';

/** status 가 보여 주는 한국어 상태 이름. 서버 상태값(영어)을 그대로 찍지 않는다 */
const STATUS_TEXT = {
  created: '시작 전',
  started: '진행 중',
  submitting: '제출을 올리는 중',
  submitted: '제출 완료',
  verifying: '확인 문제 진행 중',
  graded: '채점 끝',
  expired: '시간이 끝나 마감됨',
};

/**
 * 터미널에 질문을 하고 y · yes · 예 · 네 로 답하면 true. 그 밖의 답이나 Ctrl+C · Ctrl+D 는 false.
 * 시험에서는 ctx.confirm 을 통째로 바꿔 끼우거나, io 에 가짜 입출력을 준다.
 */
export function askYesNo(question, io = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.input || process.stdin, output: io.output || process.stdout });
    let done = false;
    const finish = (yes) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(yes);
    };
    rl.on('SIGINT', () => finish(false));
    rl.on('close', () => finish(false));
    rl.question(question, (answer) => finish(/^\s*(y|yes|예|네)\s*$/i.test(answer)));
  });
}

/** 명령이 쓰는 바깥 세계를 한 묶음으로. 시험에서는 일부를 바꿔 끼운다 */
export function makeContext(overrides = {}) {
  const ctx = {
    env: process.env,
    home: os.homedir(),
    cwd: process.cwd(),
    log: (m = '') => console.log(m),
    warn: (m = '') => console.error(m),
    fetch: globalThis.fetch,
    sleep,
    now: () => Date.now(),
    cliPath: fileURLToPath(new URL('../bin/practice.mjs', import.meta.url)),
    spawnWatch: null,
    // 사람이 앉아 있는 터미널인가. 아니면(뒤에서 도는 watch · 파이프) 질문하지 않는다
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: (question) => askYesNo(question),
    // 제출 한 번마다 새로 만드는 번호(서버가 같은 제출의 재시도를 알아보는 데 쓴다)
    randomId: () => randomUUID(),
    ...overrides,
  };
  if (!ctx.spawnWatch) ctx.spawnWatch = defaultSpawnWatch;
  return ctx;
}

const homeOpts = (ctx) => ({ env: ctx.env, home: ctx.home });
const parseTime = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/* ───────────────────────── 위치 ───────────────────────── */

/** 작업 공간 폴더를 못 찾았을 때 손님에게 보이는 안내 */
export const NO_WORKSPACE_TEXT = '작업 공간 폴더(.devcontainer 가 있는 곳)에서 실행해 주세요. 보통은 새 터미널을 열면 됩니다.';

/**
 * 작업 공간 폴더(assignment 나 .devcontainer 가 있는 곳)를 찾는다. 환경 변수 > 설정 > 현재 폴더에서 위로 6단계.
 * 못 찾으면 null - 예전에는 현재 폴더를 돌려줘서 홈(cd ~)에서 practice start 를 치면 저장소 밖에 assignment 가 만들어졌다(10/25 2차 검토).
 */
export function resolveWorkspace(ctx, cfg) {
  if (ctx.env.PRACTICE_WORKSPACE) return path.resolve(ctx.env.PRACTICE_WORKSPACE);
  if (cfg && cfg.workspace && fs.existsSync(cfg.workspace)) return cfg.workspace;
  let dir = ctx.cwd;
  for (let i = 0; i < 6; i++) {
    const hasAssignment = fs.existsSync(path.join(dir, 'assignment')) && fs.statSync(path.join(dir, 'assignment')).isDirectory();
    if (hasAssignment || fs.existsSync(path.join(dir, '.devcontainer'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export const assignmentOf = (workspace) => path.join(workspace, 'assignment');

/* ───────────────────────── 뒤에서 도는 watch ───────────────────────── */

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

/**
 * 그 프로그램이 켜진 시각(리눅스의 /proc/<번호>/stat 22번째 값). 읽을 수 없는 곳(윈도 · 맥)은 null.
 * 작업 공간이 멈췄다 켜지면 옛 번호를 전혀 다른 프로그램이 쓸 수 있다. 번호만 보면 그 프로그램을 우리 것으로 착각하고
 * 지켜보는 프로그램을 새로 켜지 않아 마감 자동 제출이 안 일어난다(10/25 검토). 번호와 시작 시각을 함께 적어 두고 둘 다 맞아야 산 것으로 본다.
 */
function startTicks(pid) {
  try {
    return parseStatTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * /proc/<번호>/stat 글에서 켜진 시각(22번째 값)을 뽑는다(순수). 이름 칸이 괄호로 싸여 있고 그 안에 공백이나 괄호가 있을 수 있어서
 * 마지막 「)」 뒤부터 센다. 윈도 개발 PC 에서도 시험할 수 있게 파일 읽기와 나눴다.
 */
export function parseStatTicks(stat) {
  const s = String(stat ?? '');
  const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return rest[19] || null;
}

/** pid 파일 · 제출 잠금에 적는 글. 「번호」 또는 「번호:시작 시각」. ticksOf 는 시험에서 바꿔 끼운다 */
export function pidRecord(pid, ticksOf = startTicks) {
  const t = ticksOf(pid);
  return t ? `${pid}:${t}` : String(pid);
}

function readPidRecord(file) {
  try {
    const [p, t] = fs.readFileSync(file, 'utf8').trim().split(':');
    const pid = Number(p);
    return Number.isInteger(pid) && pid > 0 ? { pid, ticks: t || null } : null;
  } catch {
    return null;
  }
}

/** 적어 둔 프로그램이 지금도 그 프로그램인지. deps 는 시험에서 바꿔 끼운다 */
export function recordAlive(rec, deps = {}) {
  const aliveFn = deps.isAlive || isAlive;
  const ticksOf = deps.startTicks || startTicks;
  if (!rec || !aliveFn(rec.pid)) return false;
  if (!rec.ticks) return true;
  const now = ticksOf(rec.pid);
  return now === null || now === rec.ticks;
}

export function watchPid(ctx) {
  const rec = readPidRecord(pidPath(homeOpts(ctx)));
  return rec && rec.pid !== process.pid && recordAlive(rec) ? rec.pid : null;
}

function defaultSpawnWatch(ctx) {
  fs.mkdirSync(practiceHome(homeOpts(ctx)), { recursive: true });
  const fd = fs.openSync(logPath(homeOpts(ctx)), 'a');
  const child = spawn(process.execPath, [ctx.cliPath, 'watch'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: ctx.env,
    cwd: ctx.cwd,
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function ensureWatch(ctx) {
  const pid = watchPid(ctx);
  if (pid) return { started: false, pid };
  try {
    const newPid = ctx.spawnWatch(ctx);
    return { started: true, pid: newPid ?? null };
  } catch (e) {
    ctx.warn(`  지켜보는 프로그램(practice watch)을 뒤에서 켜지 못했습니다. 터미널을 하나 더 열어 practice watch 를 직접 실행해 주세요. (${e && e.message ? e.message : e})`);
    return { started: false, pid: null };
  }
}

/* ───────────────────────── login ───────────────────────── */

export async function login(ctx, args = []) {
  const code = String(args.find((a) => !a.startsWith('-')) || '').trim();
  const problem = codeProblem(code);
  if (problem) throw new PracticeError(problem);

  const prev = readConfig(homeOpts(ctx));
  const server = resolveServer(prev, ctx);
  const data = await request(ctx, { server }, 'POST', '/cli/login', { code }, { auth: false });
  if (!data || !data.sessionId) throw new PracticeError('서버 응답에 세션 정보가 없습니다. 잠시 뒤 다시 시도해 주세요.');

  // 같은 세션으로 다시 로그인하면 진행 기록을 이어 가고, 다른 세션이면 새로 시작한다
  const same = prev.sessionId === data.sessionId;
  const cfg = {
    ...(same ? prev : {}),
    server,
    token: code,
    sessionId: data.sessionId,
    task: data.task || null,
    status: data.status || null,
    deadlineAt: data.deadlineAt || null,
    panelUrl: data.panelUrl || null,
    loggedInAt: new Date(ctx.now()).toISOString(),
  };
  writeConfig(cfg, homeOpts(ctx));

  const title = data.task && data.task.title ? data.task.title : '과제';
  const minutes = data.task && data.task.minutes ? ` (${data.task.minutes}분)` : '';
  ctx.log(`연결됐습니다. 과제: ${title}${minutes}`);
  if (String(data.status) === 'expired') {
    // 시간 안에 못 낸 응시를 「제출한 과제」라고 부르면 안 된다
    ctx.log(EXPIRED_TEXT);
  } else if (TERMINAL_STATUS.has(String(data.status))) {
    // 끝난 과제에 start 안내를 하면 시계를 다시 켤 수 있는 것처럼 읽힌다
    ctx.log('이미 제출한 과제입니다. 연습실 창으로 돌아가 확인 문제를 푸세요.');
  } else if (cfg.startedAt) {
    ctx.log('이미 시작한 과제입니다. 상태는 practice status 로 볼 수 있습니다.');
    // 새 코드로 다시 로그인한 경우 - 옛 코드로 돌던 지켜보는 프로그램이 이미 멈췄을 수 있으니 켜져 있는지 본다
    if (ensureWatch(ctx).started) ctx.log('  지켜보는 프로그램(practice watch)을 다시 켰습니다.');
  } else if (data.status && String(data.status) !== 'created') {
    // 서버에서는 이미 시작됐는데 이 PC 설정에는 시작 기록이 없다 - 작업 공간을 다시 만든 뒤 같은 코드로 로그인한 경우
    ctx.log('이미 시작된 응시입니다. practice start 를 실행하면 하던 작업을 이어서 받습니다. 시간은 처음 시작한 때부터 흐르고 있고, 새로 시작되지 않습니다.');
  } else {
    // 1.4 부터 지켜보는 프로그램을 로그인 직후 켠다 — 연습실 창의 「과제 시작」을 누르면 이 프로그램이 시작 명령을 대신 돈다(실제 2차의 단추와 같은 자리)
    const w = ensureWatch(ctx);
    ctx.log(w.pid ? '연습실 창에서 "과제 시작"을 누르면 이 작업 공간이 과제를 받고 시간이 흐르기 시작합니다.' : '준비가 됐으면 practice start 를 실행하세요. 이 명령을 실행하는 순간부터 시간이 흐릅니다.');
    if (w.pid) ctx.log('터미널에서 practice start 를 실행해도 같습니다. 어느 쪽이든 그 순간부터 시간이 흐릅니다.');
  }
  return cfg;
}

/* ───────────────────────── start ───────────────────────── */

export async function start(ctx, args = []) {
  const force = args.includes('--force');
  let cfg = readConfig(homeOpts(ctx));
  if (!cfg.token || !cfg.sessionId) throw new PracticeError('먼저 연습실 창에서 접속 코드를 받아 practice login <코드> 를 실행해 주세요.');

  const workspace = resolveWorkspace(ctx, cfg);
  // 작업 공간을 못 찾으면 현재 폴더에 assignment 를 만들지 않고 멈춘다(홈에서 쳤을 때 저장소 밖에 과제가 풀리던 문제)
  if (!workspace) throw new PracticeError(NO_WORKSPACE_TEXT);
  const dir = assignmentOf(workspace);
  fs.mkdirSync(dir, { recursive: true });
  cleanupHidden(ctx);

  // 서버에서는 이미 시작한 응시인데 이 PC 의 설정에는 시작 기록이 없는 경우 - 작업 공간을 다시 만들어 ~/.practice 가 사라진 뒤 같은 코드로 login 한 때.
  // 이때 assignment 에 남은 폴더는 진행 중인 작업이라 보관 폴더로 치우면 안 된다(10/25 2차 검토)
  const serverStarted = !cfg.startedAt && Boolean(cfg.status) && String(cfg.status) !== 'created';
  let resume = false;

  // 1) 앞 과제 폴더 정리 — 시계를 켜기 전에 한다(여기서 막혀도 시간이 흐르지 않게)
  if (!cfg.startedAt && !cfg.baseline) {
    const leftover = fs.readdirSync(dir).filter((n) => n !== '.gitkeep');
    if (leftover.length > 0 && serverStarted && !force && leftover.includes('.git')) {
      // practice 가 이 응시를 위해 만든 폴더(저장소 설정에 응시 번호가 적혀 있다)면 그대로 이어 쓰고, 아니면 함부로 치우지 않고 멈춘다
      const sameRun = (await readRepoSession(dir)) === cfg.sessionId && Boolean(await repoBaseline(dir));
      if (!sameRun) {
        throw new PracticeError(
          '서버에서는 이미 시작된 응시인데, assignment 폴더가 이 응시의 파일로 보이지 않습니다. 있던 파일을 ~/.practice/archive 로 옮기고 과제 파일을 다시 받으려면 practice start --force 를 실행해 주세요.',
        );
      }
      resume = true;
      ctx.log('  서버에서는 이미 시작된 응시입니다. assignment 폴더에 있던 작업을 그대로 두고 이어서 진행합니다.');
    } else if (leftover.length > 0 && (force || leftover.includes('.git'))) {
      // 같은 작업 공간에서 다음 과제를 하면 앞 과제 폴더가 남아 있다. practice 가 만든 폴더(.git 이 있다)면 지우지 않고 옮겨 둔다
      const archived = archiveAssignment(ctx, dir);
      ctx.log(`  앞 과제 파일은 ${archived} 로 옮겨 두었습니다.`);
    } else if (leftover.length > 0) {
      throw new PracticeError(
        'assignment 폴더가 비어 있지 않습니다. 이전에 받은 파일이면 practice start --force 로 다시 받습니다(있던 파일은 ~/.practice/archive 로 옮겨 둡니다).',
      );
    }
  }

  // 2) 시계 시작 — 과제 파일은 시계를 켠 뒤에만 받을 수 있다(서버가 막는다. 환불 기준 「내려받아 시간이 시작된 때」와 맞추려고)
  if (!cfg.startedAt) {
    const s = await request(ctx, cfg, 'POST', '/cli/start', {});
    // 셸 기록이 지금 몇 줄인지 적어 두고, 제출 때는 그 뒤에 친 줄만 보낸다
    cfg = updateConfig({ startedAt: s.startedAt, deadlineAt: s.deadlineAt, status: 'started', histMark: shellHistoryMark(homeOpts(ctx)) }, homeOpts(ctx));
    ctx.log(serverStarted ? '서버에 기록된 처음 시작 시각을 불러왔습니다. 시간은 그때부터 흐르고 있습니다.' : '시간이 시작됐습니다.');
  } else {
    ctx.log('이미 시작한 과제입니다. 이어서 진행합니다.');
  }

  // 3) 과제 파일 받기 + git 기준점 (이미 했으면 건너뛴다. 받다가 끊겼으면 practice start 로 다시 받는다)
  if (!cfg.baseline) {
    ctx.log(resume ? '과제 정보를 받고 있습니다.' : '과제 파일을 받고 있습니다.');
    const task = await request(ctx, cfg, 'GET', '/cli/task');
    const files = Array.isArray(task.files) ? task.files : [];
    if (files.length === 0) throw new PracticeError('서버가 과제 파일을 주지 않았습니다. 잠시 뒤 practice start 를 다시 실행해 주세요.');
    let baseline;
    if (resume) {
      // 이어 쓰는 폴더는 파일을 다시 쓰지 않는다. 처음 만든 기준점 커밋을 그대로 기준으로 삼는다
      baseline = await repoBaseline(dir);
      if (!baseline) throw new PracticeError('assignment 폴더의 시작 기준점을 찾지 못했습니다. practice start --force 로 과제 파일을 다시 받아 주세요.');
    } else {
      for (const f of files) {
        const abs = safeJoin(dir, f.path);
        if (toTop(f.path) === '.git') throw new PracticeError('쓸 수 없는 파일 경로입니다: .git');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, typeof f.content === 'string' ? f.content : '', 'utf8');
      }
      baseline = await initRepo(dir, cfg.sessionId);
    }
    cfg = updateConfig(
      {
        workspace,
        baseline,
        testCommand: task.testCommand || null,
        deliverables: Array.isArray(task.deliverables) ? task.deliverables : [],
        hasHidden: task.hasHidden === true,
      },
      homeOpts(ctx),
    );
    ctx.log(resume ? '  assignment/ 의 작업을 그대로 이어 갑니다.' : `  ${files.length}개 파일을 assignment/ 에 풀었습니다.`);
  } else if (!cfg.workspace) {
    cfg = updateConfig({ workspace }, homeOpts(ctx));
  }

  // 4) 사용량과 제출 요청을 지켜보는 프로그램
  const w = ensureWatch(ctx);
  ctx.log(w.started ? '  지켜보는 프로그램(practice watch)을 뒤에서 켰습니다. 사용량을 보내고 제출 요청을 기다립니다.' : '  지켜보는 프로그램(practice watch)이 이미 켜져 있습니다.');

  const deadline = parseTime(cfg.deadlineAt);
  if (deadline) ctx.log(`남은 시간: ${fmtDuration(deadline - ctx.now())}`);
  ctx.log('');
  // 과제 파일은 모두 assignment 폴더에 풀린다. 루트에서 npm 이나 codex 를 쓰면 package.json 이 없고, 결과물도 제출 폴더 밖에 만들어진다
  if (inAssignment(ctx, dir)) {
    ctx.log('지금 터미널이 assignment 폴더 안이라 바로 codex 를 실행하면 됩니다.');
  } else {
    ctx.log('작업은 assignment 폴더 안에서 합니다. 먼저 cd assignment 를 한 번 실행하고, 그 폴더에서 codex 를 실행하세요.');
  }
  ctx.log('assignment/README.md 부터 읽어 보세요. 일을 맡긴 업무 담당자에게는 연습실 창 오른쪽 대화에서 물어볼 수 있습니다.');
  ctx.log('다 끝났으면 연습실 창의 "제출하고 문제풀기"를 누르세요. 직접 내려면 practice submit 입니다.');
  return cfg;
}

const toTop = (p) => String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.')[0];

/** 지금 터미널 위치가 assignment 폴더(또는 그 안)인지 */
function inAssignment(ctx, dir) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(dir), real(ctx.cwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** assignment/ 안의 것을 ~/.practice/archive/<시각>/ 으로 옮기고 그 경로를 돌려준다(.gitkeep 은 남긴다) */
function archiveAssignment(ctx, dir) {
  const stamp = new Date(ctx.now()).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(practiceHome(homeOpts(ctx)), 'archive', stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name === '.gitkeep') continue;
    const from = path.join(dir, name);
    const to = path.join(dest, name);
    try {
      fs.renameSync(from, to);
    } catch {
      // 다른 디스크면 rename 이 안 된다 — 복사 뒤 지운다
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  }
  return dest;
}

/* ───────────────────────── watch ───────────────────────── */

/** 하트비트 응답을 보고 다음 행동을 정한다(순수) */
export function decideWatch(res, { submittedLocally = false } = {}) {
  const status = res && res.status ? String(res.status) : '';
  if (TERMINAL_STATUS.has(status) || submittedLocally) return 'stop';
  if (res && (res.submitRequested || status === 'submitting')) return 'submit';
  const now = res ? parseTime(res.now) : null;
  const deadline = res ? parseTime(res.deadlineAt) : null;
  if (now !== null && deadline !== null && now >= deadline && status === 'started') return 'submit';
  return 'wait';
}

/** 접속 코드 문제로 서버가 거절한 응답(401, 403, 404). 이 응답이 계속 오면 기다려도 풀리지 않는다 */
const isRejection = (e) => Boolean(e && (e.status === 401 || e.status === 403 || e.status === 404));
/** 같은 거절이 연달아 이만큼 오면 지켜보기를 멈춘다(30초 간격이면 1분 30초) */
export const REJECT_LIMIT = 3;
/** 마감이 지나고 이 시간이 지나면 서버도 접속 코드를 거둔다(AXP_LIMITS.codeTtlAfterDeadlineMs) */
const GIVE_UP_AFTER_DEADLINE_MS = 2 * 60 * 60 * 1000;

export async function watch(ctx, args = [], opts = {}) {
  let cfg = readConfig(homeOpts(ctx));
  if (!cfg.token) {
    ctx.warn('아직 연결한 과제가 없습니다. practice login 을 먼저 실행해 주세요.');
    return { ticks: 0, submitted: false };
  }
  const other = watchPid(ctx);
  if (other) {
    ctx.log(`지켜보는 프로그램(practice watch)이 이미 켜져 있습니다 (pid ${other}).`);
    return { ticks: 0, submitted: false };
  }
  fs.mkdirSync(practiceHome(homeOpts(ctx)), { recursive: true });
  fs.writeFileSync(pidPath(homeOpts(ctx)), pidRecord(process.pid));

  const envInterval = Number(ctx.env.PRACTICE_HEARTBEAT_MS);
  const interval = opts.intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : HEARTBEAT_MS);
  const maxTicks = opts.maxTicks ?? Infinity;
  let ticks = 0;
  let submitted = false;
  ctx.log(`지켜보는 프로그램(practice watch)을 시작합니다 (${Math.round(interval / 1000)}초마다).`);
  let rejected = 0;
  let cpuPrev = null;
  let startFail = '';

  try {
    while (ticks < maxTicks) {
      ticks += 1;
      cfg = readConfig(homeOpts(ctx));
      // 시작 전에도 돈다(1.4) — 사용량은 보내지 않고 연결 표시와 「과제 시작」 요청만 본다
      const preStart = !cfg.startedAt;
      const since = parseTime(cfg.startedAt) || 0;
      // 마감 뒤 2시간이 지나면 서버가 접속 코드를 거둔다. 그때까지 제출이 안 됐으면 더 돌아도 할 수 있는 일이 없다
      const due = parseTime(cfg.deadlineAt);
      if (due !== null && ctx.now() > due + GIVE_UP_AFTER_DEADLINE_MS) {
        ctx.log('마감 시간이 2시간 넘게 지나 지켜보는 프로그램(practice watch)을 마칩니다.');
        break;
      }
      let res = null;
      try {
        const usage = preStart ? [] : collectSessions({ ...homeOpts(ctx), sinceMs: since }).usage;
        // CPU · 메모리를 읽다 실패해도 하트비트를 막지 않는다
        let sys;
        try {
          const s = (ctx.sysSnapshot || sysSnapshot)(cpuPrev);
          cpuPrev = s.cur;
          sys = s.sys;
        } catch {
          sys = undefined;
        }
        res = await request(ctx, cfg, 'POST', '/cli/heartbeat', { usage, ...(sys ? { sys } : {}) }, { retries: 1 });
        updateConfig(
          { deadlineAt: res.deadlineAt || cfg.deadlineAt, status: res.status || cfg.status, lastHeartbeatAt: new Date(ctx.now()).toISOString() },
          homeOpts(ctx),
        );
        rejected = 0;
      } catch (e) {
        // 서버가 이 도구 판이 너무 낮다고 하면 기다려도 풀리지 않는다. 서버 문장(새 판을 받는 방법)을 남기고 멈춘다
        if (e && e.body && e.body.code === 'CLI_OUTDATED') {
          ctx.warn(`${e.message} 지켜보는 프로그램(practice watch)은 여기서 마칩니다.`);
          break;
        }
        ctx.warn(`[${new Date(ctx.now()).toLocaleTimeString('ko-KR')}] 서버와 연결이 안 됩니다. 다음 확인 때 다시 시도합니다. (${e && e.message ? e.message : e})`);
        // 접속 코드가 무효가 된 경우(새 코드를 받았거나 환불) 같은 거절이 영원히 이어진다. 연달아 오면 안내를 남기고 멈춘다
        rejected = isRejection(e) ? rejected + 1 : 0;
        if (rejected >= REJECT_LIMIT) {
          ctx.warn('서버가 접속 코드를 계속 받아 주지 않아 지켜보는 프로그램(practice watch)을 마칩니다. 연습실 창에서 새 코드를 받았다면 practice login 새 코드 를 다시 실행하세요.');
          break;
        }
      }

      // 연습실 창에서 「과제 시작」을 눌렀다 — practice start 와 같은 순서를 여기서 돈다. 실패하면 다음 확인 때 다시 하고, 같은 안내는 한 번만 남긴다
      if (res && preStart && res.startRequested && !readConfig(homeOpts(ctx)).startedAt) {
        ctx.log('연습실 창에서 과제 시작을 눌렀습니다. 과제를 받습니다.');
        try {
          await start(ctx, []);
          startFail = '';
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          if (msg !== startFail) ctx.warn(`과제를 받지 못했습니다. 다음 확인 때 다시 시도합니다. 터미널에서 practice start 를 직접 실행해도 됩니다. (${msg})`);
          startFail = msg;
        }
      }

      if (res) {
        const action = decideWatch(res, { submittedLocally: Boolean(readConfig(homeOpts(ctx)).submittedAt) });
        if (action === 'stop') {
          ctx.log('제출이 끝났거나 마감된 과제입니다. 지켜보는 프로그램(practice watch)을 마칩니다.');
          break;
        }
        if (action === 'submit') {
          ctx.log(res.submitRequested ? '연습실 창에서 제출을 요청했습니다. 지금 제출합니다.' : '마감 시간이 됐습니다. 지금 제출합니다.');
          try {
            await submit(ctx, [], { auto: true });
            submitted = true;
            break;
          } catch (e) {
            ctx.warn(`제출하지 못했습니다. 다음 확인 때 다시 시도합니다. (${e && e.message ? e.message : e})`);
          }
        }
      }
      if (ticks < maxTicks) await ctx.sleep(interval);
    }
  } finally {
    try {
      const mine = readPidRecord(pidPath(homeOpts(ctx)));
      if (mine && mine.pid === process.pid) fs.unlinkSync(pidPath(homeOpts(ctx)));
    } catch {
      // 이미 지워졌다
    }
  }
  return { ticks, submitted };
}

/* ───────────────────────── submit ───────────────────────── */

const lockPath = (ctx) => path.join(practiceHome(homeOpts(ctx)), 'submit.lock');
const hiddenMarkPath = (ctx) => path.join(practiceHome(homeOpts(ctx)), 'hidden-written.json');

/**
 * 제출은 한 번에 하나만 — 터미널의 practice submit 과 뒤에서 도는 watch 의 자동 제출이 겹치면
 * 숨은 테스트 파일을 서로 덮어써 남기거나 결과를 덮었다(10/25 검토). 잡은 프로그램이 죽었으면 그 잠금은 버린다.
 */
function acquireLock(ctx) {
  fs.mkdirSync(practiceHome(homeOpts(ctx)), { recursive: true });
  const p = lockPath(ctx);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(p, 'wx');
      fs.writeSync(fd, pidRecord(process.pid));
      fs.closeSync(fd);
      return p;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const holder = readPidRecord(p);
      if (holder && holder.pid !== process.pid && recordAlive(holder)) {
        throw new PracticeError(
          '다른 제출이 진행 중입니다. 연습실 창에서 요청한 제출이 뒤에서 돌고 있을 수 있습니다. 끝나면 연습실 창이 제출 확인 화면으로 바뀝니다. 진행은 tail -n 20 ~/.practice/watch.log 로 볼 수 있습니다.',
          { status: 423, body: { code: 'LOCKED' } },
        );
      }
      try {
        fs.unlinkSync(p);
      } catch {
        // 다른 쪽이 먼저 지웠다
      }
    }
  }
  throw new PracticeError('제출을 시작하지 못했습니다. 잠시 뒤 다시 해 주세요.');
}

function releaseLock(p) {
  try {
    const mine = readPidRecord(p);
    if (mine && mine.pid === process.pid) fs.unlinkSync(p);
  } catch {
    // 이미 없다
  }
}

/** 써 둔 숨은 테스트 파일을 원래대로 — 있던 파일은 되살리고 새로 쓴 파일은 지운다 */
function restoreWritten(dir, written) {
  for (const w of [...written].reverse()) {
    try {
      if (w.prior !== null) fs.writeFileSync(w.abs, Buffer.from(w.prior, 'base64'));
      else if (fs.existsSync(w.abs)) fs.unlinkSync(w.abs);
      let parent = path.dirname(w.abs);
      while (parent !== dir && path.relative(dir, parent) && !path.relative(dir, parent).startsWith('..')) {
        if (fs.readdirSync(parent).length > 0) break;
        fs.rmdirSync(parent);
        parent = path.dirname(parent);
      }
    } catch {
      // 되돌리기에 실패해도 제출은 계속한다
    }
  }
}

/** 지난 제출이 중간에 끊겨(Ctrl+C · 터미널 닫힘) 숨은 테스트 파일이 남았으면 치운다 */
export function cleanupHidden(ctx) {
  const mark = hiddenMarkPath(ctx);
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(mark, 'utf8'));
  } catch {
    return false;
  }
  if (saved && typeof saved.dir === 'string' && Array.isArray(saved.written)) restoreWritten(saved.dir, saved.written);
  try {
    fs.unlinkSync(mark);
  } catch {
    // 이미 없다
  }
  return true;
}

/**
 * 숨은 테스트 파일을 잠깐 넣었다가 원래대로 되돌린다.
 * 넣은 목록을 ~/.practice/hidden-written.json 에 먼저 적어 두고, Ctrl+C 로 끊겨도 되돌린 뒤 끝낸다.
 * 프로그램이 통째로 죽은 경우는 다음 start · submit 이 cleanupHidden 으로 치운다.
 */
async function withFiles(ctx, dir, files, fn) {
  const written = [];
  const mark = hiddenMarkPath(ctx);
  const done = () => {
    restoreWritten(dir, written);
    written.length = 0;
    try {
      fs.unlinkSync(mark);
    } catch {
      // 이미 없다
    }
  };
  const onSignal = () => {
    done();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    for (const f of files) {
      const abs = safeJoin(dir, f.path);
      if (toTop(f.path) === '.git') continue;
      const prior = fs.existsSync(abs) ? fs.readFileSync(abs).toString('base64') : null;
      written.push({ abs, prior });
      fs.writeFileSync(mark, JSON.stringify({ dir, written }));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof f.content === 'string' ? f.content : '', 'utf8');
    }
    return await fn();
  } finally {
    done();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export async function submit(ctx, args = [], opts = {}) {
  let cfg = readConfig(homeOpts(ctx));
  if (!cfg.token || !cfg.sessionId) throw new PracticeError('먼저 practice login <코드> 를 실행해 주세요.');
  if (!cfg.startedAt || !cfg.baseline) throw new PracticeError('아직 시작하지 않았습니다. practice start 를 먼저 실행해 주세요.');
  if (cfg.submittedAt && !args.includes('--again')) {
    ctx.log('이미 제출했습니다. 연습실 창으로 돌아가 확인 문제를 푸세요. 확인 문제를 시작하기 전이면 고친 뒤 practice submit --again 으로 다시 올릴 수 있습니다.');
    return { ok: true, already: true, panelUrl: cfg.panelUrl || null };
  }

  const workspace = resolveWorkspace(ctx, cfg);
  if (!workspace) throw new PracticeError(NO_WORKSPACE_TEXT);
  const dir = assignmentOf(workspace);
  if (!fs.existsSync(dir)) throw new PracticeError('assignment 폴더를 찾지 못했습니다. 작업 공간의 맨 위 폴더에서 실행해 주세요.');

  // 제출을 요청하는 순간 담당자 대화가 닫히고 되돌릴 수 없다. 사람이 친 처음 제출이면 한 번 묻는다(연습실 창의 단추도 같은 확인창을 띄운다).
  // 뒤에서 도는 watch 의 자동 제출, --yes, 이미 낸 뒤의 --again, 사람이 없는 터미널(파이프)에서는 묻지 않는다
  if (!opts.auto && ctx.isTTY && !cfg.submittedAt && !args.includes('--yes') && !args.includes('-y')) {
    const yes = await ctx.confirm('제출을 요청하면 담당자와 과제 도우미에게 더 물을 수 없고, 되돌릴 수 없습니다. 계속할까요? (y/N) ');
    if (!yes) {
      ctx.log('제출하지 않았습니다. 다 끝났을 때 practice submit 을 다시 실행하세요. 묻지 않고 바로 내려면 practice submit --yes 입니다.');
      return { ok: false, cancelled: true, already: false, panelUrl: cfg.panelUrl || null };
    }
  }

  const lock = acquireLock(ctx);
  try {
    cleanupHidden(ctx);
    const since = parseTime(cfg.startedAt) || 0;
    const steps = 7;
    let step = 0;
    const say = (m) => ctx.log(`[${++step}/${steps}] ${m}`);
    // 이번 제출 한 번의 번호. 응답이 끊겨 같은 본문을 다시 보내도 같은 번호라 서버가 재제출로 세지 않는다
    const submitId = ctx.randomId();

    // 제출 요청 — 연습실 창의 단추와 같다. 이때부터 담당자 대화가 닫히고 확인용 테스트를 받을 수 있다
    say('제출을 요청합니다');
    try {
      await request(ctx, cfg, 'POST', '/cli/submit-request', {}, { retries: 2 });
    } catch (e) {
      // 이미 제출한 응시를 --again 으로 다시 내는 경우는 그대로 이어 간다(서버가 확인 문제 전까지 받아 준다)
      if (!(e instanceof PracticeError && e.body && e.body.code === 'SUBMITTED')) throw e;
      // 서버가 알려 준 상태가 제출 완료(submitted)가 아니면 확인 문제가 이미 시작됐거나 끝난 것이다. 테스트를 2분 돌린 뒤에 틀린 안내를 보이지 않게 여기서 멈춘다
      const serverStatus = typeof e.body.status === 'string' ? e.body.status : '';
      if (serverStatus && serverStatus !== 'submitted') {
        throw new PracticeError(serverStatus === 'expired' ? EXPIRED_TEXT : '확인 문제가 이미 시작돼 다시 낼 수 없습니다.', { status: e.status, body: e.body });
      }
    }

    // 보이는 테스트
    let tests = [];
    const tails = [];
    say(cfg.testCommand ? `테스트를 돌립니다 (${cfg.testCommand})` : '이 과제는 테스트 명령이 없어 건너뜁니다');
    if (cfg.testCommand) {
      const r = await runTests({ command: cfg.testCommand, cwd: dir, hidden: false, env: ctx.env });
      tests = tests.concat(r.tests);
      tails.push(`# 보이는 테스트\n${r.tail}`);
    }

    // 커밋과 diff
    say('작업 내용(커밋과 변경 내용)을 모읍니다');
    const commits = await getCommits(dir, cfg.baseline);
    const { diff, truncated } = await getDiff(dir, cfg.baseline);

    // 확인용 테스트 — 못 받으면 제출을 멈춘다. 없이 내면 숨은 요구사항이 모두 못 맞춘 것으로 채점된다(10/25 검토)
    say('확인용 테스트를 받아 돌립니다');
    let hidden;
    try {
      hidden = await request(ctx, cfg, 'GET', '/cli/hidden-tests', undefined, { retries: 2 });
    } catch (e) {
      // 이미 끝난 연습(409)이나 아직 받을 수 없는 때(403)는 잠시 뒤에 해도 달라지지 않는다. 다시 해 보라고 하지 않는다
      const retryable = !(e && e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429);
      const why = e && e.message ? e.message : String(e);
      throw new PracticeError(`확인용 테스트를 받지 못해 제출을 멈췄습니다. ${why}${retryable ? ' practice submit 을 다시 실행해 주세요.' : ''}`, {
        status: e && e.status,
        body: e && e.body,
      });
    }
    const hfiles = Array.isArray(hidden.files) ? hidden.files : [];
    let ranHidden = false;
    if (hfiles.length && hidden.command) {
      const r = await withFiles(ctx, dir, hfiles, () => runTests({ command: hidden.command, cwd: dir, hidden: true, env: ctx.env, timeoutMs: 180_000 }));
      ranHidden = true;
      tests = tests.concat(r.tests);
      tails.push(`# 확인용 테스트\n${r.tail}`);
    } else if (cfg.hasHidden) {
      throw new PracticeError('확인용 테스트가 비어 있어 제출을 멈췄습니다. 잠시 뒤 practice submit 을 다시 실행해 주세요. 계속 같으면 연습실 창의 문제 신고로 알려 주세요.');
    } else {
      ctx.log('  이 과제에는 확인용 테스트가 없습니다.');
    }

    // 파일 · 결과물 · AI 기록 (비밀이 들기 쉬운 .env 같은 파일은 목록에서 빼고, 비밀 값은 가려서 보낸다)
    say('파일과 결과물을 읽습니다');
    const files = listFiles(dir);
    const deliverables = readDeliverables(dir, cfg.deliverables || []);
    say('AI 사용 기록을 읽습니다');
    const { usage, prompts } = collectSessions({ ...homeOpts(ctx), sinceMs: since });
    const skills = readSkills({ assignmentDir: dir, workspaceDir: workspace, ...homeOpts(ctx) });
    const mcp = readMcp({ assignmentDir: dir, workspaceDir: workspace, ...homeOpts(ctx) });
    const shellHistory = readShellHistory({ ...homeOpts(ctx), mark: cfg.histMark || null });

    // 마무리
    say('제출합니다');
    const manifest = assembleManifest({
      cliVersion: CLI_VERSION,
      commits,
      diff,
      diffTruncated: truncated,
      tests,
      testOutputTail: tails.join('\n\n'),
      files,
      deliverables,
      prompts,
      usage,
      skills,
      mcp,
      shellHistory,
    });
    const done = await request(ctx, cfg, 'POST', '/cli/submit/complete', { manifest, submitId }, { retries: 3, timeoutMs: 60_000 });
    cfg = updateConfig({ submittedAt: new Date(ctx.now()).toISOString(), panelUrl: done.panelUrl || cfg.panelUrl || null, status: 'submitted' }, homeOpts(ctx));

    ctx.log('');
    // 보이는 테스트만 센다. 숨은 테스트까지 합친 숫자를 보여 주면 방 화면의 숫자와 달라지고, 다시 내며 숨은 요구사항을 하나씩 맞춰 볼 수 있다(10/25 2차 검토).
    // 연습실 창의 제출 화면과 같은 이름으로 부른다(「AI에게 보낸 요청」). 테스트가 없는 과제는 0/0 대신 없다고 적는다
    const shown = tests.filter((t) => !t.hidden);
    const passed = shown.filter((t) => t.passed).length;
    const testText = shown.length ? `테스트 ${passed}/${shown.length} 통과` : '테스트 없음';
    ctx.log(`제출했습니다. ${testText}, 파일 ${files.length}개, AI에게 보낸 요청 ${prompts.length}개`);
    if (ranHidden) ctx.log('추가 테스트 결과는 리포트에서 볼 수 있습니다.');
    if (done.late) ctx.log('마감 시각이 지난 뒤에 요청한 제출이라 리포트에 "마감 뒤 제출"로 적힙니다.');
    ctx.log('연습실 창으로 돌아가 확인 문제를 푸세요.');
    if (cfg.panelUrl) ctx.log(cfg.panelUrl);
    return { ok: true, already: false, panelUrl: cfg.panelUrl || null, manifest, auto: Boolean(opts.auto) };
  } finally {
    releaseLock(lock);
  }
}

/* ───────────────────────── status ───────────────────────── */

export async function status(ctx) {
  let cfg = readConfig(homeOpts(ctx));
  if (!cfg.token || !cfg.sessionId) {
    ctx.log('아직 로그인하지 않았습니다. 연습실 창에서 접속 코드를 받아 practice login <코드> 를 실행해 주세요.');
    return { connected: false };
  }
  ctx.log(`과제: ${cfg.task && cfg.task.title ? cfg.task.title : '(이름 없음)'}`);
  ctx.log(`서버: ${resolveServer(cfg, ctx)}`);
  if (!cfg.startedAt) {
    // 시작 전에도 지켜보는 프로그램이 있어야 연습실 창의 「과제 시작」이 통한다. 작업 공간이 멈췄다 켜지면 여기서 되살린다
    const pre = TERMINAL_STATUS.has(String(cfg.status)) ? null : ensureWatch(ctx);
    if (pre && pre.started) ctx.log('지켜보는 프로그램(practice watch)을 다시 켰습니다.');
    ctx.log('상태: 아직 시작 전입니다. 연습실 창의 "과제 시작"을 누르거나 practice start 를 실행하면 시간이 흐릅니다.');
    return { connected: true, started: false };
  }

  const since = parseTime(cfg.startedAt) || 0;
  // 지켜보는 프로그램부터 살린다. 하트비트는 서버가 느리면 30초씩 걸려서, 작업 공간이 켜질 때 부르는 timeout 에 걸리면 이 뒤의 되살리기까지 못 간다(10/25 2차 검토).
  // 마감 뒤 2시간이 지난 응시는 서버가 접속 코드를 거두어 watch 가 켜지자마자 끝나므로 켜지 않는다
  const due = parseTime(cfg.deadlineAt);
  const codeExpired = due !== null && ctx.now() > due + GIVE_UP_AFTER_DEADLINE_MS;
  const w = !cfg.submittedAt && !TERMINAL_STATUS.has(String(cfg.status)) && !codeExpired ? ensureWatch(ctx) : null;
  const { usage } = collectSessions({ ...homeOpts(ctx), sinceMs: since });
  let res = null;
  try {
    res = await request(ctx, cfg, 'POST', '/cli/heartbeat', { usage }, { retries: 1 });
    cfg = updateConfig({ deadlineAt: res.deadlineAt || cfg.deadlineAt, status: res.status || cfg.status, lastHeartbeatAt: new Date(ctx.now()).toISOString() }, homeOpts(ctx));
    ctx.log('서버 연결: 정상');
  } catch (e) {
    ctx.log(`서버 연결: 안 됨${cfg.lastHeartbeatAt ? ` (마지막 성공 ${cfg.lastHeartbeatAt})` : ''}`);
    ctx.log(`  ${e && e.message ? e.message : e}`);
  }

  const st = (res && res.status) || cfg.status || '';
  // 서버 상태값(created 같은 영어)을 그대로 찍지 않는다
  ctx.log(`상태: ${cfg.submittedAt ? STATUS_TEXT.submitted : STATUS_TEXT[st] || '알 수 없음'}`);
  const deadline = parseTime((res && res.deadlineAt) || cfg.deadlineAt);
  const nowMs = res && parseTime(res.now) !== null ? parseTime(res.now) : ctx.now();
  if (deadline !== null && !cfg.submittedAt) ctx.log(deadline > nowMs ? `남은 시간: ${fmtDuration(deadline - nowMs)}` : '남은 시간: 마감됐습니다');

  for (const u of usage) {
    const label = u.tool === 'codex' ? 'Codex' : 'Claude Code';
    ctx.log(`${label}: 입력 ${fmtTokens(u.inputTokens)}, 출력 ${fmtTokens(u.outputTokens)}, 캐시 ${fmtTokens(u.cachedTokens)} 토큰, 보낸 요청 ${u.prompts}개${u.model ? ` (${u.model})` : ''}`);
  }
  // 실제 2차는 제공된 Codex만 쓴다. 기록은 그대로 보내고(점수는 깎지 않는다) 여기서만 알린다
  // 안 쓴 도구도 0 으로 된 줄이 오니 요청 수나 토큰이 있을 때만 쓴 것으로 본다
  if (usage.some((u) => u.tool === 'claude' && (u.prompts > 0 || u.inputTokens + u.outputTokens > 0))) ctx.log('Claude Code를 쓴 기록이 있습니다. 실제 2차에서는 제공된 Codex만 쓸 수 있습니다.');

  if (st === 'expired') ctx.log(EXPIRED_TEXT);
  if (codeExpired && !cfg.submittedAt && !TERMINAL_STATUS.has(String(st))) {
    ctx.log('접속 코드 유효 시간이 끝났습니다. 마감 뒤 2시간이 지나 지켜보는 프로그램(practice watch)은 켜지 않습니다. 이 응시가 어떻게 됐는지는 연습실 창에서 봐 주세요.');
  } else if (w && !cfg.submittedAt && !TERMINAL_STATUS.has(String(st))) {
    ctx.log(w.started ? '지켜보는 프로그램(practice watch)이 꺼져 있어 다시 켰습니다.' : `지켜보는 프로그램(practice watch): 켜져 있음 (pid ${w.pid})`);
  }
  return { connected: true, started: true, status: st, usage };
}

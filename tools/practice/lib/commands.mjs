// practice 명령: login · start · watch · submit · status
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
import { PracticeError, putBundle, request } from './http.mjs';
import {
  assembleManifest,
  createBundle,
  getCommits,
  getDiff,
  initRepo,
  listFiles,
  readDeliverables,
  readMcp,
  readShellHistory,
  readSkills,
  runTests,
} from './manifest.mjs';
import { collectSessions } from './sessions.mjs';
import { BUNDLE_MAX_BYTES, CLI_VERSION, HEARTBEAT_MS, fmtDuration, fmtTokens, safeJoin, sleep } from './util.mjs';

const TERMINAL_STATUS = new Set(['submitted', 'verifying', 'graded', 'expired']);

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
  return ctx.cwd;
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

export function watchPid(ctx) {
  try {
    const pid = Number(fs.readFileSync(pidPath(homeOpts(ctx)), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) return pid;
  } catch {
    // 파일이 없다
  }
  return null;
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
    ctx.warn(`  뒤에서 도는 확인 프로그램을 켜지 못했습니다. 터미널을 하나 더 열어 practice watch 를 직접 실행해 주세요. (${e && e.message ? e.message : e})`);
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
  if (cfg.startedAt && !TERMINAL_STATUS.has(String(cfg.status))) ctx.log('이미 시작한 과제입니다. 상태는 practice status 로 볼 수 있습니다.');
  else ctx.log('준비가 됐으면 practice start 를 실행하세요. 이 명령을 실행하는 순간부터 시간이 흐릅니다.');
  return cfg;
}

/* ───────────────────────── start ───────────────────────── */

export async function start(ctx, args = []) {
  const force = args.includes('--force');
  let cfg = readConfig(homeOpts(ctx));
  if (!cfg.token || !cfg.sessionId) throw new PracticeError('먼저 연습실 창에서 접속 코드를 받아 practice login <코드> 를 실행해 주세요.');

  const workspace = resolveWorkspace(ctx, cfg);
  const dir = assignmentOf(workspace);
  fs.mkdirSync(dir, { recursive: true });

  // 1) 과제 파일 받기 + git 기준점 (이미 했으면 건너뛴다)
  if (!cfg.baseline) {
    const leftover = fs.readdirSync(dir).filter((n) => n !== '.gitkeep');
    if (leftover.length > 0 && !force) {
      throw new PracticeError(
        'assignment 폴더가 비어 있지 않습니다. 이전에 받은 파일이면 practice start --force 로 다시 받습니다(직접 고친 내용은 사라집니다).',
      );
    }
    ctx.log('과제 파일을 받는 중...');
    const task = await request(ctx, cfg, 'GET', '/cli/task');
    const files = Array.isArray(task.files) ? task.files : [];
    if (files.length === 0) throw new PracticeError('서버가 과제 파일을 주지 않았습니다. 잠시 뒤 다시 시도해 주세요.');
    for (const f of files) {
      const abs = safeJoin(dir, f.path);
      if (toTop(f.path) === '.git') throw new PracticeError('쓸 수 없는 파일 경로입니다: .git');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof f.content === 'string' ? f.content : '', 'utf8');
    }
    const baseline = await initRepo(dir);
    cfg = updateConfig(
      {
        workspace,
        baseline,
        testCommand: task.testCommand || null,
        deliverables: Array.isArray(task.deliverables) ? task.deliverables : [],
      },
      homeOpts(ctx),
    );
    ctx.log(`  ${files.length}개 파일을 assignment/ 에 풀었습니다.`);
  } else if (!cfg.workspace) {
    cfg = updateConfig({ workspace }, homeOpts(ctx));
  }

  // 2) 시계 시작 (서버는 처음 한 번만 시작한다)
  if (!cfg.startedAt) {
    const s = await request(ctx, cfg, 'POST', '/cli/start', {});
    cfg = updateConfig({ startedAt: s.startedAt, deadlineAt: s.deadlineAt, status: 'started' }, homeOpts(ctx));
    ctx.log('시간이 시작됐습니다.');
  } else {
    ctx.log('이미 시작한 과제입니다. 이어서 진행합니다.');
  }

  // 3) 사용량 · 제출 요청을 지켜보는 확인 프로그램
  const w = ensureWatch(ctx);
  ctx.log(w.started ? '  사용량과 제출 요청을 지켜보는 프로그램을 뒤에서 켰습니다.' : '  사용량과 제출 요청을 지켜보는 프로그램이 이미 켜져 있습니다.');

  const deadline = parseTime(cfg.deadlineAt);
  if (deadline) ctx.log(`남은 시간: ${fmtDuration(deadline - ctx.now())}`);
  ctx.log('');
  ctx.log('assignment/README.md 부터 읽어 보세요. 일을 맡긴 담당자에게는 연습실 창의 DM 으로 물어볼 수 있습니다.');
  ctx.log('다 끝났으면 연습실 창의 「제출하고 문제풀기」를 누르세요. 직접 내려면 practice submit 입니다.');
  return cfg;
}

const toTop = (p) => String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.')[0];

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

export async function watch(ctx, args = [], opts = {}) {
  let cfg = readConfig(homeOpts(ctx));
  if (!cfg.token || !cfg.startedAt) {
    ctx.warn('아직 시작한 과제가 없습니다. practice login 과 practice start 를 먼저 실행해 주세요.');
    return { ticks: 0, submitted: false };
  }
  const other = watchPid(ctx);
  if (other) {
    ctx.log(`이미 켜져 있습니다 (pid ${other}).`);
    return { ticks: 0, submitted: false };
  }
  fs.mkdirSync(practiceHome(homeOpts(ctx)), { recursive: true });
  fs.writeFileSync(pidPath(homeOpts(ctx)), String(process.pid));

  const envInterval = Number(ctx.env.PRACTICE_HEARTBEAT_MS);
  const interval = opts.intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : HEARTBEAT_MS);
  const maxTicks = opts.maxTicks ?? Infinity;
  let ticks = 0;
  let submitted = false;
  ctx.log(`지켜보기를 시작합니다 (${Math.round(interval / 1000)}초마다).`);

  try {
    while (ticks < maxTicks) {
      ticks += 1;
      cfg = readConfig(homeOpts(ctx));
      const since = parseTime(cfg.startedAt) || 0;
      let res = null;
      try {
        const { usage } = collectSessions({ ...homeOpts(ctx), sinceMs: since });
        res = await request(ctx, cfg, 'POST', '/cli/heartbeat', { usage }, { retries: 1 });
        updateConfig(
          { deadlineAt: res.deadlineAt || cfg.deadlineAt, status: res.status || cfg.status, lastHeartbeatAt: new Date(ctx.now()).toISOString() },
          homeOpts(ctx),
        );
      } catch (e) {
        ctx.warn(`[${new Date(ctx.now()).toLocaleTimeString('ko-KR')}] 서버와 연결이 안 됩니다. 다음 확인 때 다시 시도합니다. (${e && e.message ? e.message : e})`);
      }

      if (res) {
        const action = decideWatch(res, { submittedLocally: Boolean(readConfig(homeOpts(ctx)).submittedAt) });
        if (action === 'stop') {
          ctx.log('제출이 끝났거나 마감된 과제입니다. 지켜보기를 마칩니다.');
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
      if (fs.readFileSync(pidPath(homeOpts(ctx)), 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidPath(homeOpts(ctx)));
    } catch {
      // 이미 지워졌다
    }
  }
  return { ticks, submitted };
}

/* ───────────────────────── submit ───────────────────────── */

/** 숨은 테스트 파일을 잠깐 넣었다가 원래대로 되돌린다 */
async function withFiles(dir, files, fn) {
  const written = [];
  try {
    for (const f of files) {
      const abs = safeJoin(dir, f.path);
      if (toTop(f.path) === '.git') continue;
      const prior = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof f.content === 'string' ? f.content : '', 'utf8');
      written.push({ abs, prior });
    }
    return await fn();
  } finally {
    for (const w of written.reverse()) {
      try {
        if (w.prior !== null) fs.writeFileSync(w.abs, w.prior);
        else fs.unlinkSync(w.abs);
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
}

export async function submit(ctx, args = [], opts = {}) {
  let cfg = readConfig(homeOpts(ctx));
  if (!cfg.token || !cfg.sessionId) throw new PracticeError('먼저 practice login <코드> 를 실행해 주세요.');
  if (!cfg.startedAt || !cfg.baseline) throw new PracticeError('아직 시작하지 않았습니다. practice start 를 먼저 실행해 주세요.');
  if (cfg.submittedAt && !args.includes('--again')) {
    ctx.log('이미 제출했습니다. 연습실 창으로 돌아가 확인 문제를 푸세요.');
    return { ok: true, already: true, panelUrl: cfg.panelUrl || null };
  }

  const workspace = resolveWorkspace(ctx, cfg);
  const dir = assignmentOf(workspace);
  if (!fs.existsSync(dir)) throw new PracticeError('assignment 폴더를 찾지 못했습니다. 작업 공간의 맨 위 폴더에서 실행해 주세요.');
  const since = parseTime(cfg.startedAt) || 0;
  const steps = 7;
  let step = 0;
  const say = (m) => ctx.log(`[${++step}/${steps}] ${m}`);

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
  say('작업 내용(커밋 · 변경 내용)을 모읍니다');
  const commits = await getCommits(dir, cfg.baseline);
  const { diff, truncated } = await getDiff(dir, cfg.baseline);

  // 숨은 테스트 (제출 요청 뒤나 마감 뒤에만 받을 수 있다)
  say('확인용 테스트를 받아 돌립니다');
  try {
    const hidden = await request(ctx, cfg, 'GET', '/cli/hidden-tests', undefined, { retries: 2 });
    const hfiles = Array.isArray(hidden.files) ? hidden.files : [];
    if (hfiles.length && hidden.command) {
      const r = await withFiles(dir, hfiles, () => runTests({ command: hidden.command, cwd: dir, hidden: true, env: ctx.env, timeoutMs: 180_000 }));
      tests = tests.concat(r.tests);
      tails.push(`# 확인용 테스트\n${r.tail}`);
    } else {
      ctx.log('  이 과제에는 확인용 테스트가 없습니다.');
    }
  } catch (e) {
    if (e instanceof PracticeError && e.status && e.status < 500) {
      ctx.warn('  확인용 테스트는 연습실 창에서 제출을 요청한 뒤에 받을 수 있어 이번에는 건너뜁니다. 연습실 창의 「제출하고 문제풀기」로 내면 함께 돌아갑니다.');
    } else {
      ctx.warn(`  확인용 테스트를 받지 못해 건너뜁니다. (${e && e.message ? e.message : e})`);
    }
  }

  // 파일 · 결과물 · AI 기록
  say('파일과 결과물을 읽습니다');
  const files = listFiles(dir);
  const deliverables = readDeliverables(dir, cfg.deliverables || []);
  say('AI 사용 기록(Codex · Claude Code)을 읽습니다');
  const { usage, prompts } = collectSessions({ ...homeOpts(ctx), sinceMs: since });
  const skills = readSkills({ assignmentDir: dir, workspaceDir: workspace, ...homeOpts(ctx) });
  const mcp = readMcp({ assignmentDir: dir, workspaceDir: workspace, ...homeOpts(ctx) });
  const shellHistory = readShellHistory(homeOpts(ctx));

  // 묶음 올리기
  say('작업 폴더를 묶어 올립니다');
  let bundleKey = null;
  let bundleBytes = 0;
  const tmpFile = path.join(os.tmpdir(), `practice-${cfg.sessionId}-${process.pid}.tar.gz`);
  try {
    const bytes = await createBundle({ workspaceDir: workspace, assignmentDir: dir, outFile: tmpFile });
    if (bytes > BUNDLE_MAX_BYTES) {
      ctx.warn(`  작업 폴더가 ${Math.round(bytes / 1048576)}MB 로 한도(20MB)를 넘어 묶음은 올리지 않습니다. 코드와 결과물 글은 그대로 제출됩니다.`);
    } else {
      try {
        const init = await request(ctx, cfg, 'POST', '/cli/submit/init', { bytes }, { retries: 2 });
        if (init.uploadUrl) {
          await putBundle(ctx, init.uploadUrl, fs.readFileSync(tmpFile));
          bundleKey = init.bundleKey || null;
          bundleBytes = bytes;
        }
      } catch (e) {
        // 묶음은 보조 자료다. 못 올려도 manifest 로 제출은 이어 간다
        ctx.warn(`  묶음을 올리지 못했지만 코드와 결과물 글은 그대로 제출합니다. (${e && e.message ? e.message : e})`);
      }
    }
  } catch (e) {
    ctx.warn(`  작업 폴더를 묶지 못했지만 제출은 이어 갑니다. (${e && e.message ? e.message : e})`);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // 임시 파일이 없다
    }
  }

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
    bundleKey,
    bundleBytes,
  });
  const done = await request(ctx, cfg, 'POST', '/cli/submit/complete', { manifest }, { retries: 3, timeoutMs: 60_000 });
  cfg = updateConfig({ submittedAt: new Date(ctx.now()).toISOString(), panelUrl: done.panelUrl || cfg.panelUrl || null, status: 'submitted' }, homeOpts(ctx));

  const passed = tests.filter((t) => t.passed).length;
  ctx.log('');
  ctx.log(`제출했습니다. 테스트 ${passed}/${tests.length} 통과 · 파일 ${files.length}개 · 프롬프트 ${prompts.length}개`);
  ctx.log('연습실 창으로 돌아가 확인 문제를 푸세요.');
  if (cfg.panelUrl) ctx.log(cfg.panelUrl);
  return { ok: true, already: false, panelUrl: cfg.panelUrl || null, manifest, auto: Boolean(opts.auto) };
}

/* ───────────────────────── status ───────────────────────── */

export async function status(ctx) {
  let cfg = readConfig(homeOpts(ctx));
  if (!cfg.token || !cfg.sessionId) {
    ctx.log('연결되지 않았습니다. 연습실 창에서 접속 코드를 받아 practice login <코드> 를 실행해 주세요.');
    return { connected: false };
  }
  ctx.log(`과제: ${cfg.task && cfg.task.title ? cfg.task.title : '(이름 없음)'}`);
  ctx.log(`서버: ${resolveServer(cfg, ctx)}`);
  if (!cfg.startedAt) {
    ctx.log('상태: 아직 시작 전입니다. practice start 를 실행하면 시간이 흐릅니다.');
    return { connected: true, started: false };
  }

  const since = parseTime(cfg.startedAt) || 0;
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
  ctx.log(`상태: ${cfg.submittedAt ? '제출 완료' : st === 'started' ? '진행 중' : st || '알 수 없음'}`);
  const deadline = parseTime((res && res.deadlineAt) || cfg.deadlineAt);
  const nowMs = res && parseTime(res.now) !== null ? parseTime(res.now) : ctx.now();
  if (deadline !== null && !cfg.submittedAt) ctx.log(deadline > nowMs ? `남은 시간: ${fmtDuration(deadline - nowMs)}` : '남은 시간: 마감됐습니다');

  for (const u of usage) {
    const label = u.tool === 'codex' ? 'Codex' : 'Claude Code';
    ctx.log(`${label}: 입력 ${fmtTokens(u.inputTokens)} · 출력 ${fmtTokens(u.outputTokens)} · 캐시 ${fmtTokens(u.cachedTokens)} 토큰 · 프롬프트 ${u.prompts}개${u.model ? ` (${u.model})` : ''}`);
  }

  if (!cfg.submittedAt && !TERMINAL_STATUS.has(String(st))) {
    const w = ensureWatch(ctx);
    ctx.log(w.started ? '지켜보는 프로그램이 꺼져 있어 다시 켰습니다.' : `지켜보는 프로그램: 켜져 있음 (pid ${w.pid})`);
  }
  return { connected: true, started: true, status: st, usage };
}

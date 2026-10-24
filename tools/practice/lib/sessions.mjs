// Codex · Claude Code 세션 파일(jsonl)에서 사용량과 사용자 프롬프트를 읽는다.
// 줄 형식은 버전마다 다르다. 모르는 줄은 건너뛰고, 못 읽으면 0 으로 둔다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROMPT_MAX_CHARS, clip, num } from './util.mjs';

const isoOf = (ts, fallback) => {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
};
const msOf = (ts) => {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(t) ? t : null;
};

export function emptyUsage(tool) {
  return { tool, model: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, prompts: 0 };
}

/* ───────────────────────── Codex ───────────────────────── */

/** 환경 설명 · 지침이 사용자 역할로 끼어든 글인지 */
function isCodexInjected(text) {
  const t = String(text || '').trimStart();
  return !t || t.startsWith('<') || t.startsWith('# AGENTS.md') || t.startsWith('# Context from my IDE');
}

/**
 * ~/.codex/sessions/**\/rollout-*.jsonl 한 파일.
 * 사용량: token_count 의 누적 합계(total_token_usage)에서 늘어난 만큼을 그때의 모델에 더한다.
 * 입력은 「캐시 아닌 입력」으로 나눠 담는다(input - cached).
 * 반환: { models: Map<string|null, {input, cached, output}>, prompts: [{at, text}] }
 */
export function parseCodexSession(text, sinceMs = 0) {
  const models = new Map();
  const userEvents = [];
  const userItems = [];
  const userResponses = [];
  let model = null;
  let prev = { fresh: 0, cached: 0, output: 0 };

  for (const line of String(text || '').split('\n')) {
    if (!line || line.length < 10) continue;
    if (
      !line.includes('token_count') &&
      !line.includes('turn_context') &&
      !line.includes('user_message') &&
      !line.includes('UserMessage') &&
      !line.includes('"user"')
    ) {
      continue;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const p = o.payload && typeof o.payload === 'object' ? o.payload : null;
    if (!p) continue;
    const ts = msOf(o.timestamp);
    const inRange = ts === null || ts >= sinceMs;

    if (o.type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) model = p.model;
      continue;
    }
    if (o.type === 'event_msg') {
      if (p.type === 'token_count') {
        const t = p.info && p.info.total_token_usage;
        if (!t || typeof t !== 'object') continue;
        const cached = num(t.cached_input_tokens);
        const cur = { fresh: Math.max(0, num(t.input_tokens) - cached), cached, output: num(t.output_tokens) };
        let d = { fresh: cur.fresh - prev.fresh, cached: cur.cached - prev.cached, output: cur.output - prev.output };
        // 누적이 줄었다면 세는 기준이 다시 시작된 것이다
        if (d.fresh < 0 || d.cached < 0 || d.output < 0) d = { ...cur };
        prev = cur;
        if (inRange && (d.fresh || d.cached || d.output)) {
          const slot = models.get(model) || { input: 0, cached: 0, output: 0 };
          slot.input += d.fresh;
          slot.cached += d.cached;
          slot.output += d.output;
          models.set(model, slot);
        }
      } else if (p.type === 'user_message' && typeof p.message === 'string') {
        if (inRange) userEvents.push({ ts, text: p.message });
      } else if (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage') {
        const parts = Array.isArray(p.item.content) ? p.item.content : [];
        const t = parts
          .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n');
        if (inRange && t) userItems.push({ ts, text: t });
      }
    } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const parts = Array.isArray(p.content) ? p.content : [];
      const t = parts
        .filter((c) => c && c.type === 'input_text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      if (inRange && t && !isCodexInjected(t)) userResponses.push({ ts, text: t });
    }
  }

  // 같은 글이 세 군데에 중복해서 남을 수 있어, 있는 것 중 하나만 쓴다
  const picked = userEvents.length ? userEvents : userItems.length ? userItems : userResponses;
  const prompts = picked
    .filter((m) => m.text.trim())
    .map((m) => ({ at: isoOf(m.ts, new Date(sinceMs || 0).toISOString()), text: clip(m.text.trim(), PROMPT_MAX_CHARS) }));
  return { models, prompts };
}

/* ───────────────────────── Claude Code ───────────────────────── */

const CLAUDE_SKIP_PREFIX = ['<ide_', '<system-reminder', '<local-command', '<task-notification', 'Caveat:', '[Request interrupted'];

function claudePromptText(content) {
  if (typeof content === 'string') return cleanClaudeText(content);
  if (!Array.isArray(content)) return '';
  const texts = [];
  for (const c of content) {
    if (c && c.type === 'text' && typeof c.text === 'string') {
      const t = cleanClaudeText(c.text);
      if (t) texts.push(t);
    }
  }
  return texts.join('\n');
}

function cleanClaudeText(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/);
    return `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  if (CLAUDE_SKIP_PREFIX.some((p) => t.startsWith(p))) return '';
  return t;
}

/**
 * ~/.claude/projects/**\/*.jsonl 한 파일.
 * 반환: { messages: Map<id, {model, ts, input, cached, output}>, prompts: [{id, at, text}] }
 * 같은 응답이 줄마다 되풀이되어 적히므로 message.id 로 모아 출력 토큰이 가장 큰 줄을 쓴다.
 */
export function parseClaudeSession(text, sinceMs = 0) {
  const messages = new Map();
  const prompts = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || line.length < 10) continue;
    const isAssistant = line.includes('"usage"');
    const isUser = line.includes('"type":"user"');
    if (!isAssistant && !isUser) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object' || !o.message || typeof o.message !== 'object') continue;
    const ts = msOf(o.timestamp);
    if (ts !== null && ts < sinceMs) continue;

    if (o.type === 'assistant' && o.message.usage) {
      const u = o.message.usage;
      const model = typeof o.message.model === 'string' ? o.message.model : null;
      if (model === '<synthetic>') continue;
      const entry = {
        model,
        ts,
        input: num(u.input_tokens) + num(u.cache_creation_input_tokens),
        cached: num(u.cache_read_input_tokens),
        output: num(u.output_tokens),
      };
      const id = String(o.message.id || o.uuid || `${prompts.length}:${messages.size}`);
      const old = messages.get(id);
      if (!old || entry.output >= old.output) messages.set(id, entry);
    } else if (o.type === 'user' && o.message.role === 'user') {
      if (o.isMeta || o.isSidechain) continue;
      if (o.origin && typeof o.origin === 'object' && o.origin.kind && o.origin.kind !== 'human') continue;
      const t = claudePromptText(o.message.content);
      if (!t) continue;
      prompts.push({ id: String(o.uuid || `${o.timestamp}:${t.slice(0, 20)}`), at: isoOf(o.timestamp, new Date(sinceMs || 0).toISOString()), text: clip(t, PROMPT_MAX_CHARS) });
    }
  }
  return { messages, prompts };
}

/* ───────────────────────── 모으기 ───────────────────────── */

function walk(dir, match, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, match, depth - 1, out);
    else if (e.isFile() && match.test(e.name)) out.push(full);
  }
}

/** 도구별 설정 폴더 위치 */
export function toolHomes(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  return {
    codex: env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'),
    claude: env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude'),
  };
}

/** 시작 뒤에 바뀐 세션 파일만 */
export function findSessionFiles(tool, opts = {}) {
  const homes = toolHomes(opts);
  const since = opts.sinceMs || 0;
  const out = [];
  if (tool === 'codex') walk(path.join(homes.codex, 'sessions'), /^rollout-.*\.jsonl$/, 6, out);
  else walk(path.join(homes.claude, 'projects'), /\.jsonl$/, 6, out);
  return out.filter((f) => {
    try {
      return fs.statSync(f).mtimeMs >= since;
    } catch {
      return false;
    }
  });
}

function readTextSafe(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > 300 * 1024 * 1024) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 모델마다 한 줄. 프롬프트 수는 토큰이 가장 큰 줄에 모은다. 아무것도 못 읽으면 0 한 줄 */
function toUsageRows(tool, byModel, promptCount) {
  const rows = [...byModel.entries()].map(([model, v]) => ({
    tool,
    model: model || null,
    inputTokens: v.input,
    outputTokens: v.output,
    cachedTokens: v.cached,
    prompts: 0,
  }));
  if (rows.length === 0) {
    const row = emptyUsage(tool);
    row.prompts = promptCount;
    return [row];
  }
  rows.sort((a, b) => b.inputTokens + b.outputTokens + b.cachedTokens - (a.inputTokens + a.outputTokens + a.cachedTokens));
  rows[0].prompts = promptCount;
  return rows;
}

/**
 * 시작(sinceMs) 뒤 사용량과 프롬프트를 두 도구에서 모은다.
 * 반환: { usage: ToolUsage[], prompts: [{at, tool, text}] }
 */
export function collectSessions(opts = {}) {
  const sinceMs = opts.sinceMs || 0;
  const prompts = [];

  const codexModels = new Map();
  let codexPrompts = 0;
  for (const file of findSessionFiles('codex', opts)) {
    const r = parseCodexSession(readTextSafe(file), sinceMs);
    for (const [model, v] of r.models) {
      const slot = codexModels.get(model) || { input: 0, cached: 0, output: 0 };
      slot.input += v.input;
      slot.cached += v.cached;
      slot.output += v.output;
      codexModels.set(model, slot);
    }
    for (const p of r.prompts) prompts.push({ at: p.at, tool: 'codex', text: p.text });
    codexPrompts += r.prompts.length;
  }

  // 이어 하기로 같은 글이 여러 파일에 복사되므로 id 로 한 번만 센다
  const claudeMsgs = new Map();
  const seenPrompt = new Set();
  let claudePrompts = 0;
  for (const file of findSessionFiles('claude', opts)) {
    const r = parseClaudeSession(readTextSafe(file), sinceMs);
    for (const [id, m] of r.messages) {
      const old = claudeMsgs.get(id);
      if (!old || m.output >= old.output) claudeMsgs.set(id, m);
    }
    for (const p of r.prompts) {
      if (seenPrompt.has(p.id)) continue;
      seenPrompt.add(p.id);
      prompts.push({ at: p.at, tool: 'claude', text: p.text });
      claudePrompts += 1;
    }
  }
  const claudeModels = new Map();
  for (const m of claudeMsgs.values()) {
    const slot = claudeModels.get(m.model) || { input: 0, cached: 0, output: 0 };
    slot.input += m.input;
    slot.cached += m.cached;
    slot.output += m.output;
    claudeModels.set(m.model, slot);
  }

  prompts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    usage: [...toUsageRows('codex', codexModels, codexPrompts), ...toUsageRows('claude', claudeModels, claudePrompts)],
    prompts,
  };
}

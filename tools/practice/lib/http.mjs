// 서버 호출. 네트워크 실패는 다시 시도하고, 손님에게 한국어로 알린다.
import { resolveServer } from './config.mjs';
import { CLI_VERSION, sleep } from './util.mjs';

export class PracticeError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'PracticeError';
    this.status = extra.status ?? null;
    this.body = extra.body ?? null;
  }
}

/** 상태 코드별로 손님이 할 일을 말해 준다 */
export function describeStatus(status, serverMessage) {
  const tail = serverMessage ? ` (${serverMessage})` : '';
  if (status === 401) return `접속 코드가 맞지 않거나 만료됐습니다. 연습실 창에서 새 코드를 받아 practice login 을 다시 해 주세요.${tail}`;
  if (status === 403) return `지금은 할 수 없는 일입니다.${tail}`;
  if (status === 404) return `서버에서 찾지 못했습니다. 접속 코드가 이 과제 것인지 확인해 주세요.${tail}`;
  if (status === 409) return `지금 단계에서는 받아 주지 않습니다.${tail}`;
  if (status === 413) return `보낸 크기가 한도를 넘었습니다.${tail}`;
  if (status === 429) return `요청이 너무 잦습니다. 잠시 뒤 다시 해 주세요.${tail}`;
  if (status >= 500) return `서버 쪽 문제로 처리하지 못했습니다. 잠시 뒤 다시 해 주세요.${tail}`;
  return `서버가 요청을 받아 주지 않았습니다 (${status}).${tail}`;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryBaseMs(ctx) {
  const v = Number(ctx.env && ctx.env.PRACTICE_RETRY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1000;
}

/**
 * JSON API 호출. 실패하면 PracticeError(한국어 메시지).
 * opts: { retries(기본 3), auth(기본 true), timeoutMs(기본 30초) }
 */
export async function request(ctx, cfg, method, apiPath, body, opts = {}) {
  const retries = opts.retries ?? 3;
  const server = resolveServer(cfg, ctx);
  const url = `${server}/api/ax/practice${apiPath}`;
  const headers = { 'x-practice-cli': CLI_VERSION };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth !== false && cfg && cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const doFetch = ctx.fetch || globalThis.fetch;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = retryBaseMs(ctx) * 2 ** (attempt - 1);
      ctx.warn(`  서버에 연결하지 못했습니다. ${Math.round(wait / 1000) || 1}초 뒤 다시 시도합니다 (${attempt}/${retries})`);
      await sleep(wait);
    }
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      lastError = new PracticeError(
        `서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 잠시 뒤 다시 해 주세요. (${server})`,
        { body: String(e && e.message ? e.message : e) },
      );
      continue;
    }
    let data = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (res.ok) return data ?? {};
    const serverMessage = data && typeof data.error === 'string' ? data.error : data && typeof data.message === 'string' ? data.message : '';
    lastError = new PracticeError(describeStatus(res.status, serverMessage), { status: res.status, body: data });
    if (!RETRYABLE.has(res.status)) throw lastError;
  }
  throw lastError || new PracticeError('서버 호출에 실패했습니다.');
}

/** 미리 서명된 주소로 묶음 올리기 */
export async function putBundle(ctx, uploadUrl, buffer, opts = {}) {
  const retries = opts.retries ?? 3;
  const doFetch = ctx.fetch || globalThis.fetch;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = retryBaseMs(ctx) * 2 ** (attempt - 1);
      ctx.warn(`  묶음 올리기가 끊겼습니다. ${Math.round(wait / 1000) || 1}초 뒤 다시 시도합니다 (${attempt}/${retries})`);
      await sleep(wait);
    }
    try {
      const res = await doFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: buffer,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      if (res.ok) return;
      lastError = new PracticeError(`작업 묶음을 올리지 못했습니다 (${res.status}).`, { status: res.status });
      if (!RETRYABLE.has(res.status)) throw lastError;
    } catch (e) {
      if (e instanceof PracticeError && !RETRYABLE.has(e.status)) throw e;
      lastError = e instanceof PracticeError ? e : new PracticeError('작업 묶음을 올리는 중 연결이 끊겼습니다.', { body: String(e && e.message ? e.message : e) });
    }
  }
  throw lastError || new PracticeError('작업 묶음을 올리지 못했습니다.');
}

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

/** 서버가 손님 말로 써 준 문장만 쓴다(영어나 코드 값이 섞여 나오면 버린다) */
const koreanOnly = (s) => (typeof s === 'string' && /[가-힣]/.test(s) ? s.trim() : '');

/**
 * 서버 문장 뒤에 한 번만 붙이는, 손님이 다음에 할 일.
 * 서버 문장과 같은 말을 앞에 한 번 더 붙이면 같은 뜻이 두 번 나온다(10/25 검토).
 */
const NEXT_STEP = {
  BAD_CODE: '받은 코드로 practice login 을 다시 실행해 주세요.',
  CODE_EXPIRED: '받은 코드로 practice login 을 다시 실행해 주세요.',
};

/** 서버가 문장을 안 준 경우에 쓰는 안내. 서버 문장이 있으면 쓰이지 않는다 */
const GENERIC = {
  401: '접속 코드가 맞지 않거나 만료됐습니다. 연습실 창에서 새 코드를 받아 practice login 을 다시 해 주세요.',
  403: '지금은 이 명령을 쓸 수 없습니다. 연습실 창의 상태를 확인해 주세요.',
  404: '서버에서 찾지 못했습니다. 접속 코드가 이 과제 것인지 확인해 주세요.',
  409: '지금 단계에서는 이 명령을 쓸 수 없습니다. 이미 제출했거나 마감된 과제일 수 있습니다. practice status 로 확인해 주세요.',
  413: '보낸 크기가 한도를 넘었습니다.',
  429: '요청이 너무 잦습니다. 잠시 뒤 다시 해 주세요.',
};

/** 상태 코드별로 손님이 할 일을 말해 준다. 서버가 한국어 문장을 줬으면 그 문장이 앞에 선다 */
export function describeStatus(status, serverMessage, code = '') {
  const said = koreanOnly(serverMessage);
  if (said) {
    const sentence = /[.!?]$/.test(said) ? said : `${said}.`;
    const next = NEXT_STEP[code] || (status === 401 && !said.includes('practice login') ? NEXT_STEP.BAD_CODE : '');
    const retry = (status >= 500 || status === 429) && !/다시|기다/.test(said) ? ' 잠시 뒤 다시 해 주세요.' : '';
    return `${sentence}${next ? ` ${next}` : ''}${retry}`;
  }
  if (GENERIC[status]) return GENERIC[status];
  if (status >= 500) return '서버 쪽 문제로 처리하지 못했습니다. 잠시 뒤 다시 해 주세요.';
  return `서버가 요청을 받아 주지 않았습니다 (${status}).`;
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
  // 직전 실패가 연결 자체였는지, 서버가 응답은 했는데 바쁘다고 한 것인지(5xx, 429) 따로 안내한다. 서버 오류를 인터넷 문제로 읽지 않게
  let lastWasNetwork = true;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = retryBaseMs(ctx) * 2 ** (attempt - 1);
      const secs = Math.round(wait / 1000) || 1;
      ctx.warn(lastWasNetwork ? `  서버에 연결하지 못했습니다. ${secs}초 뒤 다시 시도합니다 (${attempt}/${retries})` : `  서버가 바쁩니다. ${secs}초 뒤 다시 시도합니다 (${attempt}/${retries})`);
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
      lastWasNetwork = true;
      continue;
    }
    lastWasNetwork = false;
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
    const code = data && typeof data.code === 'string' ? data.code : '';
    lastError = new PracticeError(describeStatus(res.status, serverMessage, code), { status: res.status, body: data });
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

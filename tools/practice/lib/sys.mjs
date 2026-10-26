// 작업 공간의 CPU · 메모리 — 실제 2차 위 줄의 CPU / RAM 자리에 보인다. 외부 패키지 없이 Node 내장과 /proc 만 쓴다.
import fs from 'node:fs';
import os from 'node:os';

/** 모든 코어의 CPU 시간 합(ms) — 두 번 읽어 그 사이 쉰 비율로 사용률을 낸다 */
export function cpuTimes(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const c of cpus || []) {
    const t = c.times || {};
    const sum = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    idle += t.idle || 0;
    total += sum;
  }
  return { idle, total };
}

/** 두 번 읽은 CPU 시간 사이의 사용률(%). 처음 읽을 때는 비교할 앞 값이 없어 null */
export function cpuPctBetween(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  if (!(dt > 0)) return null;
  const pct = 100 * (1 - (cur.idle - prev.idle) / dt);
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/**
 * 메모리(MB). /proc/meminfo 의 MemTotal − MemAvailable 이 top 이 보이는 「쓰는 양」과 같다.
 * /proc 이 없으면(맥 · 윈도에서 시험할 때) Node 의 전체 − 남은 양을 쓴다.
 */
export function memInfo(readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const text = readFile('/proc/meminfo');
    const kb = (key) => {
      const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
      return m ? Number(m[1]) : null;
    };
    const total = kb('MemTotal');
    const avail = kb('MemAvailable');
    if (total && avail !== null) return { memUsedMb: Math.round((total - avail) / 1024), memTotalMb: Math.round(total / 1024) };
  } catch {
    // /proc 이 없다 — 아래로
  }
  const total = os.totalmem();
  return { memUsedMb: Math.round((total - os.freemem()) / 1048576), memTotalMb: Math.round(total / 1048576) };
}

/** 하트비트에 실을 값. 앞 CPU 시간을 받아 이번 값과 다음에 쓸 CPU 시간을 돌려준다 */
export function sysSnapshot(prev, opts = {}) {
  const cur = (opts.cpuTimes || cpuTimes)();
  const mem = (opts.memInfo || memInfo)();
  const cpuPct = cpuPctBetween(prev, cur);
  return { sys: { cpuPct: cpuPct ?? 0, ...mem }, cur };
}

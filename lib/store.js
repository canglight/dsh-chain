/**
 * 存储层：追加写 JSONL，读取时逐行解析。
 *
 * 选 JSONL 而不是 SQLite / JSON 数组的原因：
 *   1. 追加是 O(1)，不用每次重写整文件；
 *   2. 一行写坏只丢一行，整库不会损坏；
 *   3. 人工可以直接打开看、可以 grep。
 *
 * 代价是读取要全量扫描。当前体量（每天十几条）下这完全不是问题；
 * 真到几万条时再加尾部索引，不在第一版解决。
 *
 * @module dsh-chain/store
 */

import {
  appendFileSync,
  existsSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  truncateSync,
  writeSync,
  writeFileSync,
  renameSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  FIELD_MAX,
  LIST_MAX,
  WEIGHT_DECAY_GRACE_DAYS,
  WEIGHT_DECAY_HALF_LIFE_DAYS,
  storeDir,
  storePath,
  storeLockTimeoutMs,
} from './config.js';
import { poolDef, poolOf } from './pools.js';

// Local-filesystem bakery lock. Every acquisition owns a never-reused filename.
// The empty wx-created file means "choosing"; rename publishes a complete ticket.
// Identity lives in the filename too, so a crash before the first write is recoverable.
const lockStateKey = Symbol.for('dsh-chain.store-lock.v1');
const lockState = globalThis[lockStateKey] ??= {
  held: new Map(), pending: new Set(), started: '', gcAt: new Map(),
};
const lockSleep = new Int32Array(new SharedArrayBuffer(4));
const ticketPattern = /^(\d+)\.([0-9a-f]+)\.([0-9a-f]{32})\.(ticket|tmp)$/;
const lockError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

function checkDeadline(deadline) {
  if (performance.now() >= deadline) throw lockError('LOCK_TIMEOUT', 'waiting for chains.jsonl');
}

function processStart(pid, deadline) {
  checkDeadline(deadline);
  if (process.platform === 'win32') {
    // OS creation time, not Date.now() - process.uptime(). Keep 64-bit ticks as text.
    const script = `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)`;
    const child = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: Math.max(1, Math.ceil(deadline - performance.now())),
        maxBuffer: 16384,
      });
    checkDeadline(deadline);
    const value = child.stdout?.trim();
    return !child.error && child.status === 0 && /^\d+$/.test(value) ? value : null;
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^\d+$/.test(ticks) ? `${boot}:${ticks}` : null;
    } catch { return null; }
  }
  throw lockError('LOCK_IDENTITY_UNAVAILABLE', `unsupported platform ${process.platform}`);
}

function lockDomain() {
  // Resolve existing ancestors even before a new store directory has been created.
  let parent = resolve(storePath());
  const tail = [];
  for (;;) {
    try { parent = realpathSync.native(parent); break; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      tail.unshift(basename(parent));
      parent = next;
    }
  }
  let path = join(parent, ...tail);
  if (process.platform === 'win32') path = path.toLowerCase();
  // A sibling namespace: reading/dry-run must not create the data directory.
  return { path, dir: join(dirname(dirname(path)), '.dsh-chain-locks', createHash('sha256').update(path).digest('hex')) };
}

function ticketOwner(name) {
  const match = ticketPattern.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) return null;
  return { pid, started: Buffer.from(match[2], 'hex').toString('utf8'), token: match[3] };
}

function lockFileOperation(operation, deadline) {
  for (;;) {
    try { return operation(); } catch (error) {
      // Windows may report delete-pending / sharing violations during another
      // participant's read or cleanup. Retry within the same bounded wait.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      checkDeadline(deadline);
      Atomics.wait(lockSleep, 0, 0, Math.min(5, Math.max(0, deadline - performance.now())));
    }
  }
}

function removeTicket(path, deadline = performance.now() + 100) {
  lockFileOperation(() => {
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, deadline);
}

function ownerGone(owner, deadline, verifyIdentity) {
  if (!owner) return false;
  try { process.kill(owner.pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return true;
    // Access denied is not proof of death.
  }
  if (!verifyIdentity) return false;
  const started = owner.pid === process.pid ? lockState.started : processStart(owner.pid, deadline);
  return !!started && started !== owner.started;
}

function readTicket(dir, name) {
  try {
    const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const owner = ticketOwner(name);
    if (owner && data && data.pid === owner.pid && data.started === owner.started && data.token === owner.token
      && typeof data.number === 'string' && /^[1-9]\d*$/.test(data.number)) return BigInt(data.number);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return null;
    if (!(error instanceof SyntaxError)) throw error;
  }
  return null; // Empty/incomplete/invalid metadata blocks, never becomes an unlocked path.
}

function collectOldTemps(dir, deadline) {
  const now = performance.now();
  if (now - (lockState.gcAt.get(dir) ?? -Infinity) < 60000) return;
  lockState.gcAt.set(dir, now);
  let checked = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.tmp') || ++checked > 32) continue;
    const path = join(dir, name);
    try {
      // One hour is only a scan filter, never permission to evict a live owner.
      if (Date.now() - statSync(path).mtimeMs < 3600000) continue;
      if (ownerGone(ticketOwner(name), deadline, true)) removeTicket(path, deadline);
    } catch (error) {
      if (error.code === 'LOCK_TIMEOUT') throw error;
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/** Synchronous, reentrant transaction for a whole chains.jsonl; never accepts async work. */
export function withStoreLock(task) {
  const domain = lockDomain();
  if (lockState.held.has(domain.path)) return task();
  const deadline = performance.now() + storeLockTimeoutMs();
  let ticket;
  let temporary;
  let result;
  let failure;
  try {
    for (const path of lockState.pending) {
      removeTicket(path, deadline);
      lockState.pending.delete(path);
    }
    if (!lockState.started) {
      lockState.started = processStart(process.pid, deadline) || '';
      if (!lockState.started) throw lockError('LOCK_IDENTITY_UNAVAILABLE', 'cannot read process creation time');
    }
    checkDeadline(deadline);
    mkdirSync(domain.dir, { recursive: true });
    collectOldTemps(domain.dir, deadline);
    const owner = { pid: process.pid, started: lockState.started, token: randomUUID().replaceAll('-', '') };
    const name = `${owner.pid}.${Buffer.from(owner.started).toString('hex')}.${owner.token}.ticket`;
    const candidate = join(domain.dir, name);
    const registration = openSync(candidate, 'wx');
    ticket = candidate; // Only remove files that this acquisition actually created.
    temporary = ticket.slice(0, -7) + '.tmp';
    closeSync(registration);
    let number = 0n;
    for (const peer of readdirSync(domain.dir)) {
      checkDeadline(deadline);
      if (!peer.endsWith('.ticket') || peer === name) continue;
      const value = readTicket(domain.dir, peer);
      if (typeof value === 'bigint' && value > number) number = value;
    }
    number += 1n;
    writeFileSync(temporary, JSON.stringify({ ...owner, number: String(number) }), { encoding: 'utf8', flag: 'wx' });
    lockFileOperation(() => renameSync(temporary, ticket), deadline);
    const waitingSince = performance.now();
    const verified = new Map();
    for (;;) {
      checkDeadline(deadline);
      let blocked = false;
      for (const peer of readdirSync(domain.dir)) {
        if (!peer.endsWith('.ticket') || peer === name) continue;
        checkDeadline(deadline);
        const value = readTicket(domain.dir, peer);
        if (value === undefined) continue;
        const waitsForPeer = value === null || value < number || (value === number && peer < name);
        const owner = ticketOwner(peer);
        let gone = ownerGone(owner, deadline, false);
        // Avoid starting PowerShell for normal short-lived competitors. Reused PIDs
        // still get an exact start-time check if they obstruct this acquisition.
        if (!gone && waitsForPeer && performance.now() - waitingSince >= 50) {
          if (!verified.has(peer)) verified.set(peer, ownerGone(owner, deadline, true));
          gone = verified.get(peer);
        }
        if (gone) {
          removeTicket(join(domain.dir, peer), deadline);
          removeTicket(join(domain.dir, peer.slice(0, -7) + '.tmp'), deadline);
        } else if (waitsForPeer) blocked = true;
      }
      if (!blocked) break;
      Atomics.wait(lockSleep, 0, 0, Math.min(10, Math.max(0, deadline - performance.now())));
    }
    checkDeadline(deadline);
    lockState.held.set(domain.path, true);
    result = task();
    if (result && typeof result.then === 'function') throw lockError('LOCK_ASYNC_CALLBACK', 'store transactions must be synchronous');
  } catch (error) {
    failure = error;
  } finally {
    lockState.held.delete(domain.path);
    for (const path of [temporary, ticket]) {
      if (!path) continue;
      try { removeTicket(path); } catch (error) {
        lockState.pending.add(path);
        if (failure) failure.message += `; LOCK_RELEASE_FAILED: ${error.message}`;
        else failure = Object.assign(lockError('LOCK_RELEASE_FAILED', `operation completed; ${error.message}`), { storeResult: result });
      }
    }
  }
  if (failure) throw failure;
  return result;
}


/**
 * 把任意值收拾成单行字符串：去换行、去多余空白、截断。
 * @param value - 任意输入。
 * @returns 干净的字符串（可能为空串）。
 */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > FIELD_MAX ? `${flat.slice(0, FIELD_MAX)}…` : flat;
}

/**
 * 把任意值收拾成字符串数组：逐项 cleanText、去掉空项、限制长度。
 * @param value - 任意输入（字符串会当成单元素数组）。
 * @returns 干净的字符串数组。
 */
export function cleanList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of items) {
    const text = cleanText(item);
    if (text !== '') out.push(text);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

/**
 * 生成一个短 id。
 * @returns 形如 `c_ab12cd34` 的 id。
 */
export function newId() {
  return `c_${randomBytes(4).toString('hex')}`;
}

/**
 * 把权重夹到 0~1。
 * @param value - 任意输入。
 * @returns 0~1 之间的数；无法解析时返回默认 0.5。
 */
export function clampWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * 确保数据目录存在。
 */
export function ensureStore() {
  const dir = storeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 追加一行，并保证它不会和上一行粘在一起。
 *
 * 旧文件末尾可能没有换行（上次写到一半、回滚失败、或被外部工具编辑过）。
 * 直接 appendFileSync 会把两条 JSON 粘成一行，`loadAll` 只能跳过它 ——
 * **旧记录和新记录一起静默失效**。
 *
 * 2026-11-03 修（外部审查 P0-2）：批量写那条路径早就有这个检查，
 * 单条写的两处（appendChain / appendChainEvent）漏了。
 *
 * @param line - 已带结尾换行的一行文本。
 */
function appendLineSafely(line) {
  ensureStore();
  const path = storePath();
  let prefix = '';
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        // 10 = '\n'：末尾不是换行就补一个
        if (last[0] !== 10) prefix = '\n';
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw Object.assign(new Error('STORE_READ_FAILED (' + String(error?.code || 'IO') + '): ' + String(error?.message || error)), { code: 'STORE_READ_FAILED', cause: error });
    }
    // Only a missing file is a normal first append.
  }
  appendFileSync(path, prefix + line, 'utf8');
}

/**
 * 追加一条记录并落盘。
 *
 * @param input - 已清洗的字段。
 * @returns 落盘后的完整记录。
 */
export function appendChain(input) {
  return withStoreLock(() => appendChainUnlocked(input));
}

function appendChainUnlocked(input) {
  requireWritableStore();
  ensureStore();
  const record = {
    id: newId(),
    ts: new Date().toISOString(),
    judgement: cleanText(input.judgement),
    conclusion: cleanText(input.conclusion),
    evidence: cleanList(input.evidence),
    hesitation: cleanList(input.hesitation),
    weight: clampWeight(input.weight),
    tags: cleanList(input.tags),
  };
  if (typeof input.eventId === 'string' && input.eventId.trim()) record.eventId = input.eventId;
  // 走 appendLineSafely：它会检查前置换行，不会把两条 JSON 粘成一行。
  appendLineSafely(`${JSON.stringify(record)}\n`);
  return record;
}

/**
 * 批量追加已准备好的记录/事件，只 flush 一次，不改旧工具的写入路径。
 * 同步执行期间同进程不会插入其他写入。失败时回滚本次尾部；若回滚也失败，
 * 核对文件中的完整行前缀，返回确实落盘的行数（无法核对时为 null）。
 * 跨进程锁覆盖读取、写入、回滚和核对；不承诺断电原子性，错误必须由调用方报告。
 */
export function appendChainBatch(rows) {
  if (rows.length === 0) return { written: 0, error: '', rollbackError: '' };
  try { return withStoreLock(() => appendChainBatchUnlocked(rows)); } catch (error) {
    const result = error.storeResult || { written: 0, error: '', rollbackError: '' };
    return { ...result, error: [result.error, error.message || String(error)].filter(Boolean).join('; ') };
  }
}

function appendChainBatchUnlocked(rows) {
  if (rows.length === 0) return { written: 0, error: '', rollbackError: '' };
  let fd;
  let startSize;
  let lines;
  let separator = '';
  const result = { written: 0, error: '', rollbackError: '' };
  try {
    requireWritableStore();
    lines = rows.map((row) => `${JSON.stringify(row)}\n`);
    ensureStore();
    fd = openSync(storePath(), 'a+');
    startSize = fstatSync(fd).size;
    // 旧文件可能没有末尾换行，不能把新记录粘到旧行上。
    if (startSize > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, startSize - 1);
      if (last[0] !== 10) separator = '\n';
    }
    const payload = Buffer.from(separator + lines.join(''), 'utf8');
    let offset = 0;
    while (offset < payload.length) {
      const size = writeSync(fd, payload, offset, payload.length - offset);
      if (size <= 0) throw new Error('batch write made no progress');
      offset += size;
    }
    result.written = rows.length;
    return result;
  } catch (error) {
    result.error = error.message || String(error);
    if (startSize !== undefined) {
      try {
        // Windows 的追加句柄不能 ftruncate；按路径另开可写句柄回滚。
        truncateSync(storePath(), startSize);
      } catch (rollbackError) {
        result.rollbackError = rollbackError.message || String(rollbackError);
        try {
          const tail = readFileSync(storePath()).subarray(startSize);
          let offset = Buffer.byteLength(separator);
          for (const line of lines) {
            const bytes = Buffer.from(line, 'utf8');
            if (tail.subarray(offset, offset + bytes.length).equals(bytes)) {
              result.written += 1;
              offset += bytes.length;
            } else {
              // loadAll 也能读取末尾没有换行、但 JSON 已完整落盘的一行。
              if (tail.length === offset + bytes.length - 1
                && tail.subarray(offset).equals(bytes.subarray(0, -1))) result.written += 1;
              break;
            }
          }
        } catch {
          result.written = null;
        }
      }
    }
    return result;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (error) {
        result.error += `${result.error ? '; ' : ''}close failed: ${error.message || String(error)}`;
      }
    }
  }
}

/** 同事件推翻：同步完成查重、写入与退役；复用人工 supersede 的事件形状。 */
export function appendChainWithAutoRetirement(input) {
  return withStoreLock(() => appendChainWithAutoRetirementUnlocked(input));
}

function appendChainWithAutoRetirementUnlocked(input) {
  const snapshot = requireWritableStore();
  const eventId = typeof input.eventId === 'string' && input.eventId.trim() ? input.eventId : '';
  const judgement = cleanText(input.judgement);
  // 保险①：推翻词必须出现在 judgement 前段（至少前 12 字、最多前 60%），
  // 避免正文里引用或否定式表达（"这条不是要作废别人"）误触发整组退役。
  const head = judgement.slice(0, Math.max(12, Math.ceil(judgement.length * 0.6)));
  const hitWord = ['作废', '取代', '废弃', '推翻', '改成', '不再', '换成', '已过时']
    .find((word) => head.includes(word));
  if (!eventId || !hitWord) return { record: appendChain(input), autoRetired: [] };

  const { entries } = snapshot;
  const peers = entries.filter((entry) => entry.eventId === eventId && !entry.superseded);
  // 重试同一 B 时复用已落盘的 B，不能把上次成功写入的 B 当作旧结论退役。
  const payload = (entry) => JSON.stringify([
    cleanText(entry.judgement), cleanText(entry.conclusion), cleanList(entry.evidence),
    cleanList(entry.hesitation), clampWeight(entry.rawWeight ?? entry.weight), cleanList(entry.tags),
  ]);
  const fingerprint = payload(input);
  const record = peers.find((entry) => payload(entry) === fingerprint) || appendChain(input);
  const autoRetired = [];
  const seen = new Set([record.id]);
  for (const entry of peers) {
    // 保险②：单次最多退役 2 条；超出的留在库里，由夜巡「同事件对账」报出来给人判。
    if (autoRetired.length >= 2) break;
    if (seen.has(entry.id) || poolOf(entry) === 'core') continue;
    seen.add(entry.id);
    appendChainEvent({ id: entry.id, type: 'supersede' });
    autoRetired.push({ id: entry.id, eventId, hitWord });
  }
  return { record, autoRetired };
}

/**
 * 追加一次记忆生命周期事件；绝不回写原记录。
 *
 * 三种事件，语义严格分开：
 *   · `touch`     —— **被想起**（检索命中 / 手动确认）。加次数、拉长半衰期。
 *   · `supersede` —— 已被更准确的记录取代，权重压到底。
 *   · `rebalance` —— **系统自动归整**（2026-10-28 新增）。只调权重，**永不改正文**，
 *                    由 `patrol.js` 的规则决定加减。delta 可正可负。
 */
export function appendChainEvent(input) {
  return withStoreLock(() => appendChainEventUnlocked(input));
}

function appendChainEventUnlocked(input) {
  requireWritableStore();
  ensureStore();
  const id = cleanText(input?.id);
  if (id === '') throw new Error('id must be a non-empty string');
  // **自动命中 vs 人工确认**（2026-10-30 元记忆）：两者都是"被想起"，但语义不同 ——
  //   · 显式 delta === 0 → `recall`（检索自动命中，我没真去看）
  //   · delta > 0，或**没给 delta** → `touch`（人确认 / 手动；不给 delta 时沿用 +0.02 的旧默认）
  // ⚠️ 两者在 materialize() 里**都累计 touchCount**，旧数与衰减拉伸都不会丢。
  const numericDelta = Number(input?.delta);
  const wantsRecall = input?.type === 'recall'
    || ((input?.type === undefined || input?.type === 'touch')
      && Number.isFinite(numericDelta) && numericDelta === 0);
  const type = input?.type === 'supersede'
    ? 'supersede'
    : (input?.type === 'rebalance'
      ? 'rebalance'
      // **人工定池**（2026-10-29）：由 chain_touch 的 set-pool 动作写入。
      // 只带 pool，不带 delta —— 它改的是"归哪个池"，不是权重。
      : (input?.type === 'retag' ? 'retag' : (wantsRecall ? 'recall' : 'touch')));
  // ⚠️ 不能写 `Number(input?.delta) || 0.02`：那样**传 0 会被当成"没传"补成 0.02**。
  // 三种事件允许的区间不同，必须分开：
  //   · touch     [0, +0.05]，不给默认 +0.02（手动确认）；自动命中传 0
  //   · rebalance [-0.10, +0.05]，**必须显式给非零 delta**（一次只挪一小步）
  //   · supersede 固定 0
  const rawDelta = Number(input?.delta);
  let delta = 0;
  if (type === 'touch') {
    delta = Number.isFinite(rawDelta) ? Math.max(0, Math.min(0.05, rawDelta)) : 0.02;
  } else if (type === 'rebalance') {
    if (!Number.isFinite(rawDelta) || rawDelta === 0) {
      throw new Error('rebalance event requires a non-zero numeric delta');
    }
    delta = Math.max(-0.10, Math.min(0.05, rawDelta));
  }
  const event = { type, id, ts: new Date().toISOString(), delta };
  if (type === 'rebalance') event.reason = cleanText(input?.reason) || 'patrol';
  if (type === 'retag') {
    const pool = cleanText(input?.pool);
    if (pool === '') throw new Error('retag event requires a pool key');
    // 池名必须是真池子：写错会静默落兜底，等于"定了跟没定一样"。
    if (poolDef(pool).key !== pool) {
      throw new Error('unknown pool "' + pool + '" for retag');
    }
    event.pool = pool;
    delete event.delta;          // 定池不改权重，别留一个误导性的 0
  }
  // 单条写也要走 appendLineSafely：否则旧文件末尾缺换行时会把两行粘成一行。
  appendLineSafely(`${JSON.stringify(event)}\n`);
  return event;
}

/**
 * 计算一条非原则记忆在"久未被使用"后的有效权重。
 *
 * **被想起过的记忆淡得更慢**（对应 living-memory 的 fadement 思路）：
 * 半衰期乘以 `1 + 0.6·log₂(1 + 被想起次数)`，上限 4 倍。
 *   0 次 → 180 天（原值）；1 次 → 288 天；3 次 → 约 400 天；7 次以上 → 封顶 720 天。
 *
 * 为什么是 log：第一次被想起最值钱，之后边际递减 ——
 * 一条被反复确认的原则性结论不该和"只提过一次的细节"同一个半衰期。
 *
 * @param weight - 已加过手动确认 delta 的权重。
 * @param lastActiveTs - 最后一次被写或被想起的时间。
 * @param pool - 所属池子（core / fact / skill / dailyCore / dailyPartial）。
 * @param touchCount - 被想起/被确认的总次数。
 */
function decayedWeight(weight, lastActiveTs, pool, touchCount = 0) {
  const def = poolDef(pool);
  // 核心池永不衰减 —— 那是"你是谁"，不该因为几周没提就变淡。
  if (!Number.isFinite(def.halfLifeDays)) return weight;
  const activeMs = Date.parse(String(lastActiveTs ?? ''));
  if (!Number.isFinite(activeMs)) return weight;
  // **宽限期也按池子走**：核心没有年龄惩罚，片面日常几乎立刻开始淡。
  const grace = Number.isFinite(def.graceDays) ? def.graceDays : WEIGHT_DECAY_GRACE_DAYS;
  const idleDays = Math.max(0, (Date.now() - activeMs) / 86_400_000 - grace);
  if (idleDays <= 0) return weight;
  const recalled = Math.max(0, Number(touchCount) || 0);
  const stretch = Math.min(4, 1 + 0.6 * Math.log2(1 + recalled));
  // 保留 0.1 的"档案底色"：忘掉不等于凭空删掉。
  return Math.max(0.1, weight * Math.pow(0.5, idleDays / (def.halfLifeDays * stretch)));
}

/** 将追加事件归并到原记录；返回值保持旧字段兼容，并额外给出生命周期信息。 */
function materialize(entries, events) {
  const state = new Map();
  const blank = () => ({ touchCount: 0, recallCount: 0, touchDelta: 0, lastTouched: '', lastManualTouched: '', superseded: false, rebalanceSum: 0, rebalanceCount: 0, lastRebalance: '', poolOverride: '' });
  for (const event of events) {
    if (!state.has(event.id)) state.set(event.id, blank());
    const item = state.get(event.id);
    if (event.type === 'supersede') item.superseded = true;
    if (event.type === 'touch') {
      item.touchCount += 1;
      item.touchDelta += Number(event.delta) || 0;
      if (String(event.ts) > item.lastTouched) item.lastTouched = String(event.ts);
      // 人工确认的时刻单独记：这是"被验证过"，与"被想起"不是一回事。
      //
      // ⚠️ 2026-10-30 她审出来的坑：原来**任何** touch 都写这个字段，
      // 于是自动命中（delta=0）也被算成"被人确认过" —— 那不是保守，是假装被验证过。
      // 判据只能用 delta：>0 才是人工（chain_touch 传 0.05），===0 是自动命中。
      if (Number(event.delta) > 0 && String(event.ts) > item.lastManualTouched) {
        item.lastManualTouched = String(event.ts);
      }
    }
    // 自动命中（2026-10-30）：**也算一次"被想起"**（touchCount 一起涨，旧的衰减拉伸不变），
    // 但 delta 恒为 0、且**不算人工确认** —— 元记忆靠这个区分"见过"和"看过"。
    if (event.type === 'recall') {
      item.touchCount += 1;
      item.recallCount += 1;
      if (String(event.ts) > item.lastTouched) item.lastTouched = String(event.ts);
    }
    // 自动归整：**只累计权重偏移，绝不碰正文，也不算"被想起"**（不更新 lastTouched）。
    if (event.type === 'rebalance') {
      item.rebalanceSum += Number(event.delta) || 0;
      item.rebalanceCount += 1;
      if (String(event.ts) > item.lastRebalance) item.lastRebalance = String(event.ts);
    }
    // 人工定池：**后写的覆盖先写的**（事件流天然有序，直接赋值即可）。
    if (event.type === 'retag' && String(event.pool ?? '') !== '') item.poolOverride = String(event.pool);
  }
  return entries.map((entry) => {
    const life = state.get(entry.id) || blank();
    const baseWeight = clampWeight(entry.weight);
    // supersede 压到底；否则 = 原始 + 手动确认 + 系统归整，夹在 0~1。
    const reinforced = life.superseded
      ? 0.1
      : clampWeight(baseWeight + life.touchDelta + life.rebalanceSum);
    const lastActive = life.lastTouched || entry.ts;
    // 归哪个池：标签给基础池，`touchCount` 决定要不要从片面日常升进核心日常。
    // 所以必须把 touchCount 一起喂进去 —— 少了它，升级永远不会发生。
    const pool = poolOf({ ...entry, touchCount: life.touchCount, poolOverride: life.poolOverride });
    return {
      ...entry,
      rawWeight: baseWeight,
      pool,
      weight: decayedWeight(reinforced, lastActive, pool, life.touchCount),
      touchCount: life.touchCount,
      // 元记忆的三个派生量（见 lib/meta.js）：自动命中数 / 总想起数 / 最后一次人确认。
      recallCount: life.recallCount,
      lastManualTouched: life.lastManualTouched || null,
      lastTouched: life.lastTouched || null,
      superseded: life.superseded,
      // 归整的累计偏移与次数：审计与"是否已经动过"都靠它。
      rebalanceSum: life.rebalanceSum,
      rebalanceCount: life.rebalanceCount,
      lastRebalance: life.lastRebalance || null,
      // 人工定过的池（空串 = 没定过，走标签推导）
      poolOverride: life.poolOverride || '',
    };
  });
}

/**
 * 读取全部记录。
 *
 * 坏行（JSON 解析失败、或不是对象）会被跳过并计数——一条脏数据不该让整次调用失败。
 *
 * @returns `{ entries, skipped, error }`; entries remains an array on I/O failure; writers must check error.
 */
export function loadAll() {
  try { return withStoreLock(loadAllUnlocked); } catch (error) {
    return { entries: [], skipped: 0, error: String(error?.code || '').startsWith('LOCK_')
      ? error.message : 'STORE_READ_FAILED (' + String(error?.code || 'IO') + '): ' + String(error?.message || error) };
  }
}

function loadAllUnlocked() {
  const path = storePath();
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], skipped: 0, error: '' };
    return { entries: [], skipped: 0,
      error: 'STORE_READ_FAILED (' + String(error?.code || 'IO') + '): ' + String(error?.message || error) };
  }
  const entries = [];
  const events = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        skipped += 1;
        continue;
      }
      if (typeof parsed.id !== 'string' || parsed.id === '') {
        skipped += 1;
        continue;
      }
      // 事件都走这里；漏认一种就会被当成"记录"，混进 entries 里变成脏数据。
      // ⚠️ 2026-10-30：`recall`（检索自动命中）**必须**在这张名单里 —— 漏了它，每一次自动命中
      //    都会变成一条 judgement 为空的假记录，注入里立刻出现"数了 N 条却打不出行"。
      if (parsed.type === 'touch' || parsed.type === 'recall' || parsed.type === 'supersede' || parsed.type === 'rebalance' || parsed.type === 'retag') {
        events.push(parsed);
        continue;
      }
      entries.push(parsed);
    } catch {
      skipped += 1;
    }
  }
  return { entries: materialize(entries, events), skipped, error: '' };
}

/**
 * 一条记录的可搜索正文（小写），用于关键词匹配。
 * @param entry - 记录。
 * @returns 拼好的可搜索文本。
 */
export function searchableText(entry) {
  const parts = [
    entry.judgement,
    entry.conclusion,
    ...(Array.isArray(entry.evidence) ? entry.evidence : []),
    ...(Array.isArray(entry.hesitation) ? entry.hesitation : []),
    ...(Array.isArray(entry.tags) ? entry.tags : []),
  ];
  return parts.filter((part) => typeof part === 'string').join(' ').toLowerCase();
}

/**
 * 按条件过滤记录。
 *
 * @param entries - 全部记录。
 * @param filter - 过滤条件。
 * @param filter.query - 关键词（小写化后做子串匹配；空则不筛）。
 * @param filter.since - 起始日期 `YYYY-MM-DD`（含当天）。
 * @param filter.minWeight - 权重下限。
 * @returns 命中的记录，按时间倒序（新的在前）。
 */
export function filterChains(entries, filter = {}) {
  const query = typeof filter.query === 'string' ? filter.query.trim().toLowerCase() : '';
  let sinceMs = Number.NEGATIVE_INFINITY;
  if (typeof filter.since === 'string' && filter.since.trim() !== '') {
    const parsed = Date.parse(filter.since.trim());
    if (Number.isFinite(parsed)) sinceMs = parsed;
  }
  const minWeight = Number.isFinite(Number(filter.minWeight)) ? Number(filter.minWeight) : Number.NEGATIVE_INFINITY;

  const hits = entries.filter((entry) => {
    const ts = Date.parse(entry.ts);
    if (Number.isFinite(sinceMs) && (!Number.isFinite(ts) || ts < sinceMs)) return false;
    const weight = Number(entry.weight);
    if (Number.isFinite(minWeight) && (!Number.isFinite(weight) || weight < minWeight)) return false;
    if (query !== '' && !searchableText(entry).includes(query)) return false;
    return true;
  });

  hits.sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return String(b.id).localeCompare(String(a.id));
  });
  return hits;
}

/** At most two live companions across all hits, with only a single judgement line. */
export function sameEventEntries(entries, hits) {
  const seen = new Set(hits.map((e) => String(e.id)));
  const events = new Set(hits.map((e) => e.eventId).filter((id) => typeof id === 'string' && id.trim()));
  const extra = [];
  for (const entry of entries) {
    if (extra.length >= 2) break;
    if (entry.superseded === true || !events.has(entry.eventId) || seen.has(String(entry.id))) continue;
    seen.add(String(entry.id));
    extra.push({ id: String(entry.id), judgement: cleanText(entry.judgement), eventId: entry.eventId, sameEvent: true });
  }
  return extra;
}

/** Shared integrity check: incomplete event folds must not be treated as a clean store. */
export function storeReadIssue(snapshot) {
  if (snapshot.error) return snapshot.error;
  if (snapshot.skipped > 0) return 'STORE_CORRUPT: ' + snapshot.skipped + ' invalid event-stream lines';
  return '';
}

/** Fail before generating ids, creating files or appending to an unreadable/corrupt stream. */
function requireWritableStore() {
  const snapshot = loadAll();
  const issue = snapshot.error || storeReadIssue(snapshot);
  if (issue) throw Object.assign(new Error(issue), { code: snapshot.error ? 'STORE_READ_FAILED' : 'STORE_CORRUPT' });
  return snapshot;
}

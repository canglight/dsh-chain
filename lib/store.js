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
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  FIELD_MAX,
  LIST_MAX,
  WEIGHT_DECAY_GRACE_DAYS,
  WEIGHT_DECAY_HALF_LIFE_DAYS,
  storeDir,
  storePath,
} from './config.js';
import { poolDef, poolOf } from './pools.js';

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
 * 追加一条记录并落盘。
 *
 * @param input - 已清洗的字段。
 * @returns 落盘后的完整记录。
 */
export function appendChain(input) {
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
  // 末尾补换行，保证下一条从新行开始；即使上次写到一半也不会粘在一起。
  appendFileSync(storePath(), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
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
  appendFileSync(storePath(), `${JSON.stringify(event)}\n`, 'utf8');
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
      // ⚠️ 2026-10-30 用户审出来的坑：原来**任何** touch 都写这个字段，
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
 * @returns `{ entries, skipped }`。
 */
export function loadAll() {
  const path = storePath();
  if (!existsSync(path)) return { entries: [], skipped: 0 };
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { entries: [], skipped: 0 };
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
  return { entries: materialize(entries, events), skipped };
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

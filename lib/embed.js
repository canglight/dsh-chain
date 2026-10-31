/**
 * 本地语义检索（2026-10-31 加）。
 *
 * **为什么只在这两处用**：
 *   ① `chain_recall` 工具（异步）—— 我主动去翻记忆时，换说法/时间说法也能翻到；
 *   ② 夜巡（后台）—— 顺手把新条目向量化。
 *
 * **为什么不进每轮注入**：注入是**同步**的（`systemPrompt.section` 的回调必须当场返回字符串），
 * 而算一条 query 的向量是异步的（要 await 模型）。塞不进去，硬塞就是骗自己。
 * 所以每轮注入仍然走关键词路，语义只在我主动检索时生效。
 *
 * **依赖是可选**：`@huggingface/transformers` 装在 `optionalDependencies`，
 * 装不上/模型下不下来 → `embedReady()` 为 false → 所有调用方自动退回关键词路，不影响任何现有功能。
 *
 * 实测成本（131 条真库）：模型加载 10.3s（一次性）、向量化 5ms/条、查询 10–30ms、API 费 0。
 *
 * @module dsh-chain-shared/embed
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { storeDir } from './config.js';

const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const VEC_FILE = 'vec.json';

/** 模型实例（懒加载，进程内复用）。 */
let pipePromise = null;
let pipeOk = false;
let lastError = '';

/** 向量缓存：id → Float32Array。进程内只在第一次读盘。 */
let cache = null;

/** 最近一次构建/读盘的时间，给报告用。 */
let cacheMeta = { builtAt: 0, count: 0 };

/**
 * 模型能不能用（不抛错）。
 *
 * @returns 已成功加载过返回 true；从没加载过返回 false（不代表不能加载）。
 */
export function embedReady() {
  return pipeOk;
}

/** 最近一次失败原因（给设置页/日志看，不抛）。 */
export function embedError() {
  return lastError;
}

function vecPath() {
  return join(storeDir(), VEC_FILE);
}

async function getPipe() {
  if (pipePromise !== null) return pipePromise;
  pipePromise = (async () => {
    try {
      // 国内直连 HF 常不通，默认走镜像；用户可自行覆盖。
      if (!process.env.HF_ENDPOINT) process.env.HF_ENDPOINT = 'https://hf-mirror.com';
      // transformers 带 sharp 0.34，而宿主用 0.35；Windows 同名 DLL 会串用。
      // 隔离整个模型运行时，既保留语义检索，也不把旧 DLL 装进宿主进程。
      const worker = fork(fileURLToPath(new URL('./embed-worker.js', import.meta.url)), [], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT },
      });
      let serial = 0;
      const pending = new Map();
      function fail(error) {
        pipeOk = false; pipePromise = null;
        lastError = String(error.message || error);
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
        pending.clear();
      }
      worker.on('error', fail);
      worker.on('exit', (code) => fail(new Error('语义子进程退出：' + code)));
      worker.on('message', (message) => {
        const item = pending.get(message.id); if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        if (pending.size === 0) { worker.unref(); worker.channel?.unref(); }
        if (message.error) item.reject(new Error(message.error));
        else item.resolve(message.data);
      });
      function call(type, text) {
        return new Promise((resolve, reject) => {
          const id = ++serial;
          worker.ref(); worker.channel?.ref();
          const timer = setTimeout(() => { fail(new Error('语义子进程响应超时')); worker.kill(); }, 180000);
          pending.set(id, { resolve, reject, timer });
          worker.send({ id, type, text }, (error) => { if (error) { fail(error); worker.kill(); } });
        });
      }
      await call('ready');
      const extractor = async (text) => ({ data: await call('embed', text) });
      pipeOk = true;
      return extractor;
    } catch (error) {
      lastError = String(error?.message ?? error);
      pipeOk = false;
      throw error;
    }
  })();
  return pipePromise;
}

/**
 * 把一段文本变成归一化向量。
 *
 * @param text - 任意文本（内部截断到 400 字符，够表达一条记忆的标题）。
 * @returns `Float32Array`。
 */
export async function embedText(text) {
  const extractor = await getPipe();
  const out = await extractor(String(text ?? '').slice(0, 400), { pooling: 'mean', normalize: true });
  return Float32Array.from(out.data);
}

/** 一条记忆用来向量化的正文（标题 + 结论 + 标签）。 */
function docTextOf(entry) {
  const tags = Array.isArray(entry?.tags) ? entry.tags.join(' ') : '';
  return [entry?.judgement, entry?.conclusion, tags].filter(Boolean).join('。');
}

/** 读盘上的向量缓存（不加载模型，纯 IO）。 */
function loadCache() {
  if (cache !== null) return cache;
  cache = new Map();
  const p = vecPath();
  if (!existsSync(p)) return cache;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (raw && raw.model === MODEL_ID && raw.vectors && typeof raw.vectors === 'object') {
      for (const [id, arr] of Object.entries(raw.vectors)) {
        if (Array.isArray(arr) && arr.length > 0) cache.set(String(id), Float32Array.from(arr));
      }
      cacheMeta = { builtAt: Number(raw.builtAt) || 0, count: cache.size };
    }
  } catch {
    /* 缓存坏了就当没有，重新建 */
  }
  return cache;
}

/** 把缓存写回盘。 */
function saveCache() {
  const p = vecPath();
  try {
    const dir = storeDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const vectors = {};
    for (const [id, v] of cache) vectors[id] = Array.from(v);
    writeFileSync(p, JSON.stringify({ model: MODEL_ID, builtAt: cacheMeta.builtAt, vectors }), 'utf8');
  } catch {
    /* 写不进去不影响本次检索 */
  }
}

/**
 * 补齐向量（**后台用**，例如夜巡）。
 *
 * @param entries - 全部条目。
 * @param options - `{ max }`：这次最多算多少条（默认 40，防止一次卡太久）。
 * @returns `{ added, total, skipped }`
 */
export async function buildVectors(entries, options = {}) {
  const max = Math.max(1, Number(options.max) || 40);
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && e.id != null && e.superseded !== true,
  );
  const map = loadCache();
  // 清掉已经不存在的（归档/取代的条目不再占地方）
  const alive = new Set(list.map((e) => String(e.id)));
  for (const id of [...map.keys()]) if (!alive.has(id)) map.delete(id);

  let added = 0;
  for (const e of list) {
    if (added >= max) break;
    const id = String(e.id);
    if (map.has(id)) continue;
    try {
      const v = await embedText(docTextOf(e));
      map.set(id, v);
      added += 1;
    } catch {
      break;   // 模型不可用就别硬撑，交给关键词路
    }
  }
  if (added > 0) {
    cacheMeta = { builtAt: Date.now(), count: map.size };
    saveCache();
  }
  return { added, total: map.size, skipped: Math.max(0, list.length - map.size) };
}

/**
 * 语义检索（**异步**，只给 tool / 夜巡 这种能 await 的地方用）。
 *
 * @param entries - 候选条目。
 * @param userText - 查询原话。
 * @param options - `{ max }` 取前几条（默认 5）。
 * @returns `[{ entry, score }]`；模型或缓存不可用时返回空数组（调用方退回关键词）。
 */
export async function semanticTop(entries, userText, options = {}) {
  const max = Math.max(1, Number(options.max) || 5);
  const text = String(userText ?? '').trim();
  if (text === '') return [];
  const map = loadCache();
  if (map.size === 0) return [];

  let qv = null;
  try {
    qv = await embedText(text);
  } catch {
    return [];
  }

  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && e.id != null && e.superseded !== true,
  );
  const scored = [];
  for (const e of list) {
    const v = map.get(String(e.id));
    if (!v || v.length !== qv.length) continue;
    let s = 0;
    for (let i = 0; i < v.length; i += 1) s += v[i] * qv[i];
    scored.push({ entry: e, score: Number(s.toFixed(4)) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}

/** 缓存状态（给报告/设置页看）。 */
export function vectorStats() {
  const map = loadCache();
  return { count: map.size, builtAt: cacheMeta.builtAt, ready: pipeOk, error: lastError };
}

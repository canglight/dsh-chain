/**
 * 工作记忆块：从她的话里认出「还没做完的事」。
 *
 * 设计约束（细节见 tools/working-memory-README.md）：
 *   1. **不调用模型** —— 纯正则，每轮都跑；
 *   2. **最多注入 3 条** —— 多了就不是工作记忆；
 *   3. **它会消失** —— 收尾词命中删（只删相关的），3 天没提起也删。
 *
 * 它**不属于记忆池**：不衰减、不检索、不进星云图，单独存 working.json。
 * 混进 chains.jsonl 会污染夜巡统计（"从没被想起"那节会把待办全列出来）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { storeDir } from './config.js';

const MAX_ITEMS = 12;      // 存多少条（注入只取前 3）
const INJECT_LIMIT = 3;    // 注入几条
const EXPIRE_MS = 3 * 86_400_000;

const TODO_PATTERNS = [
  /(?:记得|别忘了|提醒我)([^。！？!?\n]{2,28})/g,
  /(?:待会|等会|一会儿|等下|晚点|回头)([^。！？!?\n]{2,28})/g,
  /(?:明天|后天|今晚|下午|晚上)([^。！？!?\n]{2,28})/g,
  /我(?:得|要|准备)([^。！？!?\n]{2,28})/g,
];
const PROMISE_PATTERN = /(?:答应过?|说好)([^。！？!?\n]{2,28})/g;
const DONE_PATTERN = /(?:好了|弄完了|搞定了|不用了|完成了|做完了|改好了|发过去了|已经[^。！？!?\n]{0,6}了)/;

/** 字符二元组，用来判断"这条收尾话删不删这条待办"。 */
function bigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 从一句话里抽待办/承诺。
 *
 * ⚠️ 先**按分句切**再抽（2026-10-29 实测：不切的话一句
 * 「明天记得问我吃没吃饭，另外待会帮我看看那个日志」会抽出三条互相包含的，
 * 注入块直接变成重复刷屏）。
 *
 * @param text - 用户原话。
 * @returns `Array<{ text, kind }>`，最多 3 条。
 */
export function extractWorking(text) {
  const raw = String(text ?? '').trim();
  if (raw.length < 4) return [];
  // 分句：标点 + 常见连接词
  const segments = raw
    .split(/[。！？!?\n，,；;]|另外|然后|还有|并且|顺便/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);

  const out = [];
  const seen = [];
  const push = (phrase, kind) => {
    const cleaned = phrase.replace(/\s+/g, ' ').replace(/^[，,。、]/, '').trim().slice(0, 40);
    if (cleaned.length < 4) return;
    // 互相包含的只留一条（含得更少的那个更具体）
    if (seen.some((s) => s === cleaned || s.includes(cleaned) || cleaned.includes(s))) return;
    seen.push(cleaned);
    out.push({ text: cleaned, kind });
  };

  for (const seg of segments) {
    // **承诺先抽**：不然「答应过你明天做 X」会先被「明天」规则抓成 todo，
    // 而 containment 去重又会把后面那条 promise 丢掉（2026-10-29 实测）。
    PROMISE_PATTERN.lastIndex = 0;
    let p = PROMISE_PATTERN.exec(seg);
    while (p !== null) {
      push(p[0], 'promise');
      p = PROMISE_PATTERN.exec(seg);
    }
    for (const pattern of TODO_PATTERNS) {
      pattern.lastIndex = 0;
      let m = pattern.exec(seg);
      while (m !== null) {
        push(m[0], 'todo');
        m = pattern.exec(seg);
      }
    }
  }
  return out.slice(0, 3);
}

/** 这句话是在"收尾"吗。 */
export function isDone(text) {
  return DONE_PATTERN.test(String(text ?? ''));
}

/**
 * 用一条用户消息更新工作记忆。
 *
 * @param state - 当前状态 `{ items: [...] }`（就地修改并返回）。
 * @param userText - 用户这句话。
 * @param now - 时间戳（测试可注入）。
 * @returns 新状态。
 */
export function updateWorking(state, userText, now = Date.now()) {
  const items = Array.isArray(state?.items) ? state.items.slice() : [];

  // 1. 过期清理
  const alive = items.filter((it) => Number.isFinite(it?.at) && now - it.at < EXPIRE_MS);

  // 2. 收尾：只删跟这句收尾话相关的（共享 ≥2 个二元组）
  const text = String(userText ?? '');
  let kept = alive;
  if (isDone(text)) {
    const target = bigrams(text);
    kept = alive.filter((it) => {
      const grams = bigrams(it.text);
      let shared = 0;
      for (const g of target) if (grams.has(g)) shared += 1;
      return shared < 2;   // 相关才删
    });
  }

  // 3. 新增
  for (const found of extractWorking(text)) {
    if (kept.some((it) => it.text === found.text)) continue;
    kept.push({ text: found.text, kind: found.kind, at: now });
  }

  // 4. 上限：留最新的
  kept.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { items: kept.slice(0, MAX_ITEMS) };
}

/**
 * 工作记忆的文件路径（跟 chains.jsonl 分开存）。
 * @returns 绝对路径。
 */
export function workingPath() {
  return join(storeDir(), 'working.json');
}

/**
 * 读工作记忆（读坏了就当空的，不抛）。
 * @returns `{ items: Array<{ text, kind, at }> }`
 */
export function readWorking() {
  const path = workingPath();
  if (!existsSync(path)) return { items: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return {
      items: items
        .filter((it) => it && typeof it.text === 'string' && it.text.trim() !== '')
        .map((it) => ({
          text: String(it.text).slice(0, 50),
          kind: it.kind === 'promise' ? 'promise' : 'todo',
          at: Number.isFinite(Number(it.at)) ? Number(it.at) : 0,
        })),
    };
  } catch {
    return { items: [] };
  }
}

/**
 * 写工作记忆（失败不抛 —— 它只是便签，不能因为写不进去把注入搞掉）。
 * @param state - `{ items }`
 */
export function writeWorking(state) {
  try {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(workingPath(), JSON.stringify({ items: state?.items ?? [] }, null, 2), 'utf8');
  } catch {
    /* 便签写不进去就算了 */
  }
}

/**
 * 生成注入块（最多 3 条）。
 * @param state - 工作记忆状态。
 * @returns 文本；空则返回 `''`。
 */
export function buildWorkingBlock(state) {
  const items = Array.isArray(state?.items) ? state.items.slice(0, INJECT_LIMIT) : [];
  if (items.length === 0) return '';
  const lines = ['【还没做完的事】'];
  for (const it of items) {
    lines.push('- ' + (it.kind === 'promise' ? '答应过' : '待办') + '：' + it.text);
  }
  return lines.join('\n');
}

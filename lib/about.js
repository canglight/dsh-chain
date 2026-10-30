/**
 * 元记忆的「嘴」：关于某个话题，我到底知道什么、多可信、变过几次。
 *
 * **为什么单独一个模块**：`chain_recall` 只回正文（我说过什么），
 * 而元记忆回答的是另一类问题 ——
 *   · 有没有关于 X 的记忆？（存在性）
 *   · 这条可不可信、被推翻过吗？（可靠性）
 *   · 它为什么淡了 / 被谁取代了？（变动史）
 *
 * 这个模块只读：不改权重、不写事件、不动池子。调它**不算"想起"**
 * （想起要靠注入命中或人确认，见 store 的 recall/touch 区分）。
 *
 * @module dsh-chain/about
 */

import { metaFacts } from './meta.js';
import { rankEntriesRRF, retrievalReady } from './retrieval.js';
import { semanticTop, vectorStats } from './embed.js';
import { poolOf, poolDef } from './pools.js';

/**
 * 查「关于某件事我知道什么」。
 *
 * @param entries - 全部条目（`loadAll().entries`）。
 * @param query - 查询原话；空则退化为「最近写了什么」。
 * @param options - `{ limit, useSemantic }`。
 * @returns `{ query, count, entries, mode }`；entries 每项带可靠性字段。
 */
export async function about(entries, query, options = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.id != null);
  const live = list.filter((e) => e.superseded !== true);
  const text = String(query ?? '').trim();
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 5));

  // 关键词路 + 语义路：语义优先（实测召回高一倍），关键词补位
  const picked = [];
  const seen = new Set();
  const push = (entry) => {
    const id = String(entry?.id ?? '');
    if (id === '' || seen.has(id)) return;
    seen.add(id);
    picked.push(entry);
  };

  let mode = 'recent';
  if (text !== '') {
    mode = 'keyword';
    if (retrievalReady()) {
      try {
        for (const item of rankEntriesRRF(live, text, { max: limit })) push(item.entry);
      } catch {
        /* 关键词路挂了不影响语义路 */
      }
    }
    if (options.useSemantic !== false) {
      try {
        if (vectorStats().count > 0) {
          const sem = await semanticTop(live, text, { max: limit });
          if (sem.length > 0) mode = 'keyword+semantic';
          // 语义结果放在前面：它是"意思"上的命中，不是字面
          const head = sem.map((x) => x.entry);
          picked.length = 0;
          seen.clear();
          for (const e of head) push(e);
          for (const e of live.slice(0, 0)) push(e);
        }
      } catch {
        /* 语义不可用就只用关键词 */
      }
    }
  }

  // 补齐：不够就用最近的几条（不装沉默）
  if (picked.length < limit) {
    const sorted = live
      .filter((e) => !seen.has(String(e.id)))
      .sort((a, b) => (Date.parse(b.ts || '') || 0) - (Date.parse(a.ts || '') || 0));
    for (const e of sorted) {
      if (picked.length >= limit) break;
      push(e);
    }
  }

  const out = picked.slice(0, limit).map((entry) => {
    const facts = metaFacts(entry);
    const pool = poolOf(entry);
    return {
      id: String(entry.id),
      judgement: String(entry.judgement ?? ''),
      conclusion: String(entry.conclusion ?? ''),
      ts: String(entry.ts ?? ''),
      pool,
      poolLabel: poolDef(pool).label,
      weight: Number(entry.weight) || 0,
      // 可靠性 / 变动史：这两个字段就是元记忆和普通检索的区别
      recalled: facts.recalled,
      verified: facts.verified,
      lastVerified: facts.lastVerified,
      state: facts.state,
      legacyTouch: facts.legacyTouch,
      superseded: entry.superseded === true,
      evidenceCount: Array.isArray(entry.evidence) ? entry.evidence.length : 0,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    };
  });

  return { query: text, count: out.length, entries: out, mode };
}

/** 把 about() 的结果渲染成给模型看的文本。 */
export function renderAbout(value) {
  const lines = [`<about query="${value.query}" mode="${value.mode}" count="${value.count}">`];
  for (const e of value.entries) {
    lines.push(`- <id>${e.id}</id> [${e.poolLabel}] ${e.judgement}`);
    lines.push(
      `    可靠性: 被想起 ${e.recalled} 次 · 人工确认 ${e.verified} 次 · 状态 ${e.state}`
      + ` · 权重 ${e.weight.toFixed(2)}${e.superseded ? ' · **已被取代**' : ''}`,
    );
    if (e.evidenceCount > 0) lines.push(`    依据 ${e.evidenceCount} 条`);
    if (e.conclusion !== '') lines.push(`    结论: ${e.conclusion}`);
  }
  lines.push('</about>');
  return lines.join('\n');
}

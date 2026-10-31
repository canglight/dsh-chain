/**
 * 联想（2026-10-30）：从"这句话"出发，把相关的记忆一撮一撮拉出来。
 *
 * 这一层是「联想注入」的地基。它和检索的区别是：
 *   · 检索 = 字面对上（关键词 / 二元组），一次，只看这一句；
 *   · 联想 = 检索给出**种子**，再沿边走出去（1–2 跳），并且**被走到的边会变强**。
 *
 * 数据来源：
 *   · 种子：retrieval 的 RRF（原话命中率高）；
 *   · 边：`edges.js`（夜巡 + planEdges 长出来的 related 边，会随使用加强/衰减）；
 *   · 衰减：跳数越多权重越低（1 跳 ×0.6、2 跳 ×0.35），防止扩散成噪声。
 *
 * 三条硬规矩（都是踩出来的）：
 *   ① **没有词面证据就没有种子** —— 不让新鲜度把无关条目顶上来；
 *   ② **走线必须留额度给"自己走出来的那一跳"** —— trace 那次被种子吃光名额的教训；
 *   ③ **弱结果不如不联想** —— 节点太少时调用方应回退到旧的全量注入，而不是注入一堆噪音。
 *
 * @module dsh-chain-shared/associate
 */

import { rankEntriesRRF, retrievalReady } from './retrieval.js';
import { neighborsOf, reinforce, EDGE_MIN_WEIGHT } from './edges.js';
import { poolOf } from './pools.js';

/** 每一跳的权重折扣（跳数越远越不可信）。 */
const HOP_DISCOUNT = [1, 0.6, 0.35];
/** 联想节点的最小保留分（低于它就不要了 —— 宁可少一条）。 */
const MIN_SCORE = 0.18;

/**
 * 从一句话联想出一撮记忆。
 *
 * @param entries - `loadAll()` 的 entries。
 * @param userText - 她这一轮说的话（可空，空则返回空联想）。
 * @param options - `{ maxSeeds, maxNodes, maxHop, minShared, budgetChars }`
 * @returns `{ nodes, seeds, stats }`；`nodes` 每项 `{ id, hop, why, score }`（按 score 降序）。
 */
export function associate(entries, userText, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const text = String(userText ?? '').trim();
  const maxSeeds = Math.max(1, Number(options.maxSeeds) || 3);
  const maxNodes = Math.max(1, Number(options.maxNodes) || 8);
  const maxHop = Math.min(2, Math.max(1, Number(options.maxHop) || 2));
  const minShared = Number.isFinite(Number(options.minShared)) ? Number(options.minShared) : 4;

  const empty = { nodes: [], seeds: [], stats: { seeds: 0, walked: 0, skipped: 0 } };
  if (text === '' || list.length === 0) return empty;

  // 只让"成了条的"参与联想：海马体是原料，不该被想起（这是之前的教训）。
  const pool = list.filter((e) => e && e.id != null && e.superseded !== true && poolOf(e) !== 'hippocampus');
  if (pool.length === 0) return empty;

  const byId = new Map(pool.map((e) => [String(e.id), e]));
  const nodes = [];
  const seen = new Set();

  // ── 种子：字面命中，最多 maxSeeds 条 ──────────────────
  let seeds = [];
  if (retrievalReady()) {
    const ranked = rankEntriesRRF(pool, text, { max: maxSeeds });
    // 相关性闸门用 shared（二元组落入数），**不用分数**：RRF 第一名恒等 0.0328。
    seeds = ranked.filter((r) => Number(r.shared) >= minShared || r.shared === undefined);
    // **兜底种子**（2026-10-30 实测）：短句/换说法常常"严格门槛一个都不剩"，
    // 于是整轮退回全量注入 —— 那等于联想白做。这里补一条"弱种子"：
    // 严格门槛空了就取最靠前那条（shared ≥ 2，仍要求有词面证据，不瞎凑）。
    if (seeds.length === 0) {
      const weak = ranked.filter((r) => Number(r.shared) >= 2);
      if (weak.length > 0) seeds = weak.slice(0, 1);
    }
  }
  for (const r of seeds) {
    const entry = r.entry ?? r;
    const id = String(entry?.id ?? '');
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, hop: 0, why: '直接命中', score: 1 });
  }

  // ── 走线：从种子出发，沿真实边走到 2 跳 ────────────────
  let walked = 0;
  let current = nodes.filter((n) => n.hop === 0).map((n) => n.id);
  for (let hop = 1; hop <= maxHop; hop += 1) {
    if (nodes.length >= maxNodes) break;
    const next = [];
    for (const fromId of current) {
      if (nodes.length >= maxNodes) break;
      const fromScore = nodes.find((n) => n.id === fromId)?.score ?? 1;
      const nb = neighborsOf(fromId, { max: 3, minWeight: EDGE_MIN_WEIGHT });
      for (const n of nb) {
        if (nodes.length >= maxNodes) break;
        if (seen.has(n.id)) continue;
        if (!byId.has(n.id)) continue;
        const score = Number((fromScore * HOP_DISCOUNT[hop] * n.w * 2).toFixed(3));
        if (score < MIN_SCORE) continue;
        seen.add(n.id);
        const label = n.via.startsWith('标签') ? n.via : `共享「${n.via}」`;
        nodes.push({ id: n.id, hop, why: `${label} · 第 ${hop} 跳`, score });
        next.push(n.id);
        walked += 1;
      }
    }
    current = next;
    if (current.length === 0) break;
  }

  nodes.sort((a, b) => b.score - a.score);
  return {
    nodes,
    seeds: nodes.filter((n) => n.hop === 0).map((n) => n.id),
    stats: { seeds: nodes.filter((n) => n.hop === 0).length, walked, skipped: 0 },
  };
}

/**
 * 把这一轮"一起被想起的那一撮"记到边上（Hebbian）。
 *
 * @param ids - 这一轮真的进了注入的条目 id（种子 + 联想出来的都算）。
 * @returns 加强了几条边。
 */
export function reinforceAssociations(ids) {
  return reinforce(ids, { maxPairs: 8 });
}

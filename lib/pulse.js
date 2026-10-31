/**
 * 「这一轮到底联想到了谁」—— 进程内的最后一拍。
 *
 * **为什么要有它**：前端那个"节点滑进决策区"的动画，必须是**真实事件**驱动的。
 * 之前用节拍器/条数变化去假装，被用户一眼看出来了（「静默状态节点就在乱跳，好像故意装出来的」）。
 *
 * 所以后端在**生成注入文本的那一刻**，把这次联想的结果记在这里（只存内存，不落盘）：
 *   · 落盘会把"每轮都写一次"变成磁盘噪音，而这个数据只对"当前页面"有意义；
 *   · 进程重启就没了 —— 正好，重启后本来也不该回放旧动画。
 *
 * 谁写：`index.js` 的 buildInjection()（每轮注入时）
 * 谁读：`api.js` 的 GET /chain-shared/api/pulse（前端每 2 秒轮询）
 *
 * @module dsh-chain-shared/pulse
 */

/** 最多保留几拍（2026-10-30：从 1 拍改成 3 拍的小队列）。
 *
 * 为什么要队列：前端 2 秒轮询一次，而"两次轮询之间发生多次注入"是真实存在的
 * （她连发两句、或工具循环里多次 buildInjection）。单槽会直接把前一次覆盖掉 ——
 * 画布少演一次动画，看起来像"没反应"。
 * 只留 3 拍：再多就没意义了，视觉上也没人追得上。 */
const MAX_QUEUE = 3;
let queue = [];
let seqCounter = 0;

/**
 * 记下一拍（每轮注入调用一次）。
 *
 * @param association - `associate()` 的返回值；可为 null（联想失败）。
 * @param options - `{ minNodes }` 少于这个数算"没形成联想"（默认 3，与写入/渲染同一条线）。
 * @returns 记下的那一拍。
 */
export function recordPulse(association, options = {}) {
  const minNodes = Number.isFinite(Number(options.minNodes)) ? Number(options.minNodes) : 3;
  const nodes = Array.isArray(association?.nodes) ? association.nodes : [];
  const seeds = nodes.filter((n) => n.hop === 0).map((n) => String(n.id)).slice(0, 3);
  const walked = nodes.filter((n) => n.hop > 0).map((n) => String(n.id)).slice(0, 8);
  seqCounter += 1;
  const beat = {
    ts: Date.now(),
    seq: seqCounter,
    seeds,
    walked,
    // 这轮没形成联想（节点太少）→ 前端不要演动画：没发生的事不许装
    fallback: nodes.length < minNodes,
  };
  queue.push(beat);
  while (queue.length > MAX_QUEUE) queue.shift();
  return beat;
}

/** 读当前这一拍（只读副本，别让调用方改到内部状态）。 */
export function readPulse() {
  const latest = queue.length > 0 ? queue[queue.length - 1] : { ts: 0, seq: 0, seeds: [], walked: [], fallback: false };
  return {
    ...latest,
    seeds: [...latest.seeds],
    walked: [...latest.walked],
    // **队列**：前端拿 seq 递增逐拍消费，不再漏掉两次轮询之间的注入
    queue: queue.map((b) => ({ ...b, seeds: [...b.seeds], walked: [...b.walked] })),
  };
}

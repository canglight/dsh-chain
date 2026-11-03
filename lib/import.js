/** chain_import：逐项校验，合法操作合为一次事件流追加。 */
import { POOLS, poolOf } from './pools.js';
import { appendChainBatch, clampWeight, cleanList, cleanText, loadAll, newId, storeReadIssue, withStoreLock } from './store.js';

// Work units: 2 per append, 1 per retire id / merge group / merge id (before dedup).
export const IMPORT_MAX_UNITS = 10000;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPool = (value) => typeof value === 'string' && Object.hasOwn(POOLS, value);
const preview = (text) => {
  const chars = Array.from(text);
  return chars.length > 30 ? chars.slice(0, 30).join('') + '…' : text;
};

/**
 * 顺序为 append+定池 → retire → merge。retire/merge 只引用调用前已有的 id。
 * merged 按去重后的条目数计；同一 id 多组定池时最后一组生效。
 * dry-run 的 created.id 为空串，仅作预览，绝不生成 id 或调用写入函数。
 */
export function importChains(input = {}) {
  const result = { ok: true, dryRun: input?.dryRun === true, created: [], retired: 0, merged: 0, errors: [] };
  const fail = (where, reason) => { result.errors.push({ where, reason }); };
  if (!isObject(input)) {
    fail('$', '输入必须是对象；未执行任何操作');
    return { ...result, ok: false };
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    fail('dryRun', 'dryRun 必须是布尔值；未执行任何操作');
    return { ...result, ok: false };
  }
  for (const key of Object.keys(input)) {
    if (!['dryRun', 'appends', 'retire', 'merge'].includes(key)) fail(key, '未知顶层字段；未执行任何操作');
  }
  for (const key of ['appends', 'retire', 'merge']) {
    if (input[key] !== undefined && !Array.isArray(input[key])) fail(key, '必须是数组；未执行任何操作');
  }
  if (result.errors.length) return { ...result, ok: false };
  const appends = input.appends || [];
  const retire = input.retire || [];
  const merge = input.merge || [];
  let units = 2 * appends.length + retire.length + merge.length;
  if (units <= IMPORT_MAX_UNITS) {
    for (const group of merge) {
      if (isObject(group) && Array.isArray(group.ids)) units += group.ids.length;
      if (units > IMPORT_MAX_UNITS) break;
    }
  }
  if (units > IMPORT_MAX_UNITS) {
    fail('$', 'BATCH_TOO_LARGE: 上限 ' + IMPORT_MAX_UNITS + ' 工作单位（新增×2、退役 id/merge 组/组内 id 各×1，去重前计数）；未执行任何操作');
    return { ...result, ok: false };
  }
  const executeLocked = () => {
  const snapshot = loadAll();
  const issue = snapshot.error || storeReadIssue(snapshot);
  if (issue) {
    fail('store', issue + '；未执行任何操作');
    return { ...result, ok: false };
  }
  // pool is derived from the complete event fold.
  const known = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const operations = [];
  appends.forEach((item, i) => {
    const where = `appends[${i}]`;
    if (!isObject(item)) { fail(where, '必须是对象；未新增'); return; }
    const before = result.errors.length;
    if (Object.keys(item).some((key) => !['judgement', 'evidence', 'hesitation', 'conclusion', 'pool', 'weight', 'tags'].includes(key))) {
      fail(where, '包含未知字段；未新增');
    }
    if (!validPool(item.pool)) fail(where, `pool 非法: ${String(item.pool)}；未新增`);
    if (!Array.isArray(item.evidence) || cleanList(item.evidence).length === 0
      || item.evidence.some((value) => typeof value !== 'string' || !cleanText(value))) {
      fail(where, 'evidence 必须是非空字符串数组，不能包含空白依据；未新增');
    }
    if (typeof item.judgement !== 'string' || !cleanText(item.judgement)) {
      fail(where, 'judgement 必须是非空字符串；未新增');
    }
    for (const key of ['hesitation', 'tags']) {
      if (item[key] !== undefined
        && (!Array.isArray(item[key]) || item[key].some((value) => typeof value !== 'string'))) {
        fail(where, `${key} 必须是字符串数组；未新增`);
      }
    }
    if (item.conclusion !== undefined && typeof item.conclusion !== 'string') {
      fail(where, 'conclusion 必须是字符串；未新增');
    }
    if (item.weight !== undefined && (typeof item.weight !== 'number' || !Number.isFinite(item.weight))) {
      fail(where, 'weight 必须是有限数值；未新增');
    }
    if (result.errors.length !== before) return;
    operations.push({ where, kind: 'append', pool: item.pool, input: {
      judgement: cleanText(item.judgement), evidence: cleanList(item.evidence),
      hesitation: cleanList(item.hesitation), conclusion: cleanText(item.conclusion),
      weight: clampWeight(item.weight), tags: cleanList(item.tags),
    } });
  });
  const retiredIds = new Set();
  retire.forEach((id, i) => {
    const where = `retire[${i}]`;
    const entry = known.get(id);
    if (typeof id !== 'string' || !entry) { fail(where, `id 不存在: ${String(id)}；未退役`); return; }
    if (entry.pool !== 'hippocampus') { fail(where, `仅允许退役 hippocampus，${id} 当前为 ${entry.pool}；未退役`); return; }
    if (retiredIds.has(id)) return;
    retiredIds.add(id);
    operations.push({ where, kind: 'retire', ids: [id] });
  });
  merge.forEach((group, i) => {
    const where = `merge[${i}]`;
    if (!isObject(group)) { fail(where, '必须是对象；整组未定池'); return; }
    const before = result.errors.length;
    if (Object.keys(group).some((key) => !['ids', 'pool'].includes(key))) fail(where, '包含未知字段；整组未定池');
    if (!validPool(group.pool)) fail(where, `pool 非法: ${String(group.pool)}；整组未定池`);
    if (!Array.isArray(group.ids) || group.ids.length === 0) {
      fail(where, 'ids 必须是非空数组；整组未定池');
    } else {
      group.ids.forEach((id, j) => {
        if (typeof id !== 'string' || !known.has(id)) {
          fail(where, `ids[${j}] 不存在: ${String(id)}；整组未定池`);
        }
      });
    }
    if (result.errors.length !== before) return;
    operations.push({ where, kind: 'merge', ids: [...new Set(group.ids)], pool: group.pool });
  });

  if (result.dryRun) {
    const merged = new Set();
    for (const op of operations) {
      if (op.kind === 'append') result.created.push({ id: '', pool: poolOf({ ...op.input, poolOverride: op.pool }), judgement: preview(op.input.judgement) });
      if (op.kind === 'retire') result.retired += 1;
      if (op.kind === 'merge') op.ids.forEach((id) => merged.add(id));
    }
    result.merged = merged.size;
  } else if (operations.length > 0) {
    const rows = [];
    const ts = new Date().toISOString();
    const usedIds = new Set(known.keys());
    for (const op of operations) {
      op.start = rows.length;
      if (op.kind === 'append') {
        do { op.id = newId(); } while (usedIds.has(op.id));
        usedIds.add(op.id);
        rows.push({ id: op.id, ts, ...op.input }, { type: 'retag', id: op.id, ts, pool: op.pool });
      } else {
        for (const id of op.ids) {
          rows.push(op.kind === 'retire'
            ? { type: 'supersede', id, ts, delta: 0 }
            : { type: 'retag', id, ts, pool: op.pool });
        }
      }
      op.end = rows.length;
    }
    const batch = appendChainBatch(rows);
    const merged = new Set();
    for (const op of operations) {
      const written = batch.written === null ? 0 : Math.max(0, Math.min(op.end, batch.written) - op.start);
      if (op.kind === 'append' && written > 0) {
        result.created.push({ id: op.id, pool: poolOf({ ...op.input, poolOverride: written === 2 ? op.pool : '' }), judgement: preview(op.input.judgement) });
      }
      if (op.kind === 'retire') result.retired += written;
      if (op.kind === 'merge') op.ids.slice(0, written).forEach((id) => merged.add(id));
      if (batch.written === null || written < op.end - op.start) {
        fail(op.where, batch.written === null
          ? '写入失败且无法核对落盘状态；请先检查事件流，勿直接重试'
          : written === 0 ? '写入失败；该项未执行或已回滚'
            : op.kind === 'append' ? `判断已写入 (${op.id})，定池未完成；实际池见 created`
              : `仅完成组内前 ${written} 个去重 id 的定池，其余未执行`);
      }
    }
    result.merged = merged.size;
    if (batch.error) fail('write', `批量写入失败: ${batch.error}；`
      + (batch.rollbackError ? `回滚失败: ${batch.rollbackError}；已报告可确认的落盘结果`
        : batch.written === rows.length ? '事件均已写入，但关闭文件失败' : '本次写入已回滚或未开始'));
  }
  result.ok = result.errors.length === 0;
  return result;
  };
  try { return withStoreLock(executeLocked); } catch (error) {
    fail('store', error.message || String(error));
    return { ...result, ok: false };
  }
}

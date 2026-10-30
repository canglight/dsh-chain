/**
 * 夜巡状态（只读）—— 让 UI 能看见「它跑没跑」。
 *
 * 为什么要有这个模块（2026-10-30，作者 提的问题）：
 *   夜巡一直在正常跑，但它**只写报告文件**，界面上没有任何出口。
 *   于是「跑了」和「没跑」在用户眼里完全一样 —— 用户等了两分钟，看到的是"没动"。
 *   **一个跑完却看不见的动作，等于没做。** 这个模块只做一件事：把磁盘上的
 *   最近一次夜巡翻译成一行状态，供 `/chain-shared/api/patrol` 和画布顶部那行用。
 *
 * 只读：不触发夜巡、不改任何记忆。要跑一次请用 `chain_patrol` 工具。
 *
 * @module dsh-chain/patrol-status
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { storeDir } from './config.js';

/** 报告文件名形如 `2026-10-30.meta.json`。 */
const META_RE = /^\d{4}-\d{2}-\d{2}\.meta\.json$/;

/**
 * 读最近一次夜巡的状态。
 *
 * @returns 结构：
 *   `{ ok, date, at, localTime, trigger, total, runs, reportPath, reportBytes, sections }`
 *   没跑过时 `ok: false` + `reason: 'no-report'`（不报错，UI 显示「还没跑过」）。
 */
export function readPatrolStatus() {
  const dir = join(storeDir(), 'patrol');
  let metas;
  try {
    metas = readdirSync(dir).filter((n) => META_RE.test(n)).sort();
  } catch {
    return { ok: false, reason: 'no-report', dir };
  }
  if (metas.length === 0) return { ok: false, reason: 'no-report', dir };

  const last = metas[metas.length - 1];
  try {
    const meta = JSON.parse(readFileSync(join(dir, last), 'utf8'));
    const md = join(dir, last.replace('.meta.json', '.md'));
    const sections = Array.isArray(meta.sections) ? meta.sections : [];
    // 报告是**追加式**的：同一份文件里按段落叠加，最后一段才是最近一次。
    const latest = sections.length > 0 ? sections[sections.length - 1] : null;
    return {
      ok: true,
      date: String(meta.date ?? last.slice(0, 10)),
      at: String(latest?.at ?? meta.generatedAt ?? ''),
      localTime: String(latest?.localTime ?? ''),
      trigger: String(latest?.trigger ?? ''),
      total: Number(meta.counts?.total ?? meta.total ?? 0),
      runs: sections.length,
      reportPath: md,
      reportBytes: existsSync(md) ? statSync(md).size : 0,
      sections: sections.map((s) => ({
        localTime: String(s.localTime ?? ''),
        trigger: String(s.trigger ?? ''),
        total: Number(s.total ?? 0),
      })),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), dir };
  }
}

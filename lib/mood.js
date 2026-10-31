/**
 * 我的情绪状态 —— **一块牌，不是一本账**。
 *
 * ## 和记忆条目的区别（这是用户 2026-10-28 定的关键区分）
 *
 * 记忆是追加的：一条条留着，靠遗忘慢慢淡。
 * **情绪不是** —— 它是「此刻我什么状态」：
 *   · **唯一性**：任何时刻只有一条，新的直接覆盖旧的（不追加、不并存）
 *   · **3 小时**后开始淡，**半衰期 1 天**，强度掉到阈值以下就等于过去了
 *   · 存在单独的文件里（`mood.json`），不进 chains.jsonl、不算记忆条目
 *
 * 为什么不做成追加式：情绪如果是账本，就变成了"我今天挫败过三次"这种统计，
 * 而人感受到的是"我现在是什么心情"。**覆盖才是对的那个动作。**
 *
 * @module dsh-chain-shared/mood
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { storeDir } from './config.js';

/** 开始淡忘的小时数（3 小时以内的情绪不打折）。 */
export const MOOD_GRACE_HOURS = 3;

/** 半衰期（小时）：1 天。过了 3 小时之后，每 24 小时强度减半。 */
export const MOOD_HALF_LIFE_HOURS = 24;

/** 强度低于这个值就当它过去了 —— 不再注入，也不占任何预算。 */
export const MOOD_FADE_THRESHOLD = 0.15;

/** 强度上限（避免越写越夸张）。 */
const INTENSITY_MAX = 1;

/** 情绪牌的文件路径。 */
export function moodPath() {
  return join(storeDir(), 'mood.json');
}

/**
 * 读当前情绪牌。
 * @returns `{ ts, mood, why, intensity }` 或 null（没有/读坏了）。
 */
export function readMood() {
  const path = moodPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw.mood !== 'string' || raw.mood.trim() === '') return null;
    const intensity = Number(raw.intensity);
    return {
      ts: typeof raw.ts === 'string' ? raw.ts : '',
      mood: raw.mood.trim(),
      why: typeof raw.why === 'string' ? raw.why.trim() : '',
      intensity: Number.isFinite(intensity) ? Math.max(0, Math.min(INTENSITY_MAX, intensity)) : 0.6,
    };
  } catch {
    return null;
  }
}

/**
 * **覆盖**写情绪牌（唯一性：永远只有一条）。
 *
 * @param input - `{ mood, why?, intensity? }`
 * @returns 落盘后的牌。
 */
export function writeMood(input) {
  const mood = String(input?.mood ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (mood === '') throw new Error('mood must be a non-empty string');
  const why = String(input?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const rawIntensity = Number(input?.intensity);
  const intensity = Number.isFinite(rawIntensity)
    ? Math.max(0, Math.min(INTENSITY_MAX, rawIntensity))
    : 0.6;
  const record = { ts: new Date().toISOString(), mood, why, intensity };
  const dir = storeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(moodPath(), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/**
 * 这张牌此刻还剩多少强度。
 *
 * 公式：3 小时内不打折；之后每 24 小时减半。
 *   3 小时 → 1.00 · 27 小时 → 0.50 · 51 小时 → 0.25 · 75 小时 → 0.125（已过阈值）
 *
 * @param record - 情绪牌。
 * @param now - 当前毫秒。
 * @returns `{ ageHours, strength }`
 */
export function moodStrength(record, now = Date.now()) {
  if (!record) return { ageHours: Infinity, strength: 0 };
  const from = Date.parse(String(record.ts ?? ''));
  if (!Number.isFinite(from)) return { ageHours: Infinity, strength: 0 };
  const ageHours = Math.max(0, (now - from) / 3_600_000);
  const idle = Math.max(0, ageHours - MOOD_GRACE_HOURS);
  const strength = record.intensity * Math.pow(0.5, idle / MOOD_HALF_LIFE_HOURS);
  return { ageHours, strength };
}

/**
 * 取"现在还该被自己知道"的情绪（强度过阈值才算）。
 *
 * @param now - 当前毫秒。
 * @returns `{ mood, why, intensity, ageHours, strength }` 或 null。
 */
export function visibleMood(now = Date.now()) {
  const record = readMood();
  if (record === null) return null;
  const { ageHours, strength } = moodStrength(record, now);
  if (strength < MOOD_FADE_THRESHOLD) return null;
  return { ...record, ageHours, strength };
}

/**
 * 把「多久之前」说成人话。
 * @param ageHours - 小时数。
 * @returns 例如「刚刚」「2 小时前」「1 天前」。
 */
export function humanAge(ageHours) {
  if (!Number.isFinite(ageHours)) return '很久';
  if (ageHours < 1) return '刚刚';
  if (ageHours < 24) return `${Math.round(ageHours)} 小时前`;
  return `${Math.round(ageHours / 24)} 天前`;
}

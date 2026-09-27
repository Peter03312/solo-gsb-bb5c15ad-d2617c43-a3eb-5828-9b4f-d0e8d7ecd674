/**
 * 阅读速度修复：字素簇计数、超速检测与延长分配（纯函数，可单测）。
 *
 * 阅读速度 = 去掉空白与标点后的 Unicode 字素簇数 ÷ 字幕时长（秒）。
 * 超过可调「字数/秒」阈值的字幕需要延长时长：
 * - 目标时长 = 字数 ÷ 阈值，向上取整到毫秒；
 * - 所需延长量先均分到起止两侧（奇数毫秒多分给起点侧）；
 * - 一侧受 0 秒、相邻字幕最小间隔或已加载音频终点限制时，
 *   未分配量转给另一侧；
 * - 两侧余量仍不足则报告缺少的毫秒数，由调用方禁止提交（原字幕不变）。
 * 合法结果由调用方作为一次历史记录提交，可整体撤销/重做。
 */

import type { Constraints, Cue } from '../types';
import { normalizeCueText } from './refdiff';

/** Intl.Segmenter 的最小结构类型（tsconfig lib 为 ES2020，不内置该声明） */
interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}
type SegmenterCtor = new (
  locales?: string | string[],
  options?: { granularity?: 'grapheme' }
) => GraphemeSegmenter;

/** 惰性构造的字素簇分割器；环境不支持 Intl.Segmenter 时为 null（降级按码点计数） */
let cachedSegmenter: GraphemeSegmenter | null | undefined;

function getSegmenter(): GraphemeSegmenter | null {
  if (cachedSegmenter === undefined) {
    const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    cachedSegmenter = ctor ? new ctor(undefined, { granularity: 'grapheme' }) : null;
  }
  return cachedSegmenter;
}

/**
 * 阅读速度计数的「字数」：先 NFKC 归一化并删除所有 Unicode 空白与标点
 * （与参考差异配对的文本键同一套规则），再数 Unicode 字素簇
 * （组合字符、ZWJ 序列、旗帜等整体算 1）；环境缺少 Intl.Segmenter 时降级为码点数。
 */
export function countReadableGraphemes(text: string): number {
  const key = normalizeCueText(text);
  if (!key) return 0;
  const seg = getSegmenter();
  if (!seg) return Array.from(key).length;
  return Array.from(seg.segment(key)).length;
}

/** 毫秒比较用的浮点误差容限（字幕时间均为毫秒精度） */
const EPS = 1e-6;

/**
 * 目标时长（毫秒整数）：字数 ÷ 阈值 向上取整到毫秒。
 * 减 1e-6 吸收浮点误差，避免「恰好整除」被多进 1ms。
 */
export function targetDurationMs(chars: number, thresholdCps: number): number {
  return Math.ceil((chars * 1000) / thresholdCps - EPS);
}

/** 一条超速字幕的检测信息 */
export interface SpeedEntry {
  cue: Cue;
  /** 去空白与标点后的字素簇数 */
  chars: number;
  /** 当前阅读速度（字素簇/秒） */
  cps: number;
  /** 目标时长（秒）：字数 ÷ 阈值，向上取整到毫秒 */
  targetDuration: number;
  /** 需要延长的毫秒数（目标时长 − 当前时长，毫秒整数，恒 > 0） */
  extendMs: number;
}

/**
 * 检测阅读速度超过阈值的字幕，按时间序返回。
 * 判定等价于「目标时长（毫秒取整）> 当前时长」，即速度严格大于阈值才列出；
 * 恰好等于阈值不需要延长，不列出。阈值非正数时返回空。
 */
export function findOverspeedCues(cues: Cue[], thresholdCps: number): SpeedEntry[] {
  if (!Number.isFinite(thresholdCps) || thresholdCps <= 0) return [];
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: SpeedEntry[] = [];
  for (const cue of sorted) {
    const chars = countReadableGraphemes(cue.text);
    if (chars === 0) continue;
    const durMs = Math.round(cue.end * 1000) - Math.round(cue.start * 1000);
    if (durMs <= 0) continue;
    const targetMs = targetDurationMs(chars, thresholdCps);
    const extendMs = targetMs - durMs;
    if (extendMs <= 0) continue; // 未超速：目标时长不超过当前时长
    out.push({
      cue,
      chars,
      cps: (chars * 1000) / durMs,
      targetDuration: targetMs / 1000,
      extendMs
    });
  }
  return out;
}

/** 单条字幕的修复预览计划 */
export interface SpeedFixPlan {
  cueId: string;
  /** 去空白与标点后的字素簇数 */
  chars: number;
  /** 当前阅读速度（字素簇/秒） */
  cps: number;
  /** 目标时长（秒，毫秒精度） */
  targetDuration: number;
  /** 需要延长的毫秒数 */
  extendMs: number;
  /** 起点侧可用余量（毫秒）：受 0 秒与上一条最小间隔限制 */
  leftRoomMs: number;
  /** 终点侧可用余量（毫秒）：受下一条最小间隔与已加载音频终点限制 */
  rightRoomMs: number;
  /** 终点侧余量是否受限（无下一条且无音频时长时为 false，余量视为无限） */
  rightRoomLimited: boolean;
  /** 实际分配到起点侧的延长量（毫秒） */
  leftMs: number;
  /** 实际分配到终点侧的延长量（毫秒） */
  rightMs: number;
  /** 新起点 / 新终点（秒，毫秒精度）；余量不足时为尽力分配的结果（禁止提交） */
  newStart: number;
  newEnd: number;
  /** 两侧余量不足时还缺少的毫秒数；0 表示可提交 */
  missingMs: number;
  /** 应用修复后的全量字幕（仅该条被替换，其余保持原引用） */
  fixedAll: Cue[];
}

/**
 * 构建单条超速字幕的修复预览计划。
 * 返回 null 表示该字幕不存在、已不再超速或阈值非法（调用方应隐藏预览）。
 *
 * 分配顺序：先把延长量均分到起止两侧（奇数毫秒多分给起点侧），
 * 一侧因 0 秒 / 相邻最小间隔 / 音频终点而不足时，未分配量转给另一侧；
 * 两侧都到顶后剩余量即 missingMs（> 0 时禁止提交，原字幕不变）。
 * audioDuration ≤ 0 视为「未加载音频」，终点侧不受音频限制。
 */
export function buildSpeedFixPlan(
  cues: Cue[],
  cueId: string,
  thresholdCps: number,
  constraints: Constraints,
  audioDuration: number
): SpeedFixPlan | null {
  if (!Number.isFinite(thresholdCps) || thresholdCps <= 0) return null;
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const idx = sorted.findIndex((c) => c.id === cueId);
  if (idx < 0) return null;
  const cue = sorted[idx];
  const chars = countReadableGraphemes(cue.text);
  if (chars === 0) return null;
  const startMs = Math.round(cue.start * 1000);
  const endMs = Math.round(cue.end * 1000);
  const durMs = endMs - startMs;
  if (durMs <= 0) return null;
  const targetMs = targetDurationMs(chars, thresholdCps);
  const extendMs = targetMs - durMs;
  if (extendMs <= 0) return null; // 已不再超速（刚修复 / 阈值调高 / 字幕被改）

  // 两侧余量（毫秒，负值夹到 0）
  const minGapMs = Math.max(0, Math.round(constraints.minGap * 1000));
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;
  const leftBoundMs = prev ? Math.round(prev.end * 1000) + minGapMs : 0;
  const leftRoomMs = Math.max(0, startMs - leftBoundMs);
  let rightBoundMs = Number.POSITIVE_INFINITY;
  if (next) rightBoundMs = Math.round(next.start * 1000) - minGapMs;
  if (Number.isFinite(audioDuration) && audioDuration > 0) {
    rightBoundMs = Math.min(rightBoundMs, Math.round(audioDuration * 1000));
  }
  const rightRoomLimited = rightBoundMs !== Number.POSITIVE_INFINITY;
  const rightRoomMs = rightRoomLimited
    ? Math.max(0, rightBoundMs - endMs)
    : Number.MAX_SAFE_INTEGER;

  // 先均分（奇数毫秒多分给起点侧），受限一侧的未分配量依次转给另一侧
  const leftWant = Math.ceil(extendMs / 2);
  const rightWant = extendMs - leftWant;
  let leftMs = Math.min(leftWant, leftRoomMs);
  let rightMs = Math.min(rightWant, rightRoomMs);
  let rest = extendMs - leftMs - rightMs;
  if (rest > 0) {
    const addRight = Math.min(rest, rightRoomMs - rightMs);
    rightMs += addRight;
    rest -= addRight;
  }
  if (rest > 0) {
    const addLeft = Math.min(rest, leftRoomMs - leftMs);
    leftMs += addLeft;
    rest -= addLeft;
  }

  const newStart = (startMs - leftMs) / 1000;
  const newEnd = (endMs + rightMs) / 1000;
  const fixedAll = cues.map((c) => (c.id === cueId ? { ...c, start: newStart, end: newEnd } : c));
  return {
    cueId,
    chars,
    cps: (chars * 1000) / durMs,
    targetDuration: targetMs / 1000,
    extendMs,
    leftRoomMs,
    rightRoomMs,
    rightRoomLimited,
    leftMs,
    rightMs,
    newStart,
    newEnd,
    missingMs: rest,
    fixedAll
  };
}

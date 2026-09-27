import { useMemo, useState } from 'react';
import type { Cue } from '../types';
import type { SpeedEntry, SpeedFixPlan } from '../lib/readingSpeed';
import { secondsToSrtTime } from '../lib/srt';

interface SpeedPanelProps {
  /** 当前全部字幕（用于换算列表序号） */
  cues: Cue[];
  /** 阅读速度超过阈值的条目（时间序） */
  entries: SpeedEntry[];
  /** 字数/秒阈值（字素簇/秒） */
  threshold: number;
  onThresholdChange: (v: number) => void;
  /** 选中的待修复字幕 id；未选中为 null */
  selectedId: string | null;
  /** 选中字幕的修复预览计划；未选中或已不超限为 null */
  plan: SpeedFixPlan | null;
  /** 点击条目：选中待修复字幕并定位列表 / 时间轴 */
  onSelect: (id: string) => void;
  /** 清空修复选择（字幕保持原样） */
  onClearSelection: () => void;
  /** 余量充足时提交修复（一次历史记录，可撤销/重做） */
  onApply: () => void;
}

/** 带符号毫秒：+1,400ms / −700ms */
function signedMs(ms: number): string {
  return `${ms >= 0 ? '+' : '−'}${Math.abs(ms)}ms`;
}

/**
 * 阅读速度修复面板（停靠在舞台底部）：
 * 按「去空白与标点后的 Unicode 字素簇数 ÷ 字幕时长」检测超速字幕并列出；
 * 选中条目后预览目标时长与两侧均分的延长方案，余量不足禁止提交。
 * 检测与预览全部由 App 随字幕 / 约束 / 音频变化实时重算后传入。
 */
export default function SpeedPanel(p: SpeedPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  // 时间序序号（与字幕列表行号一致）
  const indexOf = useMemo(() => {
    const sorted = [...p.cues].sort((a, b) => a.start - b.start || a.end - b.end);
    return new Map(sorted.map((c, i) => [c.id, i + 1]));
  }, [p.cues]);

  const plan = p.plan;
  const planCue = plan ? p.cues.find((c) => c.id === plan.cueId) ?? null : null;
  const canApply = plan !== null && plan.missingMs === 0;

  return (
    <section className="speed-dock">
      <div className="speed-head">
        <button
          className="btn mini speed-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开超速条目列表' : '收起列表'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="speed-title">⏱ 阅读速度修复</span>
        <label
          className="speed-threshold"
          title="阅读速度 = 去掉空白与标点后的 Unicode 字素簇数 ÷ 字幕时长；严格超过该阈值的字幕会被列出"
        >
          阈值
          <input
            type="number"
            min={0.5}
            max={100}
            step={0.5}
            value={p.threshold}
            onChange={(e) => p.onThresholdChange(Math.max(0.5, Number(e.target.value) || 0.5))}
          />
          字/秒
        </label>
        {p.cues.length > 0 ? (
          <span className={`speed-summary ${p.entries.length > 0 ? 'has-over' : ''}`}>
            {p.entries.length > 0 ? `超限 ${p.entries.length} 条` : '无超限条目'} · 共{' '}
            {p.cues.length} 条
          </span>
        ) : (
          <span className="speed-hint">
            导入 SRT 后自动检测：字数（去空白与标点后的字素簇）÷ 时长 超过阈值的字幕会列在这里
          </span>
        )}
        {plan && (
          <div className="speed-actions">
            <button
              className="btn primary mini"
              onClick={p.onApply}
              disabled={!canApply}
              title={
                canApply
                  ? '将新时间码作为一次历史记录提交（可撤销/重做，随现有流程导出 SRT）'
                  : '两侧余量不足，禁止提交，原字幕不变'
              }
            >
              应用修复
            </button>
            <button
              className="btn mini"
              onClick={p.onClearSelection}
              title="取消选择，字幕保持原样"
            >
              取消
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="speed-body">
          {p.entries.length === 0 ? (
            <div className="speed-empty">
              {p.cues.length === 0
                ? '尚未导入 SRT 文件'
                : `所有字幕的阅读速度均不超过 ${p.threshold} 字/秒`}
            </div>
          ) : (
            <div className="speed-list">
              {p.entries.map((e) => (
                <div
                  key={e.cue.id}
                  className={['speed-row', e.cue.id === p.selectedId && 'selected']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => p.onSelect(e.cue.id)}
                  title="点击选中并预览修复方案（同时定位列表 / 时间轴与播放头）"
                >
                  <span className="speed-cps">{e.cps.toFixed(1)} 字/秒</span>
                  <span className="speed-idx">#{indexOf.get(e.cue.id)}</span>
                  <span className="speed-time">
                    {secondsToSrtTime(e.cue.start)} → {secondsToSrtTime(e.cue.end)}
                  </span>
                  <span className="speed-meta">
                    {e.chars} 字 · {(e.cue.end - e.cue.start).toFixed(3)}s · 需延长{' '}
                    {signedMs(e.extendMs)}
                  </span>
                  <span className="speed-text">{e.cue.text}</span>
                </div>
              ))}
            </div>
          )}

          {plan && planCue && (
            <div className={`speed-preview ${plan.missingMs > 0 ? 'insufficient' : ''}`}>
              <div className="speed-preview-line">
                <span className="speed-preview-label">
                  修复预览 · 第 {indexOf.get(plan.cueId)} 条
                </span>
                <span className="speed-meta">
                  {plan.chars} 字 · 当前 {(planCue.end - planCue.start).toFixed(3)}s（
                  {plan.cps.toFixed(1)} 字/秒） → 目标 {plan.targetDuration.toFixed(3)}s · 需延长{' '}
                  {signedMs(plan.extendMs)}
                </span>
              </div>
              <div className="speed-preview-line">
                <span className="speed-preview-label">延长分配</span>
                <span className="speed-meta">
                  起点 −{plan.leftMs}ms · 终点 +{plan.rightMs}ms
                </span>
                <span className="speed-room">
                  两侧余量：左 {plan.leftRoomMs}ms · 右{' '}
                  {plan.rightRoomLimited ? `${plan.rightRoomMs}ms` : '∞'}
                </span>
              </div>
              {plan.missingMs > 0 ? (
                <div className="speed-preview-line">
                  <span className="speed-missing">
                    ⚠ 两侧余量不足：还缺 {plan.missingMs}ms（需 {signedMs(plan.extendMs)}，左余量{' '}
                    {plan.leftRoomMs}ms · 右余量{' '}
                    {plan.rightRoomLimited ? `${plan.rightRoomMs}ms` : '∞'}
                    ），原字幕保持不变，禁止提交
                  </span>
                </div>
              ) : (
                <div className="speed-preview-line">
                  <span className="speed-preview-label">时间码</span>
                  <span className="speed-old">
                    {secondsToSrtTime(planCue.start)} → {secondsToSrtTime(planCue.end)}
                  </span>
                  <span className="speed-arrow">⇒</span>
                  <span className="speed-new">
                    {secondsToSrtTime(plan.newStart)} → {secondsToSrtTime(plan.newEnd)}
                  </span>
                  <span className="speed-ok">✓ 余量充足，确认后作为一次历史记录提交</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

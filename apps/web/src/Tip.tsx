/**
 * 悬浮提示（tooltip）基础设施。
 *
 * 为什么不用纯 CSS 的 `::after` + `attr(data-tip)`：
 * 主内容区 `.col` 有 `overflow-y: auto`，纯 CSS 提示会被容器裁掉，
 * 靠近边缘的按钮根本看不到提示。
 *
 * 这里的做法是把提示渲染到 document 层级的固定定位元素上，
 * 由 React 统一管理，因此永不被裁剪。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

interface TipState {
  text: string;
  x: number;
  y: number;
  place: 'top' | 'bottom';
}

type ShowFn = (text: string | null, el?: HTMLElement) => void;

const TipContext = createContext<ShowFn>(() => {});

const MAX_WIDTH = 320;
const EDGE_MARGIN = 12;

export function TipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState | null>(null);

  const show = useCallback<ShowFn>((text, el) => {
    if (!text || !el) {
      setTip(null);
      return;
    }
    const r = el.getBoundingClientRect();
    // 上方空间不足就翻到下方，避免贴顶时看不见
    const place: 'top' | 'bottom' = r.top > 150 ? 'top' : 'bottom';
    const half = Math.min(MAX_WIDTH, window.innerWidth - EDGE_MARGIN * 2) / 2;
    const x = Math.min(Math.max(r.left + r.width / 2, half + EDGE_MARGIN), window.innerWidth - half - EDGE_MARGIN);
    setTip({ text, x, y: place === 'top' ? r.top - 8 : r.bottom + 8, place });
  }, []);

  // 滚动或改变窗口大小时收起提示，避免提示与目标脱节
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [tip]);

  return (
    <TipContext.Provider value={show}>
      {children}
      {tip && (
        <div
          className="tip-layer"
          style={{
            left: tip.x,
            top: tip.y,
            maxWidth: MAX_WIDTH,
            transform: `translate(-50%, ${tip.place === 'top' ? '-100%' : '0'})`,
          }}
          role="tooltip"
        >
          {tip.text}
        </div>
      )}
    </TipContext.Provider>
  );
}

/**
 * 给任意元素挂上提示事件。用于 `<button {...useTip('...')}>`。
 * 不产生额外 DOM 包裹，因此不会破坏 flex 布局。
 */
export function useTip(text: string) {
  const show = useContext(TipContext);
  return {
    onMouseEnter: (e: { currentTarget: HTMLElement }) => show(text, e.currentTarget),
    onMouseLeave: () => show(null),
    onFocus: (e: { currentTarget: HTMLElement }) => show(text, e.currentTarget),
    onBlur: () => show(null),
  };
}

/** 文内提示标记。用于指标名、术语等非交互元素。 */
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  const show = useContext(TipContext);
  return (
    <span
      className="tip-target"
      onMouseEnter={(e) => show(text, e.currentTarget)}
      onMouseLeave={() => show(null)}
      onFocus={(e) => show(text, e.currentTarget)}
      onBlur={() => show(null)}
      tabIndex={0}
    >
      {children}
    </span>
  );
}

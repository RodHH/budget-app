import { useEffect, useRef, useState } from 'preact/hooks';
import { compactMoney, money, shortDate } from './lib.js';

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v) {
  if (v <= 0) return 10000;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

/** Cumulative spending this month vs last month, with a crosshair tooltip. */
export function SpendingLine({ current, previous, month, prevMonthLabel }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const h = 180;
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const days = Math.max(previous.length, 31);
  const max = niceMax(Math.max(...current, ...previous, 1));
  const x = (i) => pad.l + (i / (days - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const ticks = [0, max / 2, max];
  const dayLabel = (i) => shortDate(`${month}-${String(i + 1).padStart(2, '0')}`);
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const i = Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (days - 1));
    setHover(Math.max(0, Math.min(days - 1, i)));
  };
  const last = current.length - 1;
  return (
    <div>
      <div class="legend" aria-hidden="true">
        <span><i />This month</span>
        <span><i class="prev" />{prevMonthLabel}</span>
      </div>
      <div class="chart" ref={ref} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${width} ${h}`} height={h} role="img" aria-label={`Cumulative spending: ${money(current[last] || 0)} so far this month versus ${money(previous[Math.min(last, previous.length - 1)] || 0)} at the same point last month.`}>
          <g class="grid">{ticks.map((t) => <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />)}</g>
          <g class="axis">
            {ticks.map((t) => <text x={pad.l - 8} y={y(t) + 4} text-anchor="end">{compactMoney(t)}</text>)}
            {[0, 14, days - 1].map((i) => <text x={x(i)} y={h - 6} text-anchor={i === 0 ? 'start' : i === days - 1 ? 'end' : 'middle'}>{i + 1}</text>)}
          </g>
          {previous.length > 0 && <path class="series-prev" d={path(previous)} />}
          {current.length > 0 && (
            <>
              <path class="area-cur" d={`${path(current)}L${x(last)},${y(0)}L${x(0)},${y(0)}Z`} />
              <path class="series-cur" d={path(current)} />
              <circle class="dot" cx={x(last)} cy={y(current[last])} r="5" fill="var(--series-1)" />
            </>
          )}
          {hover !== null && (
            <g>
              <line class="cross" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={h - pad.b} />
              {hover <= last && <circle class="dot" cx={x(hover)} cy={y(current[hover])} r="5" fill="var(--series-1)" />}
              {hover < previous.length && <circle class="dot" cx={x(hover)} cy={y(previous[hover])} r="4.5" fill="var(--series-prev)" />}
            </g>
          )}
        </svg>
        {hover !== null && (
          <div class="tooltip" style={{ left: `${Math.min(Math.max(x(hover), 80), width - 80)}px` }}>
            <div class="strong">Day {hover + 1}{hover <= last ? ` · ${dayLabel(hover)}` : ''}</div>
            {hover <= last && <div class="num">This month: {money(current[hover])}</div>}
            {hover < previous.length && <div class="num muted">{prevMonthLabel}: {money(previous[hover])}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Top spending categories as labeled horizontal bars (single hue; labels carry identity). */
export function CategoryBars({ rows, total, onPick }) {
  const max = Math.max(...rows.map((r) => r.spent_cents), 1);
  return (
    <div class="bars" role="list">
      {rows.map((r) => (
        <div class="bar-row" role="listitem" onClick={() => onPick?.(r)} style={onPick ? 'cursor:pointer' : ''} title={`${r.name}: ${money(r.spent_cents)}`}>
          <span class="ellipsis">{r.icon} {r.name}</span>
          <span class="num strong">{money(r.spent_cents)} <span class="muted small">{total > 0 ? `${Math.round((r.spent_cents / total) * 100)}%` : ''}</span></span>
          <div class="bar-track"><div class="bar-fill" style={{ width: `${Math.max(0, (r.spent_cents / max) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

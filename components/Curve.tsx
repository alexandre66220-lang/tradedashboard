/** Minimal cumulative-curve chart: a line against a dashed zero axis, green above zero at the end, red below. */
export default function Curve({ points, label }: { points: Array<{ v: number }>; label: string }) {
  if (points.length < 2) return null;
  const W = 600, H = 120, P = 6;
  const vs = points.map((p) => p.v);
  const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
  const span = hi - lo || 1;
  const x = (i: number) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = vs[vs.length - 1];
  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} className="zero" />
      <path d={d} className={last >= 0 ? "up" : "down"} fill="none" />
    </svg>
  );
}

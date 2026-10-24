import { shortDate } from '../domain/format';

export function PriceChart({
  points,
  height = 96,
}: {
  points: { at: string; unitCostCents: number }[];
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <div className="flex h-24 items-center justify-center border border-dashed border-line text-[11.5px] text-dim">
        Histórico insuficiente para traçar evolução.
      </div>
    );
  }

  const values = points.map((p) => p.unitCostCents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = span * 0.18;
  const lo = min - pad;
  const hi = max + pad;

  const coords = points.map((point, index) => {
    const x = (index / (points.length - 1)) * 100;
    const y = 26 - ((point.unitCostCents - lo) / (hi - lo)) * 24;
    return { x, y };
  });

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ');
  const area = `${line} L100 27 L0 27 Z`;

  return (
    <div>
      <svg
        viewBox="0 0 100 28"
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        aria-label="Evolução do preço"
        role="img"
      >
        {[3, 15, 27].map((y) => (
          <line
            key={y}
            x1="0"
            x2="100"
            y1={y}
            y2={y}
            stroke="#26241f"
            strokeWidth="0.25"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={area} fill="rgba(195,123,69,0.06)" />
        <path
          d={line}
          fill="none"
          stroke="#c37b45"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <line
          x1={coords[coords.length - 1].x}
          x2={coords[coords.length - 1].x}
          y1={coords[coords.length - 1].y - 2}
          y2={coords[coords.length - 1].y + 2}
          stroke="#da9358"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-dim">
        <span>{shortDate(points[0].at)}</span>
        <span>{shortDate(points[Math.floor(points.length / 2)].at)}</span>
        <span>{shortDate(points[points.length - 1].at)}</span>
      </div>
    </div>
  );
}

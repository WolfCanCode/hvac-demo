import type { TrainingSessionSummary } from "@hvac/shared";

interface ProgressChartProps {
  sessions: TrainingSessionSummary[];
}

const CHART_HEIGHT = 220;
const CHART_WIDTH = 620;
const Y_TICKS = [0, 25, 50, 75, 100];

function buildPath(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

export function ProgressChart({ sessions }: ProgressChartProps) {
  const visibleSessions = (sessions ?? []).slice(0, 6).reverse();

  if (visibleSessions.length === 0) {
    return (
      <div className="chart-shell">
        <div className="chart-header">
          <h3>AI Learning Momentum</h3>
          <span>No training sessions yet</span>
        </div>
        <div className="chart-empty">
          <span>Start training from the Drawing MTO step</span>
          <span>Shared confidence trend will appear here</span>
        </div>
      </div>
    );
  }

  const stepX = visibleSessions.length === 1 ? 0 : CHART_WIDTH / (visibleSessions.length - 1);
  const points = visibleSessions.map((session, index) => ({
    ...session,
    x: index * stepX,
    y: CHART_HEIGHT - (session.currentAccuracy / 100) * CHART_HEIGHT
  }));
  const linePath = buildPath(points);
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${CHART_HEIGHT} L ${points[0].x} ${CHART_HEIGHT} Z`;

  return (
    <div className="chart-shell">
      <div className="chart-header">
        <h3>AI Learning Momentum</h3>
        <span>Last {visibleSessions.length} training sessions</span>
      </div>

      <div className="chart-grid">
        <div className="chart-axis">
          {Y_TICKS.map((tick) => (
            <span key={tick}>{tick}%</span>
          ))}
        </div>

        <div className="chart-plot">
          {Y_TICKS.map((tick) => (
            <div
              className="chart-grid-line"
              key={tick}
              style={{ top: `${CHART_HEIGHT - (tick / 100) * CHART_HEIGHT}px` }}
            />
          ))}

          <svg
            aria-label="Shared training accuracy trend"
            className="chart-svg"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="chart-area-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#64ddc6" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#5844f6" stopOpacity="0.06" />
              </linearGradient>
            </defs>
            <path className="chart-area" d={areaPath} />
            <path className="chart-line" d={linePath} />
            {points.map((point) => (
              <g key={point.id}>
                <circle className="chart-point" cx={point.x} cy={point.y} r="6" />
              </g>
            ))}
          </svg>

          <div className="chart-point-labels">
            {points.map((point) => (
              <div
                className="chart-point-label"
                key={`${point.id}-label`}
                style={{
                  left: `${(point.x / CHART_WIDTH) * 100}%`,
                  top: `${(point.y / CHART_HEIGHT) * 100}%`
                }}
              >
                {point.currentAccuracy}%
              </div>
            ))}
          </div>

          <div className="chart-x-axis">
            {visibleSessions.map((session, index) => (
              <div className="chart-x-tick" key={session.id} style={{ left: `${(index / Math.max(1, visibleSessions.length - 1)) * 100}%` }}>
                <strong>S{index + 1}</strong>
                <span>{(session.email || "unknown").split("@")[0]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

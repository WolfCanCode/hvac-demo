interface ProgressChartProps {
  history: Array<{
    label: string;
    value: number;
  }>;
}

export function ProgressChart({ history }: ProgressChartProps) {
  return (
    <div className="chart-shell">
      <div className="chart-header">
        <h3>AI Learning Momentum</h3>
        <span>Last 30 sessions</span>
      </div>
      <div className="chart-bars">
        {history.length === 0 ? (
          <div className="chart-empty">
            <span>Start of project</span>
            <span>Current performance</span>
          </div>
        ) : (
          history.map((point) => (
            <div className="chart-bar-group" key={point.label}>
              <div className="chart-bar-track">
                <div className="chart-bar-fill" style={{ height: `${Math.max(12, point.value)}%` }} />
              </div>
              <span>{point.label}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

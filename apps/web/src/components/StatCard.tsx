interface StatCardProps {
  label: string;
  value: string;
  accent: "mint" | "lavender" | "amber" | "blue" | "rose" | "lavenderStrong";
}

export function StatCard({ label, value, accent }: StatCardProps) {
  return (
    <article className={`stat-card ${accent}`}>
      <div className="stat-icon" />
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

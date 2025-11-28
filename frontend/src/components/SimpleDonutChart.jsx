import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const COLORS = [
  "#6366f1", "#a78bfa", "#22d3ee", "#f87171", "#fb923c", "#34d399",
  "#f472b6", "#60a5fa", "#c084fc", "#4ade80", "#facc15", "#cbd5e1"
];

export default function SimpleDonutChart({ data }) {
  // Show top 8 holdings only by value for clearer display
  const topHoldings = [...data]
    .sort((a, b) => parseFloat(b.value) - parseFloat(a.value))
    .slice(0, 8)
    .map(item => ({
      name: item.name,
      value: Number(item.value)
    }));

  return (
    <div style={{ width: "100%", height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={topHoldings}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={2}
            label={({ name }) => name.split(' ')[0]}
          >
            {topHoldings.map((entry, idx) => (
              <Cell key={`cell-${idx}`} fill={COLORS[idx % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, name) => [`$${Number(value).toLocaleString()}`, name]}
          />
          <Legend layout="vertical" verticalAlign="middle" align="right" />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

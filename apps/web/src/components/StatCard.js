import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function StatCard({ label, value, accent }) {
    return (_jsxs("article", { className: `stat-card ${accent}`, children: [_jsx("span", { children: label }), _jsx("strong", { children: value })] }));
}

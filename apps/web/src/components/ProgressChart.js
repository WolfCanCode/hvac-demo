import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ProgressChart({ history }) {
    return (_jsxs("div", { className: "chart-shell", children: [_jsxs("div", { className: "chart-header", children: [_jsx("h3", { children: "AI Learning Momentum" }), _jsx("span", { children: "Last sessions" })] }), _jsx("div", { className: "chart-bars", children: history.length === 0 ? (_jsx("div", { className: "empty-inline", children: "No training sessions yet." })) : (history.map((point) => (_jsxs("div", { className: "chart-bar-group", children: [_jsx("div", { className: "chart-bar-track", children: _jsx("div", { className: "chart-bar-fill", style: { height: `${Math.max(12, point.value)}%` } }) }), _jsx("span", { children: point.label })] }, point.label)))) })] }));
}

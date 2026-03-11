import { jsx as _jsx } from "react/jsx-runtime";
const steps = [
    "1. Symbols Legend",
    "2. Drawing MTO",
    "3. 3D Model",
    "4. Reconciliation",
    "5. AI Progress"
];
export function StepTabs({ activeStep, onChange }) {
    return (_jsx("div", { className: "step-tabs", children: steps.map((step, index) => (_jsx("button", { className: index === activeStep ? "step-tab active" : "step-tab", onClick: () => onChange(index), type: "button", children: step }, step))) }));
}

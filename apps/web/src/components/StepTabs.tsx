interface StepTabsProps {
  activeStep: number;
  onChange: (step: number) => void;
}

const steps = [
  "1. SYMBOLS LEGEND",
  "2. DRAWING MTO",
  "3. 3D MODEL",
  "4. RECONCILIATION",
  "5. AI PROGRESS"
];

export function StepTabs({ activeStep, onChange }: StepTabsProps) {
  return (
    <div className="step-tabs">
      {steps.map((step, index) => (
        <button
          className={index === activeStep ? "step-tab active" : "step-tab"}
          key={step}
          onClick={() => onChange(index)}
          type="button"
        >
          <span className="step-dot" />
          {step}
        </button>
      ))}
    </div>
  );
}

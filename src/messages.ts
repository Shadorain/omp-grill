import type { Action, GrillState, SpecialistRole, Submission } from "./types";

export function actionRole(action: Action): SpecialistRole | undefined {
  if (action.type === "thread" || action.type === "explore") return "discussion";
  if (action.type === "visualize" || action.type === "visual-feedback") return action.kind ?? "diagram";
  return undefined;
}

export function submissionSummary(state: GrillState, submission: Submission): string {
  const lines = [`Grill · batch ${submission.seq} · ${state.id.slice(0, 8)}`];
  for (const action of submission.actions) {
    const question = "q" in action ? state.questions.find((question) => question.id === action.q) : undefined;
    const name = question?.title ?? ("q" in action ? action.q : "");
    switch (action.type) {
      case "answer": {
        const option = question?.options.find((option) => option.id === action.option)?.label ?? action.option;
        lines.push(`Answer · ${name}: ${[option, action.text].filter(Boolean).join(" — ")}`);
        break;
      }
      case "thread": lines.push(`Discuss · ${name}: ${action.text}`); break;
      case "explore": lines.push(`Explore · ${name}`); break;
      case "defer": lines.push(`Defer · ${name}${action.until ? ` until ${action.until}` : ""}`); break;
      case "reopen": lines.push(`Reopen · ${name}`); break;
      case "visualize": lines.push(`Draw · ${action.kind ?? "diagram"}`); break;
      case "visual-feedback": lines.push(`Revise · ${action.kind ?? "diagram"}: ${action.text}`); break;
      case "finish": lines.push("Finish"); break;
    }
  }
  if (submission.completed?.length) lines.push(`Specialists completed: ${submission.completed.join(", ")}`);
  return lines.join("\n");
}

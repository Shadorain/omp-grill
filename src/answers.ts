import type { DraftAnswer, Question } from "./types";

export function selectedOptions(answer: Pick<DraftAnswer, "option" | "options"> | undefined): string[] {
  return answer?.options ?? (answer?.option ? [answer.option] : []);
}

export function sameAnswer(left: DraftAnswer | undefined, right: DraftAnswer | undefined): boolean {
  const a = selectedOptions(left);
  const b = selectedOptions(right);
  return a.length === b.length && a.every((id) => b.includes(id)) && (left?.text?.trim() ?? "") === (right?.text?.trim() ?? "");
}

export function toggleOption(question: Question, answer: DraftAnswer | undefined, optionId: string): DraftAnswer {
  const selected = selectedOptions(answer);
  const text = answer?.text?.trim();
  if (question.multiSelect) {
    const next = selected.includes(optionId) ? selected.filter((id) => id !== optionId) : [...selected, optionId];
    return { options: question.options.filter((option) => next.includes(option.id)).map((option) => option.id), ...(text ? { text } : {}) };
  }
  const option = answer?.option === optionId ? undefined : optionId;
  return { ...(option ? { option } : {}), ...(text ? { text } : {}) };
}

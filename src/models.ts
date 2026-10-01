import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import { compactSubmission } from "./store";
import type { GrillState, Publish, SpecialistRole, Submission } from "./types";
import { actionRole } from "./messages";

export async function runSpecialist(input: {
  ctx: ExtensionContext;
  selector: string;
  role: SpecialistRole;
  state: GrillState;
  submission: Submission;
  parameters: ZodLikeSchema<Publish>;
  signal: AbortSignal;
  instruction: string;
}): Promise<Publish> {
  const { ctx, selector, role, state, submission, parameters, signal } = input;
  const slash = selector.indexOf("/");
  const model = ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
  if (!model) throw new Error(`Grill ${role} model not found: ${selector}. Change /grill config ${role}Model, then /grill resume.`);
  const actions = submission.actions.filter((action) => actionRole(action) === role);
  const result = await completeSimple(model, {
    systemPrompt: [input.instruction, `You are the ${role} specialist, not the interviewer. Call grill_result exactly once with only the requested replies/analysis or ${role} spec. Do not publish questions, acknowledge submissions, change decisions, or write a chat recap. Use only supplied verified context; label unresolved recommendations as assumptions. You cannot inspect project files; do not claim to have researched an existing application.`],
    messages: [{ role: "user", content: compactSubmission(state, { seq: submission.seq, actions }), timestamp: Date.now() }],
    tools: [{ name: "grill_result", description: `Return the requested ${role} result as structured data.`, parameters }],
  }, {
    apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
    headers: await ctx.modelRegistry.resolveModelHeaders(model, signal),
    signal,
    toolChoice: { type: "function", name: "grill_result" },
  });
  if (result.stopReason === "error" || result.stopReason === "aborted")
    throw new Error(result.errorMessage || `Grill ${role} model ${result.stopReason}`);
  const calls = result.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.name !== "grill_result")
    throw new Error(`Grill ${role} model must return one grill_result call`);
  const patch = parameters.assert(calls[0].arguments);
  if (role === "diagram" && !patch.diagram) throw new Error("Diagram model returned no diagram");
  if (role === "prototype" && !patch.prototype) throw new Error("Prototype model returned no prototype");
  if (role === "discussion") {
    const requested = new Set(actions.flatMap((action) => "q" in action ? [action.q] : []));
    if (patch.replies?.some((reply) => !requested.has(reply.q)) || patch.explorations?.some((row) => !requested.has(row.q)))
      throw new Error("Discussion model returned an unrelated question");
    for (const row of patch.explorations ?? []) {
      const question = state.questions.find((question) => question.id === row.q);
      if (row.rows.some((entry) => !question?.options.some((option) => option.id === entry.option)))
        throw new Error(`Discussion model explored an unknown option for ${row.q}`);
    }
    for (const action of actions) {
      if (action.type === "thread" && !patch.replies?.some((reply) => reply.q === action.q))
        throw new Error(`Discussion model did not reply to ${action.q}`);
      if (action.type === "explore") {
        const rows = patch.explorations?.find((row) => row.q === action.q)?.rows;
        const question = state.questions.find((question) => question.id === action.q);
        if (!rows || !question || question.options.some((option) => !rows.some((row) => row.option === option.id)))
          throw new Error(`Discussion model did not explore every option of ${action.q}`);
      }
    }
  }
  return patch;
}

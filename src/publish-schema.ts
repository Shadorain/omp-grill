import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function createPublishSchemas(z: ExtensionAPI["zod"]) {
  const prototypeFields = {
    id: z.string(),
    kind: z.enum(["heading", "text", "button", "input", "select", "checkbox", "table", "list", "card", "dialog"]),
    label: z.string().optional(), text: z.string().optional(), value: z.string().optional(),
    options: z.array(z.string()).optional(), columns: z.array(z.string()).optional(), rows: z.array(z.array(z.string())).optional(),
    action: z.object({ type: z.enum(["navigate", "set", "toggle", "open", "close", "submit"]), target: z.string(), value: z.string().optional() }).optional(),
  };
  const leaf = z.object(prototypeFields);
  const group = z.object({ ...prototypeFields, children: z.array(leaf).optional() });
  const block = z.object({ ...prototypeFields, children: z.array(group).optional() });
  const fields = {
    topic: z.string().describe("Only for a new interview; omit when publishing to an existing id.").optional(),
    id: z.string().describe("Target grill id from the startup or submission message.").optional(),
    handled: z.number().int().positive().describe("Acknowledge the pending submission's exact seq. Omit when no submission is pending, especially on startup; never send 0.").optional(),
    questions: z.array(z.object({
      id: z.string(), title: z.string(), body: z.string().optional(),
      options: z.array(z.object({ id: z.string(), label: z.string() })),
      recommendation: z.object({ option: z.string().optional(), reason: z.string() }),
      dependsOn: z.array(z.string()).optional(), durable: z.boolean().optional(),
    })).optional(),
    replies: z.array(z.object({ q: z.string(), text: z.string() })).optional(),
    explorations: z.array(z.object({ q: z.string(), rows: z.array(z.object({ option: z.string(), pros: z.array(z.string()), cons: z.array(z.string()) })) })).optional(),
    note: z.string().optional(),
    context: z.object({
      intent: z.string().optional(), docPath: z.string().optional(),
      terms: z.array(z.object({ term: z.string(), definition: z.string(), avoid: z.array(z.string()).optional() })).optional(),
      facts: z.array(z.object({ id: z.string(), text: z.string(), source: z.string().optional() })).optional(),
      risks: z.array(z.object({ id: z.string(), text: z.string(), mitigation: z.string().optional() })).optional(),
    }).optional(),
    diagram: z.object({
      title: z.string(), kind: z.enum(["architecture", "flow", "sequence", "state"]),
      nodes: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional() })),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })),
    }).optional(),
    diagramReply: z.string().optional(),
    prototype: z.object({
      title: z.string(), start: z.string(),
      app: z.object({ name: z.string(), route: z.string().optional(), chrome: z.array(z.string()).optional() }).optional(),
      theme: z.object({ background: z.string().optional(), surface: z.string().optional(), text: z.string().optional(), accent: z.string().optional(), radius: z.number().optional(), font: z.enum(["sans", "serif", "mono"]).optional() }).optional(),
      screens: z.array(z.object({ id: z.string(), title: z.string(), layout: z.enum(["dashboard", "split", "form", "content"]).optional(), blocks: z.array(block) })),
    }).optional(),
    prototypeReply: z.string().optional(),
  };
  return {
    publish: z.object(fields),
    specialists: {
      discussion: z.object({ replies: fields.replies, explorations: fields.explorations }).strict(),
      diagram: z.object({ diagram: fields.diagram, diagramReply: fields.diagramReply }).strict(),
      prototype: z.object({ prototype: fields.prototype, prototypeReply: fields.prototypeReply }).strict(),
    },
  };
}

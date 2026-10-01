import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GrillState, PrototypeBlock, PrototypeSpec, Publish, QuestionInput } from "../src/types.ts";

// Exercise the real OMP extension without sending requests to a model provider.
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "omp-grill-demo-"));
const home = join(root, "grill");
const questions: QuestionInput[] = [
  {
    id: "color",
    title: "Choose the task board accent",
    body: "This choice changes the interactive preview theme. It does not send an answer until you choose Send answers.",
    options: [
      { id: "purple", label: "Purple" },
      { id: "blue", label: "Blue" },
    ],
    recommendation: { option: "purple", reason: "Keeps the demo's current accent; blue is an equally valid visual preference." },
  },
  {
    id: "creation",
    title: "How should people create a task?",
    body: "Try this choice in Preview after sending your answers. A modal keeps the board visible; a page gives the form more room.",
    durable: true,
    options: [
      { id: "modal", label: "Modal on the board" },
      { id: "page", label: "Dedicated page" },
    ],
    recommendation: { option: "modal", reason: "The short form fits in a modal and preserves board context." },
  },
];
function prototype(current: GrillState, feedback?: string): PrototypeSpec {
  const page = current.questions.find((question) => question.id === "creation")?.answer?.option === "page";
  const form: PrototypeBlock[] = [
    { id: "create-heading", kind: "heading", text: "Create a task" },
    { id: "task-name", kind: "input", label: "Task name", value: "Review launch checklist" },
    { id: "task-priority", kind: "select", label: "Priority", value: "Normal", options: ["Normal", "High", "Low"] },
    { id: "task-notify", kind: "checkbox", label: "Notify the team", value: "true" },
    { id: "notification-toggle", kind: "button", label: "Toggle notifications", action: { type: "toggle", target: "task-notify" } },
    { id: "suggest-name", kind: "button", label: "Use example task", action: { type: "set", target: "task-name", value: "Prepare release notes" } },
    { id: "submit-task", kind: "button", label: "Create task", action: { type: "submit", target: current.questions.find((question) => question.id === "confirmation")?.answer?.option === "board" ? "board" : "created" } },
    { id: "cancel-task", kind: "button", label: "Cancel", action: { type: page ? "navigate" : "close", target: page ? "board" : "create-dialog" } },
  ];
  const board: PrototypeBlock[] = [
    { id: "board-title", kind: "heading", text: "Launch tasks" },
    { id: "board-summary", kind: "text", text: "Try New task, edit the form, then create it. This is a local UI prototype, not a connected task service." },
    { id: "tasks", kind: "table", columns: ["Task", "Owner", "Status"], rows: [["Design review", "Ari", "Ready"], ["Release checklist", "Sam", "In progress"]] },
    { id: "new-task", kind: "button", label: "New task", action: { type: page ? "navigate" : "open", target: page ? "create" : "create-dialog" } },
    { id: "local-note", kind: "card", label: "Preview only", children: [{ id: "preview-details", kind: "list", options: ["Form values stay in this frame.", "No agent calls when you click.", "Reset returns to the starting state."] }] },
  ];
  const assumptions = current.questions.filter((question) => question.status === "open");
  if (assumptions.length)
    board.push({ id: "assumed-choices", kind: "text", text: `Assumed until answered: ${assumptions.map((question) => `${question.title}: ${question.options.find((option) => option.id === question.recommendation.option)?.label ?? "undecided"}`).join("; ")}` });
  if (feedback)
    board.push({ id: "feedback-update", kind: "text", text: `Requested change (scripted demo): ${feedback}` });
  if (!page)
    board.push({ id: "create-dialog", kind: "dialog", label: "New task", children: form });
  const screens: PrototypeSpec["screens"] = [
    { id: "board", title: "Task board", layout: "dashboard", blocks: board },
    { id: "created", title: "Task created", layout: "content", blocks: [
      { id: "created-title", kind: "heading", text: "Task created in this preview" },
      { id: "created-details", kind: "text", text: "{{task-name}} · {{task-priority}}" },
      { id: "return-board", kind: "button", label: "Back to tasks", action: { type: "navigate", target: "board" } },
    ] },
  ];
  if (page)
    screens.push({ id: "create", title: "New task", layout: "form", blocks: form });
  return {
    title: "Task board prototype",
    start: "board",
    app: { name: "Launchpad", route: "/tasks", chrome: ["Workspace", "Tasks", "Team"] },
    theme: { background: "#121525", surface: "#20253d", text: "#f1f4ff", accent: current.questions.find((question) => question.id === "color")?.answer?.option === "blue" ? "#63a9ff" : "#ae91ff", radius: 12, font: "sans" },
    screens,
  };
}
let requests = 0;
function state(): GrillState {
  const directories = readdirSync(home, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory(),
  );
  if (directories.length !== 1)
    throw new Error(
      "Demo expects one interview. Restart the demo to start another.",
    );
  const statePath = join(home, directories[0].name, "state.json");
  // This file is written and validated by the extension in our isolated demo home.
  return JSON.parse(readFileSync(statePath, "utf8")) as GrillState;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const provider = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(body) || !Array.isArray(body.tools))
      throw new Error("Expected OMP completion request");
    const tool = body.tools.find(
      (value: unknown) =>
        record(value) &&
        record(value.function) &&
        typeof value.function.name === "string" &&
        value.function.name.includes("grill_publish"),
    );
    if (
      !record(tool) ||
      !record(tool.function) ||
      typeof tool.function.name !== "string"
    )
      throw new Error("Missing grill_publish tool");
    const current = state();
    let patch: Publish | undefined;
    if (!current.questions.length) patch = {
      questions,
      context: {
        intent: "Decide the task board's accent and task-creation flow, then try the chosen interaction before exporting.",
        terms: [{ term: "Prototype", definition: "An isolated clickable preview with local form state; not a connected production app.", avoid: ["production app"] }],
        facts: [{ id: "demo-provider", text: "This demo uses a scripted local provider, not an inference model.", source: "examples/demo.ts" }],
        risks: [{ id: "prototype-only", text: "Preview interactions are not saved as real tasks.", mitigation: "Treat this as UI validation; production implementation still needs application integration." }],
      },
    };
    else if (current.pending) {
      patch = { handled: current.pending.seq };
      for (const action of current.pending.actions) {
        if (action.type === "thread")
          (patch.replies ??= []).push({
            q: action.q,
            text: "Demo reply. No model was called.",
          });
        if (action.type === "visualize" || action.type === "visual-feedback") {
          if (action.kind === "prototype") {
            patch.prototype = prototype(current, action.type === "visual-feedback" ? action.text : undefined);
            patch.prototypeReply = action.type === "visual-feedback"
              ? "Redrew the demo and added your requested-change note. A real model would edit the relevant structured components."
              : "Clickable task board with the selected accent and creation flow. No inference model was called.";
            continue;
          }
          patch.diagram = {
            title: "Demo system",
            kind: "architecture",
            nodes: [
              { id: "ui", label: "Browser UI" },
              {
                id: "server",
                label: "Grill server",
                detail: "Token-gated HTTP",
              },
              {
                id: "store",
                label: "Session store",
                detail: "state.json + report.md",
              },
              { id: "agent", label: "OMP agent" },
            ],
            edges: [
              { from: "ui", to: "server", label: "drafts, actions" },
              { from: "server", to: "store", label: "atomic writes" },
              { from: "server", to: "agent", label: "wake on batch" },
            ],
          };
          if (action.type === "visual-feedback") {
            patch.diagram.nodes.push({ id: "feedback", label: action.text, detail: "Requested change (scripted demo)" });
            patch.diagram.edges.push({ from: "ui", to: "feedback", label: "feedback" });
          }
          patch.diagramReply = action.type === "visual-feedback"
            ? "Redrew the scripted diagram with your feedback. No inference model was called."
            : "Scripted demo diagram. No inference model was called.";
        }
        if (action.type === "explore") {
          const question = current.questions.find(
            (question) => question.id === action.q,
          );
          (patch.explorations ??= []).push({
            q: action.q,
            rows: (question?.options ?? []).map((option) => ({
              option: option.id,
              pros: ["Available in this demo."],
              cons: ["No real design reasoning in a scripted demo."],
            })),
          });
        }
      }
      if (!current.questions.some((question) => question.id === "confirmation") &&
          current.questions.every((question) => question.status === "answered")) {
        patch.questions = [{
          id: "confirmation",
          title: "After creating a task, where should people land?",
          body: "This next decision changes the prototype's Create task transition.",
          dependsOn: ["creation"],
          options: [
            { id: "confirmation", label: "Show a confirmation screen" },
            { id: "board", label: "Return straight to the board" },
          ],
          recommendation: { option: "confirmation", reason: "A confirmation makes the submitted form values visible before returning to the board." },
        }];
      }
      if (!patch.questions && current.questions.every((question) => question.status !== "open"))
        patch.note =
          "Demo choices recorded. Finish exports the report locally.";
    }
    const id = `demo_${++requests}`;
    const delta = patch
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: {
                name: tool.function.name,
                arguments: JSON.stringify(patch),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: "Use the browser. This demo makes no model calls.",
        };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [change, finish] of [
      [delta, null],
      [{}, patch ? "tool_calls" : "stop"],
    ] as const) {
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta: change, finish_reason: finish }] })}\n\n`,
      );
    }
    res.end("data: [DONE]\n\n");
    console.log(`DEMO_REQUESTS ${requests}`);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});
await new Promise<void>((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(0, "127.0.0.1", resolve);
});
const address = provider.address();
if (!address || typeof address === "string")
  throw new Error("Provider did not bind");
const providerPath = join(root, "provider.ts");
writeFileSync(
  providerPath,
  `export default function(pi) { pi.registerProvider('grill-demo',{baseUrl:'http://127.0.0.1:${address.port}/v1',apiKey:'demo',api:'openai-completions',models:[{id:'scripted',name:'Scripted local demo',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:2048}]}); }`,
);
const config = join(root, "config.yml");
const roles = ["default", "smol", "tiny", "commit", "plan", "slow", "advisor"];
writeFileSync(
  config,
  `modelRoles:\n${roles.map((role) => `  ${role}: grill-demo/scripted`).join("\n")}\nskills:\n  enabled: false\n`,
);
const child = spawn(
  "omp",
  [
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    providerPath,
    "-e",
    project,
    "--no-tools",
    "--no-lsp",
    "--no-title",
    "--auto-approve",
    "--no-session",
    "--model",
    "grill-demo/scripted",
    "--config",
    config,
  ],
  {
    cwd: project,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(root, "agent"),
      OMP_GRILL_HOME: home,
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let buffer = "";
child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  let boundary: number;
  while ((boundary = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 1);
    if (!line) continue;
    try {
      const frame: unknown = JSON.parse(line);
      if (!record(frame)) continue;
      if (frame.type === "ready")
        child.stdin.write(
          JSON.stringify({
            id: "demo",
            type: "prompt",
            message: "/grill Task board demo",
          }) + "\n",
        );
      if (
        frame.type === "extension_ui_request" &&
        frame.method === "notify" &&
        typeof frame.message === "string" &&
        frame.message.startsWith("Grill ")
      ) {
        const url = frame.message.match(/https?:\/\/[^\s]+/)?.[0];
        if (!url) continue;
        writeFileSync(join(root, "url"), url, { mode: 0o600 });
        console.log(`DEMO_URL ${url}`);
      }
      if (frame.type === "tool_execution_end")
        console.log(
          `DEMO_TOOL ${JSON.stringify({ tool: frame.toolName, error: frame.isError })}`,
        );
      if (
        frame.type === "extension_error" ||
        (frame.type === "response" && frame.success === false)
      )
        console.error(`DEMO_ERROR ${line}`);
    } catch {
      console.error(line);
    }
  }
});
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
let input = "";
process.stdin.on("data", (chunk: Buffer) => {
  input += chunk.toString();
  let boundary: number;
  while ((boundary = input.indexOf("\n")) >= 0) {
    const message = input.slice(0, boundary).trim();
    input = input.slice(boundary + 1);
    if (message)
      child.stdin.write(JSON.stringify({ id: `terminal-${Date.now()}`, type: "prompt", message }) + "\n");
  }
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.stdin.end();
  child.kill("SIGTERM");
  provider.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("error", (error) => {
  console.error(error.message);
  provider.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
// stdin and keep-alive sockets hold the event loop open; exit explicitly once OMP is gone.
child.on("exit", (code) => {
  provider.closeAllConnections();
  provider.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(code ?? 0);
});
console.log(
  `DEMO_HOME ${root}\nScripted local provider. No inference tokens. Type /grill commands to exercise terminal controls. Ctrl+C stops the demo.`,
);

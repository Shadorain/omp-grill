import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

export interface CompletionGrill {
  id: string;
  topic: string;
  status: string;
}

export interface CompletionQuestion {
  id: string;
  title: string;
  options: { id: string; label: string }[];
}

export interface CompletionSnapshot {
  open: CompletionGrill[];
  saved: CompletionGrill[];
  questions: CompletionQuestion[];
}

const SUBS: { name: string; description: string; usage?: string }[] = [
  { name: "tui", description: "Open the session interview", usage: "[topic|off]" },
  { name: "use", description: "Select an open grill", usage: "<id>" },
  { name: "url", description: "Print the selected grill URL" },
  { name: "questions", description: "List the selected grill's questions" },
  { name: "answer", description: "Record an answer", usage: "<question> <option>" },
  { name: "reply", description: "Message the agent", usage: "<question> <text>" },
  { name: "pause", description: "Pause the selected grill" },
  { name: "resume", description: "Open a paused or errored grill" },
  { name: "history", description: "Open a finished grill's locked page" },
  { name: "fork", description: "Start a grill carrying a finished grill's context", usage: "[id]" },
  { name: "sessions", description: "List saved grills for this project" },
  { name: "finish", description: "Finish the selected grill and write the report" },
  { name: "export", description: "Write an artifact into the project", usage: "<kind> [path]" },
  { name: "config", description: "Show or set server settings", usage: "[key] [value]" },
];

const EXPORT_CHOICES: { name: string; description: string }[] = [
  { name: "report", description: "Decision report markdown" },
  { name: "adr", description: "One ADR per durable decision" },
  { name: "beads", description: "bd create --graph plan" },
  { name: "diagram", description: "System diagram SVG" },
  { name: "prototype", description: "Interactive prototype HTML" },
];

const CONFIG_KEYS: { name: string; description: string }[] = [
  { name: "host", description: "Listen address for interview servers" },
  { name: "port", description: "Fixed port; 0 uses a free port" },
  { name: "allowAgentStart", description: "Let the agent start interviews" },
  { name: "discussionModel", description: "Discussion/exploration model: provider/model-id or main" },
  { name: "diagramModel", description: "Diagram model: provider/model-id or main" },
  { name: "prototypeModel", description: "Prototype model: provider/model-id or main" },
];

const CONFIG_VALUES: Record<string, { name: string; description?: string }[]> = {
  host: [
    { name: "127.0.0.1", description: "Local access only" },
    { name: "0.0.0.0", description: "All interfaces; trusted LAN only" },
    { name: "::1", description: "IPv6 loopback" },
  ],
  port: [{ name: "0", description: "Use a free port" }],
  allowAgentStart: [
    { name: "true", description: "Agent may start interviews" },
    { name: "false", description: "Only /grill commands start interviews" },
  ],
  discussionModel: [{ name: "main", description: "Use the session agent" }],
  diagramModel: [{ name: "main", description: "Use the session agent" }],
  prototypeModel: [{ name: "main", description: "Use the session agent" }],
};

function item(value: string, label: string, description?: string): AutocompleteItem {
  return { value, label, ...(description ? { description } : {}) };
}

function prefixMatches(prefix: string, name: string): boolean {
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}

export function grillCompletions(
  argumentPrefix: string,
  snapshot: CompletionSnapshot,
): AutocompleteItem[] | null {
  const space = argumentPrefix.indexOf(" ");
  if (space === -1) {
    const matches = SUBS.filter((sub) => prefixMatches(argumentPrefix, sub.name)).map((sub) =>
      item(`${sub.name} `, sub.name, sub.description),
    );
    return matches.length ? matches : null;
  }
  const verb = argumentPrefix.slice(0, space).toLowerCase();
  const rest = argumentPrefix.slice(space + 1);
  if (verb === "config") {
    const parts = rest.split(" ").filter((part) => part.length > 0);
    const partial = rest.endsWith(" ") ? "" : parts.pop() ?? "";
    if (parts.length === 0) {
      const matches = CONFIG_KEYS.filter((key) => prefixMatches(partial, key.name)).map((key) =>
        item(`config ${key.name} `, key.name, key.description),
      );
      return matches.length ? matches : null;
    }
    if (parts.length !== 1) return null;
    const matches = (CONFIG_VALUES[parts[0]] ?? [])
      .filter((value) => prefixMatches(partial, value.name))
      .map((value) => item(`config ${parts[0]} ${value.name} `, value.name, value.description));
    return matches.length ? matches : null;
  }
  if (rest.includes(" ") && verb !== "answer") return null;
  if (verb === "export") {
    const matches = EXPORT_CHOICES.filter((kind) => prefixMatches(rest, kind.name)).map((kind) =>
      item(`export ${kind.name} `, kind.name, kind.description),
    );
    return matches.length ? matches : null;
  }
  if (verb === "use") {
    const matches = snapshot.open
      .filter((grill) => prefixMatches(rest, grill.id) || prefixMatches(rest, grill.topic))
      .map((grill) => item(`use ${grill.id} `, `${grill.topic} · ${grill.id.slice(0, 8)}`, grill.status));
    return matches.length ? matches : null;
  }
  if (verb === "tui") {
    if (rest.includes(" ")) return null;
    return prefixMatches(rest, "off") ? [item("tui off ", "off", "Leave the session interview")] : null;
  }
  if (verb === "history" || verb === "resume" || verb === "fork") {
    const wanted = verb === "resume" ? ["paused", "error"] : ["finished"];
    const matches = snapshot.saved
      .filter((grill) => wanted.includes(grill.status))
      .filter((grill) => prefixMatches(rest, grill.id) || prefixMatches(rest, grill.topic))
      .map((grill) => item(`${verb} ${grill.id} `, `${grill.topic} · ${grill.id.slice(0, 8)}`, grill.status));
    return matches.length ? matches : null;
  }
  if (verb === "answer" || verb === "reply") {
    const parts = rest.split(" ");
    const questionPrefix = parts[0] ?? "";
    if (parts.length === 1) {
      const matches = snapshot.questions
        .filter((question) => prefixMatches(questionPrefix, question.id) || prefixMatches(questionPrefix, question.title))
        .map((question) => item(`${verb} ${question.id} `, question.id, question.title));
      return matches.length ? matches : null;
    }
    if (verb !== "answer" || parts.length !== 2) return null;
    const question = snapshot.questions.find((item) => item.id === questionPrefix);
    if (!question) return null;
    const optionPrefix = parts[1] ?? "";
    const options = [
      ...(prefixMatches(optionPrefix, "--") ? [item(`answer ${question.id} -- `, "--", "Free-text answer")] : []),
      ...question.options
        .filter((option) => prefixMatches(optionPrefix, option.id) || prefixMatches(optionPrefix, option.label))
        .map((option) => item(`answer ${question.id} ${option.id} `, option.id, option.label)),
    ];
    return options.length ? options : null;
  }
  return null;
}

import { describe, expect, test } from "bun:test";
import { grillCompletions, type CompletionSnapshot } from "../src/completions.ts";

const snapshot: CompletionSnapshot = {
  open: [{ id: "abc12345-full", topic: "Accent", status: "waiting" }],
  saved: [
    { id: "fin11111-full", topic: "Old board", status: "finished" },
    { id: "pau22222-full", topic: "Paused one", status: "paused" },
  ],
  questions: [{
    id: "color",
    title: "Choose the accent",
    options: [
      { id: "blue", label: "Blue" },
      { id: "purple", label: "Purple" },
    ],
  }],
};

describe("grill command completions", () => {
  test("completes subcommands from a prefix", () => {
    const items = grillCompletions("re", snapshot);
    expect(items?.map((item) => item.label)).toEqual(["reply", "resume"]);
    expect(items?.[0]?.value).toBe("reply ");
  });

  test("completes an open grill id after use", () => {
    const items = grillCompletions("use ab", snapshot);
    expect(items?.map((item) => item.value)).toEqual(["use abc12345-full "]);
  });

  test("completes question ids and then options", () => {
    expect(grillCompletions("answer c", snapshot)?.map((item) => item.value)).toEqual(["answer color "]);
    expect(grillCompletions("answer color b", snapshot)?.map((item) => item.label)).toEqual(["blue"]);
    expect(grillCompletions("answer color -", snapshot)?.[0]?.label).toBe("--");
  });

  test("completes finished and paused sessions separately", () => {
    expect(grillCompletions("history ", snapshot)?.map((item) => item.label)).toEqual(["Old board · fin11111"]);
    expect(grillCompletions("resume ", snapshot)?.map((item) => item.label)).toEqual(["Paused one · pau22222"]);
    expect(grillCompletions("tui o", snapshot)?.[0]?.value).toBe("tui off ");
  });

  test("completes config keys and values", () => {
    expect(grillCompletions("conf", snapshot)?.[0]?.value).toBe("config ");
    expect(grillCompletions("config ", snapshot)?.map((item) => item.label)).toEqual(["host", "port", "allowAgentStart"]);
    expect(grillCompletions("config al", snapshot)?.map((item) => item.value)).toEqual(["config allowAgentStart "]);
    expect(grillCompletions("config allowAgentStart ", snapshot)?.map((item) => item.value)).toEqual(["config allowAgentStart true ", "config allowAgentStart false "]);
    expect(grillCompletions("config host 1", snapshot)?.map((item) => item.value)).toEqual(["config host 127.0.0.1 "]);
    expect(grillCompletions("config port ", snapshot)?.map((item) => item.value)).toEqual(["config port 0 "]);
    expect(grillCompletions("config port 1 extra", snapshot)).toBeNull();
  });
});

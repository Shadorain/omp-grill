import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";

export interface ServerSettings {
  host: string;
  port: number;
  allowAgentStart: boolean;
  discussionModel?: string;
  diagramModel?: string;
  prototypeModel?: string;
}

export const DEFAULT_SETTINGS: ServerSettings = {
  host: "0.0.0.0",
  port: 0,
  allowAgentStart: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253)
    return false;
  if (isIP(value) !== 0) return true;
  return value
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
    );
}

export function serverSettingsFile(home: string): string {
  return join(home, "settings.json");
}

export function displaySettingsPath(
  home: string,
  homeDir = homedir(),
): string {
  const path = serverSettingsFile(home);
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

export function validateServerSettings(
  value: unknown,
  path = "settings.json",
): ServerSettings {
  const fail = (message: string): never => {
    throw new Error(`Invalid server settings at ${path}: ${message}`);
  };
  if (!isRecord(value)) return fail("expected a JSON object");
  const host = "host" in value ? value.host : DEFAULT_SETTINGS.host;
  const port = "port" in value ? value.port : DEFAULT_SETTINGS.port;
  const allowAgentStart = "allowAgentStart" in value
    ? value.allowAgentStart
    : DEFAULT_SETTINGS.allowAgentStart;
  if (!validHost(host)) return fail("host must be an IP address or hostname");
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    return fail("port must be 0 or an integer from 1 to 65535");
  if (typeof allowAgentStart !== "boolean")
    return fail("allowAgentStart must be a boolean");
  const models: Pick<ServerSettings, "discussionModel" | "diagramModel" | "prototypeModel"> = {};
  for (const key of ["discussionModel", "diagramModel", "prototypeModel"] as const) {
    const selector = value[key];
    if (selector === undefined || selector === "main") continue;
    if (typeof selector !== "string" || !/^[^\s/]+\/\S+$/.test(selector))
      return fail(`${key} must be provider/model-id or main`);
    models[key] = selector;
  }
  return { host, port, allowAgentStart, ...models };
}

export async function readServerSettings(
  home: string,
): Promise<ServerSettings> {
  const path = serverSettingsFile(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...DEFAULT_SETTINGS };
    throw new Error(`Cannot read server settings at ${path}: ${String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in server settings at ${path}: ${String(error)}`,
    );
  }
  return validateServerSettings(value, path);
}

export async function writeServerSettings(
  home: string,
  settings: ServerSettings,
): Promise<void> {
  const path = serverSettingsFile(home);
  const valid = validateServerSettings(settings, path);
  await mkdir(home, { recursive: true });
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function formatServerSettings(
  settings: ServerSettings,
  path: string,
): string {
  return [
    `Grill configuration at ${path}:`,
    `  host: ${settings.host}`,
    `  port: ${settings.port}`,
    `  allowAgentStart: ${settings.allowAgentStart}`,
    `  discussionModel: ${settings.discussionModel ?? "main"}`,
    `  diagramModel: ${settings.diagramModel ?? "main"}`,
    `  prototypeModel: ${settings.prototypeModel ?? "main"}`,
  ].join("\n");
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";

export interface ServerSettings {
  host: string;
  port: number;
  allowAgentStart: boolean;
}

const DEFAULT_SETTINGS: ServerSettings = {
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

export async function readServerSettings(
  home: string,
): Promise<ServerSettings> {
  const path = join(home, "settings.json");
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
  if (!isRecord(value))
    throw new Error(
      `Invalid server settings at ${path}: expected a JSON object`,
    );

  const host = "host" in value ? value.host : DEFAULT_SETTINGS.host;
  const port = "port" in value ? value.port : DEFAULT_SETTINGS.port;
  const allowAgentStart = "allowAgentStart" in value
    ? value.allowAgentStart
    : DEFAULT_SETTINGS.allowAgentStart;
  if (!validHost(host))
    throw new Error(
      `Invalid server settings at ${path}: host must be an IP address or hostname`,
    );
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error(
      `Invalid server settings at ${path}: port must be 0 or an integer from 1 to 65535`,
    );
  if (typeof allowAgentStart !== "boolean")
    throw new Error(
      `Invalid server settings at ${path}: allowAgentStart must be a boolean`,
    );
  return { host, port, allowAgentStart };
}

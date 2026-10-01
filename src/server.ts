import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { isIP } from "node:net";
import type { GrillServer, Store, Submission } from "./types";
import { type ExportKind, EXPORT_KINDS } from "./exports";
import { readServerSettings } from "./settings";
import { renderPrototype } from "./prototype";
import { renderDiagram } from "./diagram";
const MAX_BODY = 5 * 1024 * 1024;
const ASSETS: Partial<Record<string, readonly [string, string]>> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};

function respond(
  res: ServerResponse,
  status: number,
  body: string,
  type = "application/json; charset=utf-8",
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY) throw new Error("Request body exceeds 5 MiB limit");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function isRecordBody(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function startServer(input: {
  store: Store;
  onSubmit: (submission: Submission) => void | Promise<void>;
  onChange?: () => void;
  host?: string;
  port?: number;
}): Promise<GrillServer> {
  const settings = await readServerSettings(dirname(input.store.dir));
  input.store.claim();
  const bindHost = input.host ?? settings.host;
  const port = input.port ?? settings.port;
  const wildcard = bindHost === "0.0.0.0" || bindHost === "::";
  const token = randomBytes(32).toString("hex");
  const tokenBytes = Buffer.from(token, "utf8");
  let busy = false;
  let hostPort = 0;
  let acceptedHosts = new Set<string>();

  const deliver = async (): Promise<void> => {
    if (busy || !input.store.state.pending) return;
    busy = true;
    const submission = structuredClone(input.store.state.pending);
    try {
      await input.onSubmit(submission);
    } catch (error) {
      if (input.store.state.pending?.seq === submission.seq) {
        try {
          input.store.setStatus(
            "error",
            error instanceof Error ? error.message : String(error),
          );
        } catch {
          /* Keep delivery failure from escaping request handler. */
        }
        try {
          input.onChange?.();
        } catch {
          /* Status observers cannot break request handling. */
        }
      }
    } finally {
      busy = false;
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!host || !acceptedHosts.has(host.toLowerCase())) {
        respond(res, 403, JSON.stringify({ error: "Invalid host" }));
        return;
      }
      const method = req.method ?? "GET";
      const pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
      const asset = ASSETS[pathname];
      if (method === "GET" && asset) {
        const [file, type] = asset;
        const text = await readFile(new URL(`../web/${file}`, import.meta.url));
        respond(res, 200, text.toString("utf8"), type);
        return;
      }
      if (pathname.startsWith("/api/")) {
        const supplied = req.headers["x-grill-token"];
        const suppliedBytes =
          typeof supplied === "string"
            ? Buffer.from(supplied, "utf8")
            : Buffer.alloc(0);
        if (
          suppliedBytes.length !== tokenBytes.length ||
          !timingSafeEqual(suppliedBytes, tokenBytes)
        ) {
          respond(res, 401, JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }
      if (method === "GET" && pathname === "/api/state") {
        respond(res, 200, JSON.stringify(input.store.state));
        return;
      }
      if (method === "GET" && pathname === "/api/report") {
        respond(res, 200, input.store.previewReport(), "text/markdown; charset=utf-8", {
          "content-disposition": `attachment; filename="grill-report.md"`,
        });
        return;
      }
      if (method === "GET" && pathname === "/api/prototype") {
        const prototype = input.store.state.prototype;
        if (!prototype) {
          respond(res, 404, JSON.stringify({ error: "No prototype available" }));
          return;
        }
        respond(res, 200, renderPrototype(prototype), "text/html; charset=utf-8", {
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        return;
      }
      if (method === "GET" && pathname === "/api/diagram") {
        const diagram = input.store.state.diagram;
        if (!diagram) {
          respond(res, 404, JSON.stringify({ error: "No diagram available" }));
          return;
        }
        respond(res, 200, renderDiagram(diagram), "image/svg+xml; charset=utf-8", {
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'",
        });
        return;
      }
      if (method === "POST" && pathname.startsWith("/api/")) {
        let origin: URL;
        try {
          origin = new URL(req.headers.origin ?? "");
        } catch {
          respond(res, 403, JSON.stringify({ error: "Invalid origin" }));
          return;
        }
        if (
          origin.protocol !== "http:" ||
          origin.host.toLowerCase() !== host.toLowerCase() ||
          !acceptedHosts.has(origin.host.toLowerCase())
        ) {
          respond(
            res,
            403,
            JSON.stringify({ error: "Cross-origin request rejected" }),
          );
          return;
        }
      }
      if (method === "POST" && pathname === "/api/drafts") {
        const body = await readBody(req);
        if (!body || typeof body !== "object") {
          respond(res, 400, JSON.stringify({ error: "Expected draft patch" }));
          return;
        }
        try {
          const drafts = input.store.saveDrafts(
            body as Parameters<Store["saveDrafts"]>[0],
          );
          try {
            input.onChange?.();
          } catch {
            /* Status observers cannot break request handling. */
          }
          respond(res, 200, JSON.stringify(drafts));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("Draft revision conflict")) {
            respond(res, 409, JSON.stringify({
              error: `Drafts changed since your copy (revision ${input.store.state.drafts.revision}). Reload drafts and retry.`,
              drafts: input.store.state.drafts,
            }));
            return;
          }
          throw error;
        }
        return;
      }
      if (method === "POST" && pathname === "/api/context") {
        const body = await readBody(req);
        if (!body || typeof body !== "object") {
          respond(res, 400, JSON.stringify({ error: "Expected context patch" }));
          return;
        }
        input.store.updateContext(
          body as Parameters<Store["updateContext"]>[0],
        );
        try {
          input.onChange?.();
        } catch {
          /* Status observers cannot break request handling. */
        }
        respond(res, 200, JSON.stringify(input.store.state.context));
        return;
      }
      if (method === "POST" && pathname === "/api/send") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || !("actions" in body)) {
          respond(res, 400, JSON.stringify({ error: "Expected actions" }));
          return;
        }
        const record = body as Record<string, unknown>;
        const options = {
          ...(typeof record.requestId === "string"
            ? { requestId: record.requestId }
            : {}),
          ...(typeof record.draftRevision === "number"
            ? { draftRevision: record.draftRevision }
            : {}),
        };
        const previousSeq = input.store.state.seq;
        let submission: Submission;
        try {
          submission = input.store.submit(record.actions, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("Draft revision conflict")) {
            respond(res, 409, JSON.stringify({
              error: message,
              drafts: input.store.state.drafts,
            }));
            return;
          }
          if (
            message.startsWith("Session is finished") ||
            message.startsWith("Session is paused") ||
            message.startsWith("Session is working") ||
            message.startsWith("Submission already pending")
          ) {
            respond(res, 409, JSON.stringify({ error: message }));
            return;
          }
          throw error;
        }
        if (submission.seq > previousSeq) {
          try {
            input.onChange?.();
          } catch {
            /* Status observers cannot break request handling. */
          }
          void deliver();
        }
        respond(
          res,
          submission.seq > previousSeq ? 202 : 200,
          JSON.stringify({
            seq: submission.seq,
            status: input.store.state.status,
            drafts: input.store.state.drafts,
          }),
        );
        return;
      }
      if (method === "POST" && pathname === "/api/export") {
        const body = await readBody(req);
        const record = isRecordBody(body);
        if (!record || typeof record.path !== "string") {
          respond(res, 400, JSON.stringify({ error: "Expected export path" }));
          return;
        }
        const kind = record.kind === undefined ? "report" : record.kind;
        if (typeof kind !== "string" || !(EXPORT_KINDS as readonly string[]).includes(kind)) {
          respond(res, 400, JSON.stringify({ error: "Invalid export kind" }));
          return;
        }
        const paths = input.store.exportArtifact(kind as ExportKind, record.path, record.overwrite === true);
        respond(res, 200, JSON.stringify({ path: paths[0], paths }));
        return;
      }
      respond(res, 404, JSON.stringify({ error: "Not found" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(
        res,
        message.includes("MiB limit") ? 413 : 400,
        JSON.stringify({ error: message }),
      );
    }
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, bindHost, () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to bind server"));
          return;
        }
        hostPort = address.port;
        const aliases = new Set<string>();
        const add = (value: string) => {
          const formatted = value.includes(":") ? `[${value}]` : value;
          aliases.add(`${formatted}:${hostPort}`.toLowerCase());
        };
        add(address.address);
        if (wildcard) {
          add("127.0.0.1");
          add("::1");
          add("localhost");
          add(hostname());
          for (const entries of Object.values(networkInterfaces())) {
            for (const entry of entries ?? []) add(entry.address);
          }
        } else {
          add(bindHost);
          if (
            bindHost === "localhost" ||
            (isIP(bindHost) === 4 && bindHost.startsWith("127."))
          ) {
            add("localhost");
            add("127.0.0.1");
            add("::1");
          } else if (bindHost === "::1") {
            add("localhost");
            add("127.0.0.1");
            add("::1");
          }
        }
        acceptedHosts = aliases;
        resolveListen();
      });
    });
  } catch (error) {
    input.store.release();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Server has no TCP address");
  let advertised: string;
  if (wildcard) {
    const ipv4 = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
    advertised = ipv4 ?? "127.0.0.1";
  } else if (isIP(bindHost) === 6) {
    advertised = `[${bindHost}]`;
  } else {
    advertised = bindHost;
  }
  let closed = false;
  return {
    url: `http://${advertised}:${address.port}/#${token}`,
    close: () =>
      new Promise<void>((resolveClose, reject) =>
        server.close((error) => {
          if (!closed) {
            closed = true;
            input.store.release();
          }
          if (error) reject(error);
          else resolveClose();
        }),
      ),
  };
}

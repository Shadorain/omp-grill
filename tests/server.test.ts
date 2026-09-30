import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { createStore } from "../src/store";
import { startServer } from "../src/server";
import type { GrillServer } from "../src/types";

const roots: string[] = [];
const servers: GrillServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omp-grill-server-"));
  roots.push(root);
  const store = makeStore(root);
  const server = await startServer({ store, onSubmit: () => {} });
  servers.push(server);
  const url = new URL(server.url);
  return { store, server, origin: url.origin, token: url.hash.slice(1) };
}
function request(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), "x-grill-token": token },
  });
}

function makeStore(root: string) {
  return createStore({
    home: root,
    owner: "alice",
    project: "demo",
    topic: "Design",
  });
}

function addServer(server: GrillServer): GrillServer {
  servers.push(server);
  return server;
}

function ipv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

describe("grill browser server", () => {
  test("requires session token and rejects invalid actions and cross-origin POSTs", async () => {
    const { store, origin, token } = await fixture();
    const stateUrl = `${origin}/api/state`;
    expect((await fetch(stateUrl)).status).toBe(401);
    const rejected = await request(`${origin}/api/send`, token, {
      method: "POST",
      headers: {
        origin: "http://evil.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actions: [{ type: "thread", q: "none", text: "x" }],
      }),
    });
    expect(rejected.status).toBe(403);
    expect(store.state.seq).toBe(0);

    const accepted = await request(`${origin}/api/send`, token, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        actions: [{ type: "thread", q: "none", text: "x" }],
      }),
    });
    expect(accepted.status).toBe(400);
    expect(store.state.seq).toBe(0);
  });
  test("serves self-contained prototypes only to the authenticated session", async () => {
    const { store, origin, token } = await fixture();
    expect((await request(`${origin}/api/prototype`, token)).status).toBe(404);
    store.publish({
      prototype: {
        title: "Tasks",
        start: "board",
        screens: [{
          id: "board",
          title: "Board",
          blocks: [{ id: "name", kind: "input", label: "Task name" }],
        }],
      },
    });
    expect((await fetch(`${origin}/api/prototype`)).status).toBe(401);
    const response = await request(`${origin}/api/prototype`, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    const html = await response.text();
    expect(html).toContain("Task name");
  });

  test("serves sanitized system diagrams only to the authenticated session", async () => {
    const { store, origin, token } = await fixture();
    expect((await request(`${origin}/api/diagram`, token)).status).toBe(404);
    store.publish({
      diagram: {
        title: "System",
        kind: "architecture",
        nodes: [
          { id: "ui", label: "Browser UI" },
          { id: "server", label: "Grill server", detail: "Token-gated HTTP" },
        ],
        edges: [{ from: "ui", to: "server", label: "actions" }],
      },
    });
    expect((await fetch(`${origin}/api/diagram`)).status).toBe(401);
    const response = await request(`${origin}/api/diagram`, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await response.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain("Browser UI");
    expect(svg).not.toContain("<script");
  });

  test("accepts only valid action batch and stores durable delivery failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-grill-server-"));
    roots.push(root);
    const store = createStore({
      home: root,
      owner: "alice",
      project: "demo",
      topic: "Design",
    });
    store.publish({
      questions: [
        {
          id: "q1",
          title: "Choice",
          options: [],
          recommendation: { reason: "No options" },
        },
      ],
    });
    const failureReported = Promise.withResolvers<void>();
    const server = await startServer({
      store,
      onSubmit: async () => {
        throw new Error("delivery failed");
      },
      onChange: () => {
        if (store.state.status === "error") failureReported.resolve();
      },
    });
    servers.push(server);
    const url = new URL(server.url);
    const response = await request(
      `${url.origin}/api/send`,
      url.hash.slice(1),
      {
        method: "POST",
        headers: { origin: url.origin, "content-type": "application/json" },
        body: JSON.stringify({
          actions: [{ type: "thread", q: "q1", text: "Keep this" }],
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ seq: 1, status: "working" });
    await failureReported.promise;
    expect(store.state.status).toBe("error");
    expect(store.state.pending?.seq).toBe(1);
    expect(store.state.questions[0].thread).toEqual([
      { role: "user", text: "Keep this" },
    ]);
  });
  test("leaves durable submissions for explicit resume delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-grill-server-"));
    roots.push(root);
    const store = createStore({
      home: root,
      owner: "alice",
      project: "demo",
      topic: "Design",
    });
    store.publish({
      questions: [
        {
          id: "q1",
          title: "Choice",
          options: [],
          recommendation: { reason: "No options" },
        },
      ],
    });
    const pending = store.submit([
      { type: "thread", q: "q1", text: "Resume this" },
    ]);
    let deliveries = 0;
    const server = await startServer({
      store,
      onSubmit: () => {
        deliveries++;
      },
    });
    servers.push(server);
    expect(deliveries).toBe(0);
    expect(store.state.pending).toEqual(pending);
  });
  test("serves wildcard bindings through a non-loopback interface", async () => {
    const { server, token } = await fixture();
    const url = new URL(server.url);
    const addresses = ipv4Addresses();
    if (addresses.length > 0) {
      expect(addresses).toContain(url.hostname);
      expect(
        (await request(`http://${addresses[0]}:${url.port}/api/state`, token))
          .status,
      ).toBe(200);
    } else {
      expect(url.hostname).toBe("127.0.0.1");
    }
  });

  test("rejects unknown Host headers on wildcard bindings", async () => {
    const { origin, token } = await fixture();
    const response = await request(`${origin}/api/state`, token, {
      headers: { host: `attacker.invalid:${new URL(origin).port}` },
    });
    expect(response.status).toBe(403);
  });

  test("binds fixed settings port and releases it for rebinding", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-grill-server-"));
    roots.push(root);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ host: "127.0.0.1", port }),
    );
    const overridden = addServer(
      await startServer({
        store: makeStore(root),
        onSubmit: () => {},
        port: 0,
      }),
    );
    expect(new URL(overridden.url).port).not.toBe(String(port));
    await overridden.close();
    servers.splice(servers.indexOf(overridden), 1);
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const first = addServer(
      await startServer({ store: makeStore(root), onSubmit: () => {} }),
    );
    expect(new URL(first.url).port).toBe(String(port));
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = addServer(
      await startServer({ store: makeStore(root), onSubmit: () => {} }),
    );
    expect(new URL(second.url).port).toBe(String(port));
  });

  test("loopback binding does not expose server on LAN interfaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-grill-server-"));
    roots.push(root);
    const server = addServer(
      await startServer({
        store: makeStore(root),
        onSubmit: () => {},
        host: "127.0.0.1",
      }),
    );
    const address = ipv4Addresses()[0];
    if (address) {
      const port = new URL(server.url).port;
      await expect(fetch(`http://${address}:${port}/`)).rejects.toThrow();
    }
  });

  test("rejects malformed settings and unavailable fixed ports", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-grill-server-"));
    roots.push(root);
    const store = makeStore(root);
    for (const contents of [
      "{",
      "[]",
      '{"host":"http://localhost"}',
      '{"host":null}',
      '{"port":null}',
      '{"port":1.5}',
      '{"port":-1}',
      '{"port":65536}',
      '{"port":"43127"}',
    ]) {
      writeFileSync(join(root, "settings.json"), contents);
      await expect(
        startServer({ store, onSubmit: () => {} }),
      ).rejects.toThrow();
    }

    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ host: "127.0.0.1", port: 0 }),
    );
    const occupied = addServer(
      await startServer({ store, onSubmit: () => {} }),
    );
    const port = new URL(occupied.url).port;
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ host: "127.0.0.1", port: Number(port) }),
    );
    await expect(
      startServer({ store: makeStore(root), onSubmit: () => {} }),
    ).rejects.toThrow();
  });
});

import { randomBytes } from "node:crypto";
import type { PrototypeAction, PrototypeBlock, PrototypeSpec } from "./types";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, name: string, max = 2000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`Invalid prototype ${name}`);
  return value;
}
function optionalText(value: Record<string, unknown>, key: string, max = 2000): string | undefined {
  return value[key] === undefined ? undefined : text(value[key], key, max);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown prototype ${name} field: ${key}`);
}
function optionalValue(value: unknown, name: string, max = 4000): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid prototype ${name}`);
  return value;
}
export function validatePrototypeSpec(input: unknown): PrototypeSpec {
  if (!record(input)) throw new Error("Invalid prototype spec");
  onlyKeys(input, ["title", "start", "app", "theme", "screens"], "spec");
  const title = text(input.title, "title", 300);
  const start = text(input.start, "start", 100);
  if (!Array.isArray(input.screens) || input.screens.length < 1 || input.screens.length > 12) throw new Error("Invalid prototype screens");
  const screenIds = new Set<string>();
  const blockIds = new Set<string>();
  let blockCount = 0;
  const blocks = (raw: unknown, depth: number): PrototypeBlock[] => {
    if (!Array.isArray(raw) || raw.length > 80 || depth > 5) throw new Error("Invalid prototype blocks");
    return raw.map((item): PrototypeBlock => {
      if (!record(item)) throw new Error("Invalid prototype block");
      onlyKeys(item, ["id", "kind", "label", "text", "value", "options", "columns", "rows", "action", "children"], "block");
      blockCount++;
      if (blockCount > 300) throw new Error("Prototype block limit exceeded");
      const id = text(item.id, "block id", 100);
      if (blockIds.has(id)) throw new Error(`Duplicate prototype block id: ${id}`);
      blockIds.add(id);
      const kinds = ["heading", "text", "button", "input", "select", "checkbox", "table", "list", "card", "dialog"];
      if (typeof item.kind !== "string" || !kinds.includes(item.kind)) throw new Error(`Invalid prototype block kind: ${id}`);
      const kind = item.kind as PrototypeBlock["kind"];
      const label = optionalText(item, "label", 500);
      const body = item.text === undefined ? undefined : optionalValue(item.text, "text");
      const value = item.value === undefined ? undefined : optionalValue(item.value, "value", 1000);
      const options = item.options === undefined ? undefined : (() => {
        if (!Array.isArray(item.options) || item.options.length < 1 || item.options.length > 50) throw new Error(`Invalid options for ${id}`);
        return item.options.map((option) => text(option, "option", 500));
      })();
      if (item.value !== undefined && !["input", "select", "checkbox"].includes(kind)) throw new Error(`Unexpected value for ${id}`);
      if (item.options !== undefined && kind !== "select" && kind !== "list") throw new Error(`Unexpected options for ${id}`);
      if ((item.columns !== undefined || item.rows !== undefined) && kind !== "table") throw new Error(`Unexpected table data for ${id}`);
      if (item.children !== undefined && !["card", "dialog", "list"].includes(kind)) throw new Error(`Unexpected children for ${id}`);
      const columns = item.columns === undefined ? undefined : (() => {
        if (!Array.isArray(item.columns) || item.columns.length < 1 || item.columns.length > 20) throw new Error(`Invalid columns for ${id}`);
        return item.columns.map((column) => text(column, "column", 200));
      })();
      const rows = item.rows === undefined ? undefined : (() => {
        if (!Array.isArray(item.rows) || item.rows.length > 100) throw new Error(`Invalid rows for ${id}`);
        return item.rows.map((row) => {
          if (!Array.isArray(row) || row.length !== columns?.length) throw new Error(`Invalid row for ${id}`);
          return row.map((cell) => optionalValue(cell, "table cell", 1000));
        });
      })();
      let action: PrototypeAction | undefined;
      if (item.action !== undefined) {
        if (!record(item.action) || typeof item.action.type !== "string" || !["navigate", "set", "toggle", "open", "close", "submit"].includes(item.action.type)) throw new Error(`Invalid action for ${id}`);
        onlyKeys(item.action, ["type", "target", "value"], "action");
        action = { type: item.action.type as PrototypeAction["type"], target: text(item.action.target, "action target", 100), ...(item.action.value === undefined ? {} : { value: optionalValue(item.action.value, "action value", 1000) }) };
      }
      if (action !== undefined && !["button", "card"].includes(kind)) throw new Error(`Unexpected action for ${id}`);
      const children = item.children === undefined ? undefined : blocks(item.children, depth + 1);
      if (kind === "select" && !options) throw new Error(`Select requires options: ${id}`);
      if (kind === "select" && value !== undefined && !options?.includes(value)) throw new Error(`Unknown selected option for ${id}`);
      if (kind === "checkbox" && value !== undefined && value !== "true" && value !== "false") throw new Error(`Invalid checkbox value for ${id}`);
      if (kind === "table" && (!columns || !rows)) throw new Error(`Table requires columns and rows: ${id}`);
      return { id, kind, ...(label === undefined ? {} : { label }), ...(body === undefined ? {} : { text: body }), ...(value === undefined ? {} : { value }), ...(options === undefined ? {} : { options }), ...(columns === undefined ? {} : { columns }), ...(rows === undefined ? {} : { rows }), ...(action === undefined ? {} : { action }), ...(children === undefined ? {} : { children }) };
    });
  };
  const screens = input.screens.map((raw) => {
    if (!record(raw)) throw new Error("Invalid prototype screen");
    onlyKeys(raw, ["id", "title", "layout", "blocks"], "screen");
    const id = text(raw.id, "screen id", 100);
    if (screenIds.has(id)) throw new Error(`Duplicate prototype screen id: ${id}`);
    screenIds.add(id);
    const layout = raw.layout;
    if (layout !== undefined && (typeof layout !== "string" || !["dashboard", "split", "form", "content"].includes(layout))) throw new Error(`Invalid layout for ${id}`);
    return { id, title: text(raw.title, "screen title", 300), ...(layout === undefined ? {} : { layout: layout as "dashboard" | "split" | "form" | "content" }), blocks: blocks(raw.blocks, 0) };
  });
  if (!screenIds.has(start)) throw new Error("Prototype start references unknown screen");
  const themeRaw = input.theme;
  let theme: PrototypeSpec["theme"];
  if (themeRaw !== undefined) {
    if (!record(themeRaw)) throw new Error("Invalid prototype theme");
    onlyKeys(themeRaw, ["background", "surface", "text", "accent", "radius", "font"], "theme");
    const colors: Record<string, string> = {};
    for (const key of ["background", "surface", "text", "accent"] as const) {
      const color = optionalText(themeRaw, key, 7);
      if (color !== undefined) {
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`Invalid prototype ${key} color`);
        colors[key] = color;
      }
    }
    const radius = themeRaw.radius;
    if (radius !== undefined && (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0 || radius > 32)) throw new Error("Invalid prototype radius");
    const font = themeRaw.font;
    if (font !== undefined && font !== "sans" && font !== "serif" && font !== "mono") throw new Error("Invalid prototype font");
    theme = { ...colors, ...(radius === undefined ? {} : { radius }), ...(font === undefined ? {} : { font }) };
  }
  let app: PrototypeSpec["app"];
  if (input.app !== undefined) {
    if (!record(input.app)) throw new Error("Invalid prototype app");
    const chrome = input.app.chrome;
    onlyKeys(input.app, ["name", "route", "chrome"], "app");
    if (chrome !== undefined && (!Array.isArray(chrome) || chrome.length > 12)) throw new Error("Invalid prototype app chrome");
    app = { name: text(input.app.name, "app name", 200), ...(optionalText(input.app, "route", 300) === undefined ? {} : { route: input.app.route as string }), ...(chrome === undefined ? {} : { chrome: chrome.map((item) => text(item, "chrome label", 200)) }) };
  }
  const blockKind = new Map<string, PrototypeBlock["kind"]>();
  const recordKinds = (nodes: PrototypeBlock[]): void => {
    for (const node of nodes) {
      blockKind.set(node.id, node.kind);
      recordKinds(node.children ?? []);
    }
  };
  for (const screen of screens) recordKinds(screen.blocks);
  for (const screen of screens) for (const block of screen.blocks) {
    const visit = (node: PrototypeBlock): void => {
      if (node.action) {
        const { type, target } = node.action;
        if ((type === "navigate" || type === "submit") && !screenIds.has(target)) throw new Error(`Action references unknown screen: ${target}`);
        if (type === "set" && node.action.value === undefined) throw new Error(`Set action requires a value: ${node.id}`);
        if (type === "set" && blockKind.get(target) === "checkbox" && !["true", "false"].includes(node.action.value ?? "")) throw new Error(`Set action requires a checkbox value: ${target}`);
        if (type === "set" && !["input", "select", "checkbox"].includes(blockKind.get(target) ?? "")) throw new Error(`Set action references invalid control: ${target}`);
        if (type === "toggle" && blockKind.get(target) !== "checkbox") throw new Error(`Toggle action references invalid control: ${target}`);
        if ((type === "open" || type === "close") && blockKind.get(target) !== "dialog") throw new Error(`Dialog action references invalid dialog: ${target}`);
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(block);
  }
  return { title, start, ...(app === undefined ? {} : { app }), ...(theme === undefined ? {} : { theme }), screens };
}

export function renderPrototype(input: PrototypeSpec & { version?: number; stale?: boolean }): string {
  const spec = validatePrototypeSpec({
    title: input.title,
    start: input.start,
    ...(input.app === undefined ? {} : { app: input.app }),
    ...(input.theme === undefined ? {} : { theme: input.theme }),
    screens: input.screens,
  });
  const data = JSON.stringify(spec).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const nonce = randomBytes(18).toString("base64");
  const snapshot = JSON.stringify({
    version: Number.isSafeInteger(input.version) && (input.version ?? 0) > 0 ? input.version : null,
    stale: input.stale === true,
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"><title>Prototype</title><style nonce="${nonce}">
:root { color-scheme:light; --bg:#f1f5f9; --surface:#fff; --ink:#172033; --accent:#4f46e5; --button-ink:#fff; --radius:12px; font-family:Arial,sans-serif }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--ink); font-family:inherit }
.bar { display:flex; gap:12px; align-items:center; padding:14px 22px; background:var(--surface); border-bottom:1px solid #94a3b8 }
.bar strong { font-size:18px }
.bar nav { display:flex; gap:8px; flex-wrap:wrap }
button { cursor:pointer; border:0; border-radius:var(--radius); padding:9px 13px; background:var(--accent); color:var(--button-ink); font:inherit }
button:focus-visible, [role=button]:focus-visible { outline:2px solid var(--ink); outline-offset:3px }
.bar button { background:transparent; color:inherit }
.bar button[aria-current=page] { background:var(--accent); color:var(--button-ink) }
main { max-width:1100px; margin:28px auto; padding:0 20px }
.blocks { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px }
.blocks.layout-split { grid-template-columns:minmax(0,3fr) minmax(0,2fr) }
.blocks.layout-form { grid-template-columns:minmax(0,1fr); max-width:640px; margin-inline:auto }
.blocks.layout-content { grid-template-columns:minmax(0,1fr) }
.block { min-width:0; padding:18px; background:var(--surface); border-radius:var(--radius); box-shadow:0 1px 3px #0f172a18 }
.block h2,.block h3 { margin-top:0 }
.block p { white-space:pre-wrap; overflow-wrap:anywhere }
.block label { display:block; font-weight:600; margin-bottom:6px }
input,select { width:100%; padding:10px; border:1px solid #94a3b8; border-radius:8px; font:inherit; color:var(--ink); background:var(--bg) }
input[type=checkbox] { width:auto; accent-color:var(--accent) }
table { border-collapse:collapse; width:100%; overflow-wrap:anywhere }
td,th { text-align:left; padding:8px; border-bottom:1px solid #94a3b8 }
dialog { border:1px solid #94a3b8; border-radius:var(--radius); width:min(600px,90vw); max-height:90vh; background:var(--surface); color:var(--ink) }
dialog::backdrop { background:#0f172a88 }
.chrome { color:var(--ink); opacity:.7; font-size:13px }
.snapshot { padding:12px 22px; border-bottom:1px solid #94a3b8; background:var(--surface); font-size:13px }
@media(max-width:650px) { .blocks,.blocks.layout-split { grid-template-columns:1fr } .bar { align-items:flex-start; flex-direction:column } }
</style></head><body><header class="bar"><strong id="appname"></strong><nav id="nav" aria-label="Screens"></nav><span class="chrome" id="route"></span><button id="reset" type="button">Reset</button></header><div id="snapshot-status" class="snapshot" role="status"></div><main id="main"></main><script nonce="${nonce}">
const spec = ${data};
const snapshot = ${snapshot};
document.getElementById('snapshot-status').textContent = 'Local UI prototype' + (snapshot.version ? ' · version ' + snapshot.version : '') + (snapshot.stale ? ' · OUT OF DATE: decisions changed; regenerate in Grill before treating this as current.' : ' · controls do not save production data.');
let screen = spec.start;
const values = Object.create(null);
const dialogs = Object.create(null);
const host = document.getElementById('main');
const nav = document.getElementById('nav');
document.getElementById('appname').textContent = spec.app?.name || spec.title;
document.getElementById('route').textContent = [spec.app?.route, ...(spec.app?.chrome || [])].filter(Boolean).join(' · ');
const theme = spec.theme || {};
for (const [key, css] of [['background','--bg'], ['surface','--surface'], ['text','--ink'], ['accent','--accent']]) {
  if (theme[key]) document.documentElement.style.setProperty(css, theme[key]);
}
const accent = (theme.accent || '#4f46e5').slice(1).match(/../g).map((channel) => {
  const value = parseInt(channel, 16) / 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
});
const luminance = .2126 * accent[0] + .7152 * accent[1] + .0722 * accent[2];
document.documentElement.style.setProperty('--button-ink', luminance > .179 ? '#000' : '#fff');
if (theme.radius !== undefined) document.documentElement.style.setProperty('--radius', theme.radius + 'px');
document.body.style.fontFamily = theme.font === 'serif' ? 'Georgia,serif' : theme.font === 'mono' ? 'monospace' : 'Arial,sans-serif';
function element(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}
function seed(blocks) {
  for (const block of blocks) {
    if (block.kind === 'input') values[block.id] = block.value ?? '';
    if (block.kind === 'select') values[block.id] = block.value ?? block.options[0];
    if (block.kind === 'checkbox') values[block.id] = block.value === 'true';
    seed(block.children || []);
  }
}
function display(value) {
  return String(value ?? '').replace(/\\{\\{([^{}]+)\\}\\}/g, (_, id) => String(values[id] ?? ''));
}
function go(target) {
  screen = target;
  for (const id of Object.keys(dialogs)) dialogs[id] = false;
  draw();
}
function act(action) {
  if (!action) return;
  if (action.type === 'navigate' || action.type === 'submit') { go(action.target); return; }
  if (action.type === 'open') dialogs[action.target] = true;
  else if (action.type === 'close') dialogs[action.target] = false;
  else if (action.type === 'toggle') values[action.target] = !values[action.target];
  else if (action.type === 'set') values[action.target] = typeof values[action.target] === 'boolean' ? action.value === 'true' : action.value ?? '';
  draw();
}
function make(block) {
  const wrap = element('section', 'block');
  wrap.dataset.id = block.id;
  let node;
  if (block.kind === 'heading' || block.kind === 'text') {
    node = element(block.kind === 'heading' ? 'h2' : 'p');
    node.textContent = display(block.text ?? block.label ?? '');
    wrap.append(node);
  } else if (block.kind === 'button') {
    node = element('button');
    node.type = 'button';
    node.textContent = display(block.label || block.text || 'Continue');
    node.addEventListener('click', (event) => { event.stopPropagation(); act(block.action); });
    wrap.append(node);
  } else if (['input', 'select', 'checkbox'].includes(block.kind)) {
    const id = 'control-' + block.id;
    if (block.kind === 'select') {
      node = element('select');
      for (const value of block.options) {
        const option = element('option');
        option.value = value;
        option.textContent = value;
        node.append(option);
      }
    } else {
      node = element('input');
      if (block.kind === 'checkbox') node.type = 'checkbox';
    }
    node.id = id;
    if (block.kind === 'checkbox') node.checked = values[block.id];
    else node.value = values[block.id];
    node.addEventListener(block.kind === 'input' ? 'input' : 'change', () => {
      values[block.id] = block.kind === 'checkbox' ? node.checked : node.value;
    });
    if (block.label) {
      const label = element('label');
      label.htmlFor = id;
      label.textContent = block.label;
      wrap.append(label);
    }
    wrap.append(node);
  } else if (block.kind === 'table') {
    node = element('table');
    const head = element('tr');
    for (const column of block.columns) { const cell = element('th'); cell.textContent = column; head.append(cell); }
    node.append(head);
    for (const row of block.rows) {
      const line = element('tr');
      for (const value of row) { const cell = element('td'); cell.textContent = value; line.append(cell); }
      node.append(line);
    }
    wrap.append(node);
  } else if (block.kind === 'list') {
    node = element('ul');
    for (const value of block.options || []) { const item = element('li'); item.textContent = display(value); node.append(item); }
    for (const child of block.children || []) { const item = element('li'); item.append(make(child)); node.append(item); }
    wrap.append(node);
  } else if (block.kind === 'dialog') {
    node = element('dialog');
    node.id = 'dialog-' + block.id;
    node.dataset.dialog = block.id;
    node.addEventListener('cancel', () => { dialogs[block.id] = false; });
    node.addEventListener('close', () => { if (node.isConnected) dialogs[block.id] = false; });
    if (block.label) { const title = element('h2'); title.textContent = block.label; node.append(title); }
    for (const child of block.children || []) node.append(make(child));
    wrap.append(node);
  } else {
    if (block.label) { node = element('h3'); node.textContent = block.label; wrap.append(node); }
    if (block.text) { node = element('p'); node.textContent = display(block.text); wrap.append(node); }
    for (const child of block.children || []) wrap.append(make(child));
  }
  if (block.action && block.kind === 'card') {
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'button');
    wrap.addEventListener('click', (event) => { if (!event.target.closest('input,select,button')) act(block.action); });
    wrap.addEventListener('keydown', (event) => {
      if (event.target === wrap && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); act(block.action); }
    });
  }
  return wrap;
}
function draw() {
  nav.replaceChildren();
  host.replaceChildren();
  for (const item of spec.screens) {
    const button = element('button');
    button.type = 'button';
    button.textContent = item.title;
    button.setAttribute('aria-current', item.id === screen ? 'page' : 'false');
    button.addEventListener('click', () => go(item.id));
    nav.append(button);
    if (item.id !== screen) continue;
    const section = element('section', 'screen active');
    const title = element('h1');
    title.textContent = item.title;
    section.append(title);
    const grid = element('div', 'blocks layout-' + (item.layout || 'dashboard'));
    for (const block of item.blocks) grid.append(make(block));
    section.append(grid);
    host.append(section);
  }
  for (const dialog of host.querySelectorAll('dialog')) {
    if (dialogs[dialog.dataset.dialog]) dialog.showModal();
  }
}
document.getElementById('reset').addEventListener('click', () => {
  screen = spec.start;
  for (const key of Object.keys(values)) delete values[key];
  for (const key of Object.keys(dialogs)) delete dialogs[key];
  for (const item of spec.screens) seed(item.blocks);
  draw();
});
for (const item of spec.screens) seed(item.blocks);
draw();
</script></body></html>`;
}

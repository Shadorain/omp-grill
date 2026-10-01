import type { DiagramSpec } from "./types";

function escape(value: string): string {
  return value.replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char] ?? char);
}

export function renderDiagram(spec: DiagramSpec): string {
  const columns = 4;
  const rows = Math.max(1, Math.ceil(spec.nodes.length / columns));
  const height =
    spec.kind === "sequence"
      ? Math.max(180, 160 + spec.edges.length * 38)
      : 90 + rows * 150;
  const nodes = spec.nodes;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  let viewWidth = 960;
  let center = (i: number) => 90 + i * (780 / Math.max(1, nodes.length - 1));
  if (spec.kind === "sequence") {
    const n = nodes.length;
    const actorWidth = 130;
    const minGap = 10;
    const neededSpacing = actorWidth + minGap;
    let span = 780;
    if (n > 1) {
      const origSpacing = span / (n - 1);
      if (origSpacing < neededSpacing) {
        span = neededSpacing * (n - 1);
      }
    }
    viewWidth = 180 + span;
    center = (i: number) => 90 + i * (span / Math.max(1, n - 1));
  }
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewWidth} ${height}" role="img" aria-label="${escape(spec.title)}">`,
    `<title>${escape(spec.title)}</title>`,
    `<rect width="100%" height="100%" fill="#111827"/>`,
    `<text x="24" y="34" fill="#f8fafc" font-size="20">${escape(spec.title)}</text>`,
  ];
  if (spec.kind === "sequence") {
    nodes.forEach((node, i) => {
      const x = center(i);
      lines.push(`<rect x="${x - 65}" y="54" width="130" height="38" rx="8" fill="#312e81" stroke="#a5b4fc"/>`);
      lines.push(`<text x="${x}" y="78" text-anchor="middle" fill="#fff" font-size="13">${escape(node.label)}</text>`);
      lines.push(`<line x1="${x}" y1="92" x2="${x}" y2="${height - 18}" stroke="#818cf8" stroke-dasharray="5 5"/>`);
    });
    spec.edges.forEach((edge, i) => {
      const from = index.get(edge.from);
      const to = index.get(edge.to);
      if (from === undefined || to === undefined) return;
      const y = 125 + i * 38;
      const x1 = center(from);
      const x2 = center(to);
      if (from === to) {
        // visible self-message loop to the right of the lifeline
        const loopOut = 30;
        const loopDown = 14;
        lines.push(`<line x1="${x1}" y1="${y}" x2="${x1 + loopOut}" y2="${y}" stroke="#f0abfc"/>`);
        lines.push(`<line x1="${x1 + loopOut}" y1="${y}" x2="${x1 + loopOut}" y2="${y + loopDown}" stroke="#f0abfc"/>`);
        lines.push(`<line x1="${x1 + loopOut}" y1="${y + loopDown}" x2="${x1}" y2="${y + loopDown}" stroke="#f0abfc" marker-end="url(#arrow)"/>`);
        if (edge.label) lines.push(`<text x="${x1 + loopOut / 2}" y="${y - 4}" text-anchor="middle" fill="#f5d0fe" font-size="12">${escape(edge.label)}</text>`);
        return;
      }
      lines.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#f0abfc" marker-end="url(#arrow)"/>`);
      if (edge.label) lines.push(`<text x="${(x1 + x2) / 2}" y="${y - 5}" text-anchor="middle" fill="#f5d0fe" font-size="12">${escape(edge.label)}</text>`);
    });
    lines.splice(2, 0, '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#f0abfc"/></marker></defs>');
  } else {
    const halfWidth = spec.kind === "state" ? 65 : 72;
    const halfHeight = spec.kind === "state" ? 26 : 29;
    const positions = nodes.map((_, i) => ({ x: 120 + (i % columns) * 240, y: 150 + Math.floor(i / columns) * 150 }));
    // Point where the ray from a node's center toward (dx, dy) leaves its box, plus a small gap for the arrowhead.
    const exit = (p: { x: number; y: number }, dx: number, dy: number) => {
      const length = Math.hypot(dx, dy) || 1;
      const t = Math.min(dx ? halfWidth / Math.abs(dx) : Infinity, dy ? halfHeight / Math.abs(dy) : Infinity);
      return { x: p.x + dx * t + (dx / length) * 4, y: p.y + dy * t + (dy / length) * 4 };
    };
    const labels: string[] = [];
    spec.edges.forEach((edge) => {
      const from = index.get(edge.from);
      const to = index.get(edge.to);
      if (from === undefined || to === undefined) return;
      const a = positions[from]!;
      const b = positions[to]!;
      if (from === to) {
        // visible self-loop above the node for state/self transitions
        const hx = a.x;
        const hy = a.y - halfHeight - 2;
        lines.push(`<path d="M${hx-8},${hy} Q${hx+22},${hy-20} ${hx+4},${hy-28} Q${hx-14},${hy-20} ${hx},${hy}" fill="none" stroke="#f0abfc" stroke-width="1.5" marker-end="url(#arrow)"/>`);
        if (edge.label) labels.push(`<text x="${hx + 6}" y="${hy - 30}" text-anchor="middle" fill="#f5d0fe" font-size="11" stroke="#111827" stroke-width="4" paint-order="stroke">${escape(edge.label)}</text>`);
        return;
      }
      const label = (x: number, y: number) => edge.label && labels.push(`<text x="${x}" y="${y}" text-anchor="middle" fill="#f5d0fe" font-size="11" stroke="#111827" stroke-width="4" paint-order="stroke">${escape(edge.label)}</text>`);
      if (a.y === b.y && Math.abs(from - to) > 1) {
        // A straight line would run through the nodes between them; arc over the row instead.
        const top = a.y - halfHeight;
        const control = { x: (a.x + b.x) / 2, y: top - 40 - 12 * Math.abs(from - to) };
        lines.push(`<path d="M${a.x},${top} Q${control.x},${control.y} ${b.x},${top - 4}" fill="none" stroke="#f0abfc" stroke-width="1.5" marker-end="url(#arrow)"/>`);
        label(control.x, (top + control.y) / 2 - 4);
        return;
      }
      const start = exit(a, b.x - a.x, b.y - a.y);
      const end = exit(b, a.x - b.x, a.y - b.y);
      lines.push(`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#f0abfc" stroke-width="1.5" marker-end="url(#arrow)"/>`);
      label((start.x + end.x) / 2, (start.y + end.y) / 2 - 8);
    });
    lines.splice(2, 0, '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#f0abfc"/></marker></defs>');
    nodes.forEach((node, i) => {
      const { x, y } = positions[i]!;
      lines.push(`<rect x="${x - halfWidth}" y="${y - halfHeight}" width="${halfWidth * 2}" height="${halfHeight * 2}" rx="${spec.kind === "state" ? 22 : 10}" fill="#312e81" stroke="#a5b4fc"/>`);
      lines.push(`<text x="${x}" y="${node.detail ? y - 2 : y + 4}" text-anchor="middle" fill="#fff" font-size="13">${escape(node.label)}</text>`);
      if (node.detail) lines.push(`<text x="${x}" y="${y + 14}" text-anchor="middle" fill="#cbd5e1" font-size="10">${escape(node.detail)}</text>`);
    });
    // Labels last so nodes never cover them.
    lines.push(...labels);
  }
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

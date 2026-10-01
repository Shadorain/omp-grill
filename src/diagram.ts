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

function wrap(value: string, limit: number): string[] {
  const result: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (word.length > limit) {
        if (line) result.push(line);
        line = "";
        for (let offset = 0; offset < word.length; offset += limit) result.push(word.slice(offset, offset + limit));
      } else if (!line) line = word;
      else if (`${line} ${word}`.length <= limit) line += ` ${word}`;
      else { result.push(line); line = word; }
    }
    if (line) result.push(line);
  }
  return result.length ? result : [""];
}

function textLines(value: string, x: number, y: number, options: {
  limit: number;
  size: number;
  color: string;
  anchor?: string;
}): string {
  const anchor = options.anchor || "middle";
  const lines = wrap(value, options.limit);
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${options.color}" font-size="${options.size}" font-family="system-ui, sans-serif">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? options.size + 3 : 0}">${escape(line)}</tspan>`).join("")}</text>`;
}

export function renderDiagram(spec: DiagramSpec): string {
  const columns = 4;
  const nodes = spec.nodes;
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const sequence = spec.kind === "sequence";
  const nodeWidth = sequence ? 160 : 200;
  const edgeLabelLimit = 24;
  const maxEdgeLines = Math.max(0, ...spec.edges.map((edge) => edge.label ? wrap(edge.label, edgeLabelLimit).length : 0));
  const titleLines = wrap(spec.title, 72);
  const titleBottom = 34 + (titleLines.length - 1) * 23 + 22;
  const nodeHeight = sequence
    ? Math.max(60, ...nodes.map((node) => wrap(node.label, 20).length * 16 + 18))
    : Math.max(108, ...nodes.map((node) => wrap(node.label, 24).length * 18 + (node.detail ? wrap(node.detail, 29).length * 14 : 0) + 32));
  const rowGap = sequence ? 0 : maxEdgeLines * 15 + 40;
  let viewWidth = 0;
  let height = 0;
  let center = (i: number) => 0;
  let positions: { x: number; y: number }[] = [];
  if (sequence) {
    const columnGap = edgeLabelLimit * 6 + 46;
    const pitch = nodeWidth + columnGap;
    const margin = 30;
    viewWidth = margin * 2 + Math.max(1, nodes.length) * nodeWidth + Math.max(0, nodes.length - 1) * columnGap;
    center = (i: number) => margin + nodeWidth / 2 + i * pitch;
    const actorTop = titleBottom + 32;
    const messageTop = actorTop + nodeHeight + 48;
    let messageHeight = 0;
    for (const edge of spec.edges) {
      const lines = edge.label ? wrap(edge.label, edgeLabelLimit).length : 0;
      messageHeight += Math.max(52, lines * 16 + 30);
    }
    height = messageTop + messageHeight + 32;
    positions = nodes.map((_, i) => ({ x: center(i), y: actorTop }));
  } else {
    const labelGap = edgeLabelLimit * 6 + 24;
    const pitch = nodeWidth + labelGap;
    const margin = 30;
    viewWidth = margin * 2 + columns * nodeWidth + (columns - 1) * labelGap;
    center = (i: number) => margin + nodeWidth / 2 + (i % columns) * pitch;
    const halfHeight = nodeHeight / 2;
    const hasRowArc = spec.edges.some((edge) => {
      const from = index.get(edge.from);
      const to = index.get(edge.to);
      return from !== undefined && to !== undefined && from !== to && Math.floor(from / columns) === Math.floor(to / columns) && Math.abs(from - to) > 1;
    });
    const hasSelfEdge = spec.edges.some((edge) => edge.from === edge.to);
    const arcRise = hasRowArc ? 42 + 12 * (columns - 1) : hasSelfEdge ? 37 : 0;
    const labelHeadroom = maxEdgeLines * 15 + 20;
    const firstTop = titleBottom + halfHeight + arcRise + labelHeadroom;
    height = firstTop + rows * nodeHeight + Math.max(0, rows - 1) * rowGap + 32;
    positions = nodes.map((_, i) => ({
      x: center(i),
      y: firstTop + halfHeight + Math.floor(i / columns) * (nodeHeight + rowGap),
    }));
  }
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewWidth} ${height}" role="img" aria-label="${escape(spec.title)}">`,
    `<title>${escape(spec.title)}</title>`,
    `<rect width="100%" height="100%" fill="#101522"/>`,
    textLines(spec.title, 24, 34, { limit: 72, size: 20, color: "#f8fafc", anchor: "start" }),
    '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#c4b5fd"/></marker></defs>',
  ];
  if (sequence) {
    nodes.forEach((node, i) => {
      const { x, y } = positions[i]!;
      lines.push(`<rect x="${x - nodeWidth / 2}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" rx="12" fill="#211d35" stroke="#8b7cc4"/>`);
      lines.push(textLines(node.label, x, y + (nodeHeight - wrap(node.label, 20).length * 16) / 2 + 12, { limit: 20, size: 13, color: "#f4f0ff" }));
      lines.push(`<line x1="${x}" y1="${y + nodeHeight}" x2="${x}" y2="${height - 18}" stroke="#70658f" stroke-dasharray="5 6"/>`);
    });
    const firstActor = positions[0];
    let y = firstActor ? firstActor.y + nodeHeight + 48 : titleBottom + 80;
    spec.edges.forEach((edge) => {
      const from = index.get(edge.from);
      const to = index.get(edge.to);
      if (from === undefined || to === undefined) return;
      const x1 = center(from);
      const x2 = center(to);
      const labelLines = edge.label ? wrap(edge.label, edgeLabelLimit) : [];
      if (from === to) {
        const loopOut = 32;
        lines.push(`<line x1="${x1}" y1="${y}" x2="${x1 + loopOut}" y2="${y}" stroke="#c4b5fd"/>`);
        lines.push(`<line x1="${x1 + loopOut}" y1="${y}" x2="${x1 + loopOut}" y2="${y + 14}" stroke="#c4b5fd"/>`);
        lines.push(`<line x1="${x1 + loopOut}" y1="${y + 14}" x2="${x1}" y2="${y + 14}" stroke="#c4b5fd" marker-end="url(#arrow)"/>`);
        if (edge.label) lines.push(textLines(edge.label, x1 + loopOut / 2, y - labelLines.length * 15 - 5, { limit: edgeLabelLimit, size: 12, color: "#e9d5ff" }));
      } else {
        lines.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#c4b5fd" marker-end="url(#arrow)"/>`);
        if (edge.label) lines.push(textLines(edge.label, (x1 + x2) / 2, y - labelLines.length * 15 - 5, { limit: edgeLabelLimit, size: 12, color: "#e9d5ff" }));
      }
      y += Math.max(52, labelLines.length * 16 + 30);
    });
  } else {
    const halfWidth = nodeWidth / 2;
    const halfHeight = nodeHeight / 2;
    const exit = (p: { x: number; y: number }, dx: number, dy: number) => {
      const length = Math.hypot(dx, dy) || 1;
      const t = Math.min(dx ? halfWidth / Math.abs(dx) : Infinity, dy ? halfHeight / Math.abs(dy) : Infinity);
      return { x: p.x + dx * t + (dx / length) * 6, y: p.y + dy * t + (dy / length) * 6 };
    };
    const labels: string[] = [];
    spec.edges.forEach((edge) => {
      const from = index.get(edge.from);
      const to = index.get(edge.to);
      if (from === undefined || to === undefined) return;
      const a = positions[from]!;
      const b = positions[to]!;
      const labelLines = edge.label ? wrap(edge.label, edgeLabelLimit) : [];
      const addLabel = (x: number, y: number) => {
        if (edge.label) labels.push(textLines(edge.label, x, y - labelLines.length * 15 - 5, { limit: edgeLabelLimit, size: 11, color: "#e9d5ff" }));
      };
      if (from === to) {
        const hy = a.y - halfHeight - 2;
        lines.push(`<path d="M${a.x - 8},${hy} Q${a.x + 30},${hy - 26} ${a.x + 4},${hy - 34} Q${a.x - 16},${hy - 24} ${a.x},${hy}" fill="none" stroke="#c4b5fd" marker-end="url(#arrow)"/>`);
        addLabel(a.x + 14, hy - 37);
        return;
      }
      if (a.y === b.y && Math.abs(from - to) > 1) {
        const top = a.y - halfHeight;
        const control = { x: (a.x + b.x) / 2, y: top - 42 - 12 * Math.abs(from - to) };
        lines.push(`<path d="M${a.x},${top} Q${control.x},${control.y} ${b.x},${top - 4}" fill="none" stroke="#c4b5fd" marker-end="url(#arrow)"/>`);
        addLabel(control.x, control.y);
        return;
      }
      const start = exit(a, b.x - a.x, b.y - a.y);
      const end = exit(b, a.x - b.x, a.y - b.y);
      lines.push(`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#c4b5fd" marker-end="url(#arrow)"/>`);
      if (edge.label && a.y !== b.y) {
        const labelY = Math.min(a.y, b.y) + halfHeight + (rowGap - labelLines.length * 14) / 2 + 12;
        labels.push(textLines(edge.label, (start.x + end.x) / 2, labelY, { limit: edgeLabelLimit, size: 11, color: "#e9d5ff" }));
      } else addLabel((start.x + end.x) / 2, (start.y + end.y) / 2);
    });
    nodes.forEach((node, i) => {
      const { x, y } = positions[i]!;
      lines.push(`<rect x="${x - halfWidth}" y="${y - halfHeight}" width="${nodeWidth}" height="${nodeHeight}" rx="${spec.kind === "state" ? 24 : 12}" fill="#211d35" stroke="#8b7cc4"/>`);
      const labelRows = wrap(node.label, 24);
      const detailRows = node.detail ? wrap(node.detail, 29) : [];
      const totalHeight = labelRows.length * 18 + detailRows.length * 14;
      let textY = y - totalHeight / 2 + 13;
      lines.push(textLines(node.label, x, textY, { limit: 24, size: 13, color: "#f4f0ff" }));
      textY += labelRows.length * 18;
      if (node.detail) lines.push(textLines(detailRows.join(" "), x, textY, { limit: 29, size: 10, color: "#c7c1d8" }));
    });
    lines.push(...labels);
  }
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

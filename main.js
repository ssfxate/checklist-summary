"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => ChecklistSummaryPlugin,
  orderStatuses: () => orderStatuses,
  parseDocument: () => parseDocument,
  serializeCounts: () => serializeCounts
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var LIST_ITEM_RE = /^(\s*)[-*+]\s+(?:\[([^\]])\]\s*)?(.*)$/;
var HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*$/;
var FENCE_RE = /^ {0,3}(```|~~~)/;
var BLANK_RE = /^\s*$/;
var BASE_STATUS_ORDER = [" ", "/", "-", "?", ">", "x"];
var ENABLE_GROUP_SUMMARIES = true;
var ENABLE_SECTION_SUMMARIES = true;
var VIRTUAL_ANCHOR = "virtual";
var INLINE_ANCHOR = "inline";
var SECTION_ANCHOR = "section";
var GROUP_ANCHOR = "group";
var LOCAL_ANCHOR = "local";
function normalizeText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}
function countIndent(whitespace) {
  let total = 0;
  for (const char of whitespace) {
    total += char === "	" ? 4 : 1;
  }
  return total;
}
function addCount(counts, symbol, amount = 1) {
  counts[symbol] = (counts[symbol] || 0) + amount;
}
function mergeCounts(target, source) {
  for (const [symbol, count] of Object.entries(source)) {
    addCount(target, symbol, count);
  }
  return target;
}
function subtractCounts(source, symbol) {
  const result = { ...source };
  if (!symbol || !result[symbol]) {
    return result;
  }
  result[symbol] -= 1;
  if (result[symbol] <= 0) {
    delete result[symbol];
  }
  return result;
}
function hasCounts(counts) {
  return Object.keys(counts).length > 0;
}
function orderStatuses(counts) {
  const extras = Object.keys(counts).filter((symbol) => !BASE_STATUS_ORDER.includes(symbol)).sort((left, right) => left.localeCompare(right));
  return BASE_STATUS_ORDER.filter((symbol) => counts[symbol] > 0).concat(extras);
}
function serializeCounts(counts) {
  return orderStatuses(counts).map((symbol) => `${JSON.stringify(symbol)}:${counts[symbol]}`).join("|");
}
function hasExternalMarkdownLink(text) {
  return /!?\[[^\]]+\]\([^)]+\)/.test(text);
}
function getEntrySortLine(entry) {
  return entry.entryType === VIRTUAL_ANCHOR ? entry.beforeLine : entry.line;
}
function getEntrySortRank(entry) {
  if (entry.entryType === VIRTUAL_ANCHOR) {
    return 0;
  }
  if (entry.anchorType === SECTION_ANCHOR) {
    return 1;
  }
  if (entry.anchorType === LOCAL_ANCHOR) {
    return 2;
  }
  if (entry.anchorType === GROUP_ANCHOR) {
    return 3;
  }
  return 4;
}
function createSummaryElement(doc, counts, options = {}) {
  const container = doc.createElement(options.block ? "div" : "span");
  container.className = `checklist-summary ${options.block ? "checklist-summary--virtual" : "checklist-summary--inline"}`;
  for (const symbol of orderStatuses(counts)) {
    const statusEl = doc.createElement("span");
    statusEl.className = "checklist-summary__status";
    const checkboxEl = doc.createElement("input");
    checkboxEl.type = "checkbox";
    checkboxEl.checked = symbol !== " ";
    checkboxEl.tabIndex = -1;
    checkboxEl.setAttribute("aria-hidden", "true");
    if (symbol !== " ") {
      checkboxEl.setAttribute("data-task", symbol);
    }
    const countEl = doc.createElement("span");
    countEl.className = "checklist-summary__count";
    countEl.textContent = String(counts[symbol]);
    statusEl.appendChild(checkboxEl);
    statusEl.appendChild(countEl);
    container.appendChild(statusEl);
  }
  return container;
}
function coversLine(candidate, line) {
  const end = Math.max(candidate.lineStart + 1, candidate.lineEnd);
  return line >= candidate.lineStart && line < end;
}
function parseDocument(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");
  const lineInfo = lines.map(() => ({ kind: "text" }));
  const headings = [];
  const trees = [];
  const nodesByLine = /* @__PURE__ */ new Map();
  let inFrontmatter = lines[0] === "---";
  let frontmatterClosed = !inFrontmatter;
  let inFence = false;
  let currentTree = null;
  let currentStack = [];
  const closeTree = () => {
    currentTree = null;
    currentStack = [];
  };
  const ensureTree = (line, indent) => {
    if (currentTree) {
      return currentTree;
    }
    const tree = {
      startLine: line,
      anchorLine: line - 1,
      rootIndent: indent,
      roots: [],
      counts: {}
    };
    trees.push(tree);
    currentTree = tree;
    currentStack = [];
    return tree;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmedLeft = raw.replace(/^\s+/, "");
    if (inFrontmatter) {
      lineInfo[index] = { kind: "frontmatter" };
      if (index > 0 && raw === "---") {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      closeTree();
      continue;
    }
    if (inFence) {
      lineInfo[index] = { kind: "code" };
      if (FENCE_RE.test(raw)) {
        inFence = false;
      }
      closeTree();
      continue;
    }
    if (FENCE_RE.test(raw)) {
      lineInfo[index] = { kind: "codeFence" };
      inFence = true;
      closeTree();
      continue;
    }
    if (trimmedLeft.startsWith(">")) {
      lineInfo[index] = { kind: "blockquote" };
      closeTree();
      continue;
    }
    const headingMatch = raw.match(HEADING_RE);
    if (headingMatch) {
      const heading = {
        line: index,
        level: headingMatch[1].length
      };
      headings.push(heading);
      lineInfo[index] = {
        kind: "heading",
        level: heading.level
      };
      closeTree();
      continue;
    }
    const listMatch = raw.match(LIST_ITEM_RE);
    if (listMatch) {
      const indent2 = countIndent(listMatch[1]);
      const tree = ensureTree(index, indent2);
      const marker = listMatch[2] ?? null;
      const node = {
        line: index,
        indent: indent2,
        marker,
        tree,
        parent: null,
        children: [],
        subtreeCounts: {},
        descendantCounts: {}
      };
      while (currentStack.length && indent2 <= currentStack[currentStack.length - 1].indent) {
        currentStack.pop();
      }
      if (currentStack.length) {
        node.parent = currentStack[currentStack.length - 1];
        node.parent.children.push(node);
      } else {
        tree.roots.push(node);
      }
      currentStack.push(node);
      nodesByLine.set(index, node);
      lineInfo[index] = {
        kind: "listItem",
        indent: indent2,
        marker
      };
      continue;
    }
    const indent = countIndent(raw.match(/^\s*/)?.[0] ?? "");
    const isBlank = BLANK_RE.test(raw);
    lineInfo[index] = { kind: isBlank ? "blank" : "text" };
    const activeTree = currentTree;
    if (!activeTree) {
      continue;
    }
    if (isBlank || indent > activeTree.rootIndent) {
      continue;
    }
    closeTree();
  }
  if (!frontmatterClosed) {
    return { lines, lineInfo, headings, trees, nodesByLine, entries: [] };
  }
  const entries = [];
  for (const tree of trees) {
    for (const root of tree.roots) {
      computeTreeCounts(root);
    }
    tree.counts = {};
    for (const root of tree.roots) {
      mergeCounts(tree.counts, root.subtreeCounts);
    }
    if (!hasCounts(tree.counts)) {
      continue;
    }
    const anchorLine = tree.anchorLine;
    if (anchorLine < 0) {
      entries.push({
        entryType: VIRTUAL_ANCHOR,
        anchorType: LOCAL_ANCHOR,
        beforeLine: tree.startLine,
        indent: tree.rootIndent,
        counts: tree.counts
      });
    } else {
      const anchorInfo = lineInfo[anchorLine];
      if (anchorInfo.kind === "heading") {
      } else if (anchorInfo.kind === "blank") {
        entries.push({
          entryType: VIRTUAL_ANCHOR,
          anchorType: LOCAL_ANCHOR,
          beforeLine: tree.startLine,
          indent: tree.rootIndent,
          counts: tree.counts
        });
      } else if (anchorInfo.kind === "text") {
        entries.push({
          entryType: INLINE_ANCHOR,
          anchorType: LOCAL_ANCHOR,
          line: anchorLine,
          counts: tree.counts
        });
      } else {
        entries.push({
          entryType: VIRTUAL_ANCHOR,
          anchorType: LOCAL_ANCHOR,
          beforeLine: tree.startLine,
          indent: tree.rootIndent,
          counts: tree.counts
        });
      }
    }
    if (ENABLE_GROUP_SUMMARIES) {
      for (const root of tree.roots) {
        collectGroupEntries(root, entries, lines);
      }
    }
  }
  if (ENABLE_SECTION_SUMMARIES) {
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      const counts = {};
      const nextBoundary = findSectionBoundary(headings, index, lines.length);
      for (let line = heading.line + 1; line < nextBoundary; line += 1) {
        const info = lineInfo[line];
        if (info.kind === "listItem" && typeof info.marker === "string") {
          addCount(counts, info.marker);
        }
      }
      if (!hasCounts(counts)) {
        continue;
      }
      entries.push({
        entryType: INLINE_ANCHOR,
        anchorType: SECTION_ANCHOR,
        line: heading.line,
        counts
      });
    }
  }
  entries.sort((left, right) => {
    const lineDiff = getEntrySortLine(left) - getEntrySortLine(right);
    if (lineDiff !== 0) {
      return lineDiff;
    }
    return getEntrySortRank(left) - getEntrySortRank(right);
  });
  return { lines, lineInfo, headings, trees, nodesByLine, entries };
}
function computeTreeCounts(node) {
  const subtree = {};
  if (node.marker !== null) {
    addCount(subtree, node.marker);
  }
  for (const child of node.children) {
    computeTreeCounts(child);
    mergeCounts(subtree, child.subtreeCounts);
  }
  node.subtreeCounts = subtree;
  node.descendantCounts = node.marker !== null ? subtractCounts(subtree, node.marker) : { ...subtree };
}
function collectGroupEntries(node, entries, lines) {
  if (hasCounts(node.descendantCounts) && !hasExternalMarkdownLink(lines[node.line] || "")) {
    entries.push({
      entryType: INLINE_ANCHOR,
      anchorType: GROUP_ANCHOR,
      line: node.line,
      counts: node.descendantCounts
    });
  }
  for (const child of node.children) {
    collectGroupEntries(child, entries, lines);
  }
}
function findSectionBoundary(headings, index, lineCount) {
  const current = headings[index];
  for (let next = index + 1; next < headings.length; next += 1) {
    if (headings[next].level <= current.level) {
      return headings[next].line;
    }
  }
  return lineCount;
}
function collectSectionCandidates(root, ctx) {
  const selector = "h1,h2,h3,h4,h5,h6,p,li,ul,ol";
  const candidates = [];
  const nodes = [];
  if (root.matches?.(selector)) {
    nodes.push(root);
  }
  root.querySelectorAll(selector).forEach((node) => nodes.push(node));
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const info = ctx.getSectionInfo?.(node);
    if (!info || typeof info.lineStart !== "number") {
      continue;
    }
    candidates.push({
      node,
      tag: node.tagName.toLowerCase(),
      lineStart: info.lineStart,
      lineEnd: typeof info.lineEnd === "number" ? info.lineEnd : info.lineStart + 1
    });
  }
  return candidates;
}
function appendReadingSummaries(root, ctx, model) {
  root.querySelectorAll(".checklist-summary").forEach((element) => element.remove());
  const candidates = collectSectionCandidates(root, ctx);
  for (const entry of model.entries) {
    if (entry.entryType === INLINE_ANCHOR) {
      const target = findInlineTarget(candidates, entry);
      if (!target) {
        continue;
      }
      const summaryEl = createSummaryElement(target.ownerDocument, entry.counts, { block: false });
      if (entry.anchorType === GROUP_ANCHOR) {
        insertIntoListItem(target, summaryEl);
      } else {
        target.appendChild(summaryEl);
      }
    } else {
      const target = findVirtualTarget(candidates, entry.beforeLine);
      if (!target || !target.parentNode) {
        continue;
      }
      const summaryEl = createSummaryElement(target.ownerDocument, entry.counts, { block: true });
      target.parentNode.insertBefore(summaryEl, target);
    }
  }
}
function findInlineTarget(candidates, entry) {
  const matching = candidates.filter((candidate) => coversLine(candidate, entry.line));
  if (matching.length === 0) {
    return null;
  }
  if (entry.anchorType === SECTION_ANCHOR) {
    return matching.find((candidate) => /^h[1-6]$/.test(candidate.tag))?.node || matching[0].node;
  }
  if (entry.anchorType === GROUP_ANCHOR) {
    return matching.find((candidate) => candidate.tag === "li")?.node || null;
  }
  return matching.find((candidate) => candidate.tag === "p")?.node || matching.find((candidate) => /^h[1-6]$/.test(candidate.tag))?.node || matching[0].node;
}
function findVirtualTarget(candidates, line) {
  const matching = candidates.filter((candidate) => coversLine(candidate, line));
  return matching.find((candidate) => candidate.tag === "ul" || candidate.tag === "ol")?.node || matching.find((candidate) => candidate.tag === "li")?.node || matching[0]?.node || null;
}
function insertIntoListItem(target, summaryEl) {
  const nestedList = Array.from(target.children).find((child) => child.tagName === "UL" || child.tagName === "OL");
  if (nestedList) {
    target.insertBefore(summaryEl, nestedList);
  } else {
    target.appendChild(summaryEl);
  }
}
function createLivePreviewExtension() {
  class SummaryWidget extends import_view.WidgetType {
    counts;
    options;
    key;
    constructor(counts, options) {
      super();
      this.counts = counts;
      this.options = options;
      this.key = `${options.block ? "block" : "inline"}:${serializeCounts(counts)}:${options.indent || 0}`;
    }
    eq(other) {
      return other instanceof SummaryWidget && other.key === this.key;
    }
    toDOM() {
      const element = createSummaryElement(document, this.counts, { block: this.options.block });
      if (this.options.block && this.options.indent) {
        element.style.paddingInlineStart = `${this.options.indent}ch`;
      }
      return element;
    }
    ignoreEvent() {
      return true;
    }
  }
  return import_view.ViewPlugin.fromClass(class {
    decorations;
    constructor(view) {
      this.decorations = this.buildDecorations(view);
    }
    update(update) {
      if (!update.state.field(import_obsidian.editorLivePreviewField, false)) {
        this.decorations = import_view.Decoration.none;
        return;
      }
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
      }
    }
    buildDecorations(view) {
      if (!view.state.field(import_obsidian.editorLivePreviewField, false)) {
        return import_view.Decoration.none;
      }
      const info = view.state.field(import_obsidian.editorInfoField, false);
      const file = info?.file;
      if (!file) {
        return import_view.Decoration.none;
      }
      const model = parseDocument(view.state.doc.toString());
      const builder = new import_state.RangeSetBuilder();
      for (const entry of model.entries) {
        if (entry.entryType === INLINE_ANCHOR) {
          const line = view.state.doc.line(entry.line + 1);
          if (!isPositionVisible(view, line.from)) {
            continue;
          }
          builder.add(
            line.to,
            line.to,
            import_view.Decoration.widget({
              side: 1,
              widget: new SummaryWidget(entry.counts, { block: false })
            })
          );
        } else {
          const line = view.state.doc.line(entry.beforeLine + 1);
          if (!isPositionVisible(view, line.from)) {
            continue;
          }
          builder.add(
            line.from,
            line.from,
            import_view.Decoration.widget({
              side: -1,
              block: true,
              widget: new SummaryWidget(entry.counts, { block: true, indent: entry.indent })
            })
          );
        }
      }
      return builder.finish();
    }
  }, {
    decorations: (instance) => instance.decorations
  });
}
function isPositionVisible(view, position) {
  return view.visibleRanges.some((range) => position >= range.from && position <= range.to);
}
var ChecklistSummaryPlugin = class extends import_obsidian.Plugin {
  async onload() {
    const livePreviewExtension = createLivePreviewExtension();
    if (livePreviewExtension) {
      this.registerEditorExtension(livePreviewExtension);
    }
    const processor = this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(file instanceof import_obsidian.TFile) || file.extension !== "md") {
        return;
      }
      const content = await this.app.vault.cachedRead(file);
      const model = parseDocument(content);
      if (!model.entries.length) {
        return;
      }
      appendReadingSummaries(el, ctx, model);
    });
    processor.sortOrder = 200;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  orderStatuses,
  parseDocument,
  serializeCounts
});

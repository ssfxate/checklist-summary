import {
  Plugin,
  TFile,
  editorInfoField,
  editorLivePreviewField,
  type MarkdownPostProcessorContext
} from "obsidian";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";

type Counts = Record<string, number>;
type AnchorType = typeof SECTION_ANCHOR | typeof GROUP_ANCHOR | typeof LOCAL_ANCHOR;

interface Heading {
  line: number;
  level: number;
}

interface LineInfo {
  kind: string;
  level?: number;
  indent?: number;
  marker?: string | null;
}

interface ListTree {
  startLine: number;
  anchorLine: number;
  rootIndent: number;
  roots: ListNode[];
  counts: Counts;
}

interface ListNode {
  line: number;
  indent: number;
  marker: string | null;
  tree: ListTree;
  parent: ListNode | null;
  children: ListNode[];
  subtreeCounts: Counts;
  descendantCounts: Counts;
}

interface InlineEntry {
  entryType: typeof INLINE_ANCHOR;
  anchorType: AnchorType;
  line: number;
  counts: Counts;
}

interface VirtualEntry {
  entryType: typeof VIRTUAL_ANCHOR;
  anchorType: typeof LOCAL_ANCHOR;
  beforeLine: number;
  indent: number;
  counts: Counts;
}

type SummaryEntry = InlineEntry | VirtualEntry;

interface DocumentModel {
  lines: string[];
  lineInfo: LineInfo[];
  headings: Heading[];
  trees: ListTree[];
  nodesByLine: Map<number, ListNode>;
  entries: SummaryEntry[];
}

interface RenderCandidate {
  node: HTMLElement;
  tag: string;
  lineStart: number;
  lineEnd: number;
}

interface SummaryOptions {
  block?: boolean;
}

interface WidgetOptions {
  block: boolean;
  indent?: number;
}

const LIST_ITEM_RE = /^(\s*)[-*+]\s+(?:\[([^\]])\]\s*)?(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;
const BLANK_RE = /^\s*$/;
const BASE_STATUS_ORDER = [" ", "/", "-", "?", ">", "x"];
const ENABLE_GROUP_SUMMARIES = true;
const ENABLE_SECTION_SUMMARIES = true;
const VIRTUAL_ANCHOR = "virtual";
const INLINE_ANCHOR = "inline";
const SECTION_ANCHOR = "section";
const GROUP_ANCHOR = "group";
const LOCAL_ANCHOR = "local";

function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

function countIndent(whitespace: string): number {
  let total = 0;
  for (const char of whitespace) {
    total += char === "\t" ? 4 : 1;
  }
  return total;
}

function addCount(counts: Counts, symbol: string, amount = 1): void {
  counts[symbol] = (counts[symbol] || 0) + amount;
}

function mergeCounts(target: Counts, source: Counts): Counts {
  for (const [symbol, count] of Object.entries(source)) {
    addCount(target, symbol, count);
  }
  return target;
}

function subtractCounts(source: Counts, symbol: string | null): Counts {
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

function hasCounts(counts: Counts): boolean {
  return Object.keys(counts).length > 0;
}

export function orderStatuses(counts: Counts): string[] {
  const extras = Object.keys(counts)
    .filter((symbol) => !BASE_STATUS_ORDER.includes(symbol))
    .sort((left, right) => left.localeCompare(right));

  return BASE_STATUS_ORDER.filter((symbol) => counts[symbol] > 0).concat(extras);
}

export function serializeCounts(counts: Counts): string {
  return orderStatuses(counts)
    .map((symbol) => `${JSON.stringify(symbol)}:${counts[symbol]}`)
    .join("|");
}

function hasInlineDataviewQuery(text: string): boolean {
  return /`(?:=|\$=)/.test(text);
}

function hasExternalMarkdownLink(text: string): boolean {
  return /!?\[[^\]]+\]\([^)]+\)/.test(text);
}

function getEntrySortLine(entry: SummaryEntry): number {
  return entry.entryType === VIRTUAL_ANCHOR ? entry.beforeLine : entry.line;
}

function getEntrySortRank(entry: SummaryEntry): number {
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

function createSummaryElement(doc: Document, counts: Counts, options: SummaryOptions = {}): HTMLElement {
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

function coversLine(candidate: RenderCandidate, line: number): boolean {
  const end = Math.max(candidate.lineStart + 1, candidate.lineEnd);
  return line >= candidate.lineStart && line < end;
}

export function parseDocument(text: string): DocumentModel {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");
  const lineInfo: LineInfo[] = lines.map(() => ({ kind: "text" }));
  const headings: Heading[] = [];
  const trees: ListTree[] = [];
  const nodesByLine = new Map<number, ListNode>();

  let inFrontmatter = lines[0] === "---";
  let frontmatterClosed = !inFrontmatter;
  let inFence = false;
  let currentTree: ListTree | null = null;
  let currentStack: ListNode[] = [];

  const closeTree = () => {
    currentTree = null;
    currentStack = [];
  };

  const ensureTree = (line: number, indent: number): ListTree => {
    if (currentTree) {
      return currentTree;
    }

    const tree: ListTree = {
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
      const indent = countIndent(listMatch[1]);
      const tree = ensureTree(index, indent);
      const marker = listMatch[2] ?? null;
      const node: ListNode = {
        line: index,
        indent,
        marker,
        tree,
        parent: null,
        children: [],
        subtreeCounts: {},
        descendantCounts: {}
      };

      while (currentStack.length && indent <= currentStack[currentStack.length - 1].indent) {
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
        indent,
        marker
      };
      continue;
    }

    const indent = countIndent(raw.match(/^\s*/)?.[0] ?? "");
    const isBlank = BLANK_RE.test(raw);
    lineInfo[index] = { kind: isBlank ? "blank" : "text" };

    const activeTree = currentTree as ListTree | null;
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

  const entries: SummaryEntry[] = [];

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
        // Local summary is suppressed when the same heading already acts as the section anchor.
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
      const counts: Counts = {};
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

function computeTreeCounts(node: ListNode): void {
  const subtree: Counts = {};
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

function collectGroupEntries(node: ListNode, entries: SummaryEntry[], lines: string[]): void {
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

function findSectionBoundary(headings: Heading[], index: number, lineCount: number): number {
  const current = headings[index];
  for (let next = index + 1; next < headings.length; next += 1) {
    if (headings[next].level <= current.level) {
      return headings[next].line;
    }
  }
  return lineCount;
}

function collectSectionCandidates(root: HTMLElement, ctx: MarkdownPostProcessorContext): RenderCandidate[] {
  const selector = "h1,h2,h3,h4,h5,h6,p,li,ul,ol";
  const candidates: RenderCandidate[] = [];
  const nodes: Element[] = [];

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

function appendReadingSummaries(
  root: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  model: DocumentModel
): void {
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

function findInlineTarget(candidates: RenderCandidate[], entry: InlineEntry): HTMLElement | null {
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

  return matching.find((candidate) => candidate.tag === "p")?.node
    || matching.find((candidate) => /^h[1-6]$/.test(candidate.tag))?.node
    || matching[0].node;
}

function findVirtualTarget(candidates: RenderCandidate[], line: number): HTMLElement | null {
  const matching = candidates.filter((candidate) => coversLine(candidate, line));
  return matching.find((candidate) => candidate.tag === "ul" || candidate.tag === "ol")?.node
    || matching.find((candidate) => candidate.tag === "li")?.node
    || matching[0]?.node
    || null;
}

function insertIntoListItem(target: HTMLElement, summaryEl: HTMLElement): void {
  const nestedList = Array.from(target.children).find((child) => child.tagName === "UL" || child.tagName === "OL");
  if (nestedList) {
    target.insertBefore(summaryEl, nestedList);
  } else {
    target.appendChild(summaryEl);
  }
}

function createLivePreviewExtension(): Extension {
  class SummaryWidget extends WidgetType {
    readonly counts: Counts;
    readonly options: WidgetOptions;
    readonly key: string;

    constructor(counts: Counts, options: WidgetOptions) {
      super();
      this.counts = counts;
      this.options = options;
      this.key = `${options.block ? "block" : "inline"}:${serializeCounts(counts)}:${options.indent || 0}`;
    }

    eq(other: WidgetType): boolean {
      return other instanceof SummaryWidget && other.key === this.key;
    }

    toDOM(): HTMLElement {
      const element = createSummaryElement(document, this.counts, { block: this.options.block });
      if (this.options.block && this.options.indent) {
        element.style.paddingInlineStart = `${this.options.indent}ch`;
      }
      return element;
    }

    ignoreEvent(): boolean {
      return true;
    }
  }

  const buildDecorations = (state: EditorState): DecorationSet => {
    if (!state.field(editorLivePreviewField, false)) {
      return Decoration.none;
    }

    const info = state.field(editorInfoField, false);
    if (!info?.file) {
      return Decoration.none;
    }

    const model = parseDocument(state.doc.toString());
    const builder = new RangeSetBuilder<Decoration>();

    for (const entry of model.entries) {
      if (entry.entryType === INLINE_ANCHOR) {
        const line = state.doc.line(entry.line + 1);
        builder.add(
          line.to,
          line.to,
          Decoration.widget({
            side: 1,
            widget: new SummaryWidget(entry.counts, { block: false })
          })
        );
      } else {
        const line = state.doc.line(entry.beforeLine + 1);
        builder.add(
          line.from,
          line.from,
          Decoration.widget({
            side: -1,
            block: true,
            widget: new SummaryWidget(entry.counts, { block: true, indent: entry.indent })
          })
        );
      }
    }

    return builder.finish();
  };

  return StateField.define<DecorationSet>({
    create: buildDecorations,
    update(decorations, transaction) {
      const livePreviewChanged = transaction.startState.field(editorLivePreviewField, false)
        !== transaction.state.field(editorLivePreviewField, false);
      const fileChanged = transaction.startState.field(editorInfoField, false)?.file
        !== transaction.state.field(editorInfoField, false)?.file;

      return transaction.docChanged || livePreviewChanged || fileChanged
        ? buildDecorations(transaction.state)
        : decorations;
    },
    provide: (field) => EditorView.decorations.from(field)
  });
}

export default class ChecklistSummaryPlugin extends Plugin {
  async onload(): Promise<void> {
    const livePreviewExtension = createLivePreviewExtension();
    if (livePreviewExtension) {
      this.registerEditorExtension(livePreviewExtension);
    }

    const processor = this.registerMarkdownPostProcessor(async (el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(file instanceof TFile) || file.extension !== "md") {
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
}

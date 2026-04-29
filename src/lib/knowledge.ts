import fs from "node:fs/promises";
import path from "node:path";

export type FigureKind =
  | "diagram"
  | "schematic"
  | "photo"
  | "table"
  | "chart"
  | "decision-matrix"
  | "control-panel";

export type Figure = {
  id: string;
  kind: FigureKind;
  label: string;
  summary: string;
};

export type IndexedPage = {
  doc: string;
  page: number;
  image: string;
  thumb: string;
  text: string;
  section: string | null;
  caption: string;
  topics: string[];
  figures: Figure[];
};

export type KnowledgeIndex = {
  generatedAt: string;
  documents: Array<{ id: string; title: string; pageCount: number }>;
  pages: IndexedPage[];
};

let cached: KnowledgeIndex | null = null;

export async function loadKnowledge(): Promise<KnowledgeIndex> {
  if (cached) return cached;
  const p = path.join(process.cwd(), "knowledge", "index.json");
  const raw = await fs.readFile(p, "utf8");
  cached = JSON.parse(raw) as KnowledgeIndex;
  return cached;
}

export function getPage(idx: KnowledgeIndex, doc: string, page: number) {
  return idx.pages.find((p) => p.doc === doc && p.page === page) ?? null;
}

export function getFigure(idx: KnowledgeIndex, figureId: string) {
  for (const p of idx.pages) {
    const f = p.figures.find((f) => f.id === figureId);
    if (f) return { figure: f, page: p };
  }
  return null;
}

const STOPWORDS = new Set(
  "a,an,the,is,are,was,were,be,been,to,of,in,on,for,with,as,at,by,from,that,this,these,those,it,its,you,your,we,our,can,how,what,which,when,where,why,do,does,did,not,no,will,would,should,if,else,or,and,but,about,into,out,off,over,under,up,down,me,my,i".split(
    ",",
  ),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export type SearchHit = {
  doc: string;
  page: number;
  score: number;
  caption: string;
  section: string | null;
  topics: string[];
  snippet: string;
  figures: Figure[];
  thumb: string;
};

/**
 * Lightweight in-memory ranker. Scores combine:
 *  - exact-phrase hits (heavy)
 *  - per-token hits in caption (medium), topics (medium), section (medium), text (light)
 *  - figure-label hits (medium-heavy — visual content matters here)
 * Returns top N pages, deduped per (doc, page).
 */
export function searchPages(
  idx: KnowledgeIndex,
  query: string,
  opts: { limit?: number; doc?: string } = {},
): SearchHit[] {
  const limit = opts.limit ?? 8;
  const phrase = query.toLowerCase().trim();
  const tokens = tokenize(query);

  const scored: SearchHit[] = [];
  for (const p of idx.pages) {
    if (opts.doc && p.doc !== opts.doc) continue;
    let score = 0;
    const caption = p.caption.toLowerCase();
    const text = p.text.toLowerCase();
    const section = (p.section || "").toLowerCase();
    const topics = p.topics.join(" ").toLowerCase();
    const figLabels = p.figures.map((f) => `${f.label} ${f.summary}`).join(" ").toLowerCase();

    if (phrase.length > 3) {
      if (caption.includes(phrase)) score += 8;
      if (section.includes(phrase)) score += 5;
      if (topics.includes(phrase)) score += 5;
      if (figLabels.includes(phrase)) score += 6;
      if (text.includes(phrase)) score += 3;
    }
    for (const tok of tokens) {
      if (caption.includes(tok)) score += 2.5;
      if (topics.includes(tok)) score += 2;
      if (section.includes(tok)) score += 2;
      if (figLabels.includes(tok)) score += 2.5;
      // Word-boundary match in body text gets light credit
      const re = new RegExp(`(^|\\W)${tok.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(\\W|$)`, "i");
      if (re.test(text)) score += 1;
    }
    if (score > 0) {
      const snippet = makeSnippet(p.text, tokens, phrase);
      scored.push({
        doc: p.doc,
        page: p.page,
        score,
        caption: p.caption,
        section: p.section,
        topics: p.topics,
        snippet,
        figures: p.figures,
        thumb: p.thumb,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function makeSnippet(text: string, tokens: string[], phrase: string): string {
  const lower = text.toLowerCase();
  let center = -1;
  if (phrase.length > 3) {
    const i = lower.indexOf(phrase);
    if (i !== -1) center = i;
  }
  if (center === -1) {
    for (const t of tokens) {
      const i = lower.indexOf(t);
      if (i !== -1) {
        center = i;
        break;
      }
    }
  }
  if (center === -1) return text.slice(0, 240).trim();
  const start = Math.max(0, center - 120);
  const end = Math.min(text.length, center + 220);
  const slice = (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
  return slice.replace(/\s+/g, " ");
}

export function listFigures(
  idx: KnowledgeIndex,
  opts: { kind?: FigureKind; query?: string; limit?: number } = {},
) {
  const limit = opts.limit ?? 24;
  const q = (opts.query || "").toLowerCase();
  const out: Array<Figure & { doc: string; page: number; thumb: string }> = [];
  for (const p of idx.pages) {
    for (const f of p.figures) {
      if (opts.kind && f.kind !== opts.kind) continue;
      if (q && !`${f.label} ${f.summary} ${p.caption}`.toLowerCase().includes(q)) continue;
      out.push({ ...f, doc: p.doc, page: p.page, thumb: p.thumb });
    }
  }
  return out.slice(0, limit);
}

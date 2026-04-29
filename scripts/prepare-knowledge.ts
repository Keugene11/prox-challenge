/**
 * One-shot knowledge extraction pipeline.
 *
 * For each PDF in files/:
 *   1. Render every page to PNG (high-res, for the agent's "show me" tool)
 *      and to a small JPG thumbnail (for the UI source list).
 *   2. Extract text content per page via pdfjs.
 *   3. Ask Claude vision to caption each page and label its figures
 *      (diagram, schematic, photo, table, chart) — written once and committed
 *      so cloners don't pay this cost.
 *
 * Output:
 *   knowledge/pages/{doc}-{NNN}.png       full-res page render
 *   knowledge/pages/{doc}-{NNN}-thumb.jpg small thumbnail for UI
 *   knowledge/index.json                  the structured index the agent uses
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
// pdfjs-dist legacy build is the supported Node entry point.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore  no types ship for the legacy entry
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const ROOT = path.resolve(process.cwd());
const FILES_DIR = path.join(ROOT, "files");
const KNOWLEDGE_DIR = path.join(ROOT, "knowledge");
const PAGES_DIR = path.join(KNOWLEDGE_DIR, "pages");
const INDEX_PATH = path.join(KNOWLEDGE_DIR, "index.json");

const RENDER_SCALE = 2.0;
const THUMB_WIDTH = 360;

const DOCUMENTS: Array<{ id: string; file: string; title: string }> = [
  { id: "owner-manual", file: "owner-manual.pdf", title: "Vulcan OmniPro 220 Owner's Manual" },
  { id: "quick-start", file: "quick-start-guide.pdf", title: "Quick Start Guide" },
  { id: "selection-chart", file: "selection-chart.pdf", title: "Welding Process Selection Chart" },
];

type FigureKind = "diagram" | "schematic" | "photo" | "table" | "chart" | "decision-matrix" | "control-panel";

type Figure = {
  id: string;
  kind: FigureKind;
  label: string;
  summary: string;
};

type IndexedPage = {
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

type IndexFile = {
  generatedAt: string;
  documents: Array<{ id: string; title: string; pageCount: number }>;
  pages: IndexedPage[];
};

async function ensureDirs() {
  await fs.mkdir(PAGES_DIR, { recursive: true });
}

async function renderPdf(docId: string, pdfPath: string) {
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const loadingTask = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pageCount: number = pdf.numPages;
  console.log(`  ${docId}: ${pageCount} pages`);

  const pages: Array<{ page: number; text: string; pngPath: string; thumbPath: string }> = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    // Fill background white — pdfjs can leave transparent backgrounds otherwise.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      // pdfjs typings expect a browser CanvasRenderingContext2D; @napi-rs/canvas is API-compatible.
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    } as unknown as Parameters<typeof page.render>[0]).promise;

    const png = canvas.toBuffer("image/png");
    const jpgName = `${docId}-${String(p).padStart(3, "0")}.jpg`;
    const thumbName = `${docId}-${String(p).padStart(3, "0")}-thumb.jpg`;
    const jpgPath = path.join(PAGES_DIR, jpgName);
    const thumbPath = path.join(PAGES_DIR, thumbName);

    // Write the full-resolution page as JPEG (mozjpeg q=88) — visually
    // identical to the PNG for printed/scanned pages, ~3x smaller, fits
    // serverless function limits.
    await sharp(png).jpeg({ quality: 88, mozjpeg: true }).toFile(jpgPath);
    await sharp(png).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(thumbPath);

    const textContent = await page.getTextContent();
    const text = (textContent.items as Array<{ str?: string; hasEOL?: boolean }>)
      .map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : ""))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    process.stdout.write(`    rendered ${jpgName}\r`);

    pages.push({
      page: p,
      text,
      pngPath: path.relative(ROOT, jpgPath).replace(/\\/g, "/"),
      thumbPath: path.relative(ROOT, thumbPath).replace(/\\/g, "/"),
    });
  }
  process.stdout.write("\n");
  return { pageCount, pages };
}

const PAGE_ANALYSIS_PROMPT = `You are indexing one page of a welder manual for a search system used by a multimodal AI assistant. Look at the page image AND the OCR/extracted text. Output ONE JSON object with this shape:

{
  "section": string | null,            // The section/chapter title this page falls under, if visible. Null if unclear.
  "caption": string,                    // 1-2 sentences. What is on this page in plain English. Be specific about content (e.g. "Duty cycle table for MIG at 240V" not "a table").
  "topics": string[],                   // 2-6 short tags (lowercase, hyphen-separated) — e.g. "duty-cycle", "mig", "polarity", "wiring-schematic", "weld-diagnosis", "porosity"
  "figures": [                          // Visual elements present on the page beyond running body text. Empty array is fine.
    {
      "id": string,                     // Short stable id, e.g. "duty-cycle-mig-240v" or "wire-feed-tensioner"
      "kind": "diagram" | "schematic" | "photo" | "table" | "chart" | "decision-matrix" | "control-panel",
      "label": string,                  // Human label, e.g. "Wiring schematic" or "Weld diagnosis: porosity"
      "summary": string                 // 1-2 sentences describing what the figure shows / what data it contains.
    }
  ]
}

Rules:
- Only emit figures for visual content that adds information beyond the body text (diagrams, schematics, labeled photos, tables of values, decision matrices, control-panel renderings, charts). Do NOT emit a figure for pure text.
- A multi-row table of numbers (e.g. duty cycles by amperage) IS a figure of kind "table".
- The wiring schematic, the welding-process selection chart, and the weld-diagnosis photo grid are critical — make sure to capture them when present.
- Output ONLY the JSON, no prose, no markdown fence.`;

async function analyzePage(client: Anthropic, image: Buffer, ocrText: string, doc: string, pageNum: number) {
  const resp = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: PAGE_ANALYSIS_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: image.toString("base64") } },
          { type: "text", text: `Document: ${doc}\nPage: ${pageNum}\n\nExtracted text from this page:\n---\n${ocrText.slice(0, 6000)}\n---` },
        ],
      },
    ],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn(`  [warn] page ${doc}:${pageNum} — no JSON in response, using fallback`);
    return { section: null, caption: ocrText.slice(0, 140), topics: [], figures: [] as Figure[] };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      section: parsed.section ?? null,
      caption: String(parsed.caption ?? "").trim(),
      topics: Array.isArray(parsed.topics) ? parsed.topics.map(String) : [],
      figures: Array.isArray(parsed.figures)
        ? (parsed.figures as Figure[]).map((f, i) => ({
            id: String(f.id || `${doc}-${pageNum}-fig${i + 1}`),
            kind: (f.kind as FigureKind) || "diagram",
            label: String(f.label || "").trim(),
            summary: String(f.summary || "").trim(),
          }))
        : [],
    };
  } catch (err) {
    console.warn(`  [warn] page ${doc}:${pageNum} — JSON parse failed:`, (err as Error).message);
    return { section: null, caption: ocrText.slice(0, 140), topics: [], figures: [] as Figure[] };
  }
}

async function loadExistingIndex(): Promise<IndexFile | null> {
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    return JSON.parse(raw) as IndexFile;
  } catch {
    return null;
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY missing in environment. Add it to .env and re-run.");
    process.exit(1);
  }

  await ensureDirs();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const existing = await loadExistingIndex();
  const existingByKey = new Map<string, IndexedPage>();
  if (existing) {
    for (const p of existing.pages) existingByKey.set(`${p.doc}:${p.page}`, p);
  }

  const allPages: IndexedPage[] = [];
  const docMeta: IndexFile["documents"] = [];

  const skipVision = process.argv.includes("--skip-vision");

  for (const doc of DOCUMENTS) {
    const pdfPath = path.join(FILES_DIR, doc.file);
    console.log(`\n==> ${doc.title}`);
    const { pageCount, pages } = await renderPdf(doc.id, pdfPath);
    docMeta.push({ id: doc.id, title: doc.title, pageCount });

    for (const p of pages) {
      const key = `${doc.id}:${p.page}`;
      const cached = existingByKey.get(key);
      let analysis: { section: string | null; caption: string; topics: string[]; figures: Figure[] };
      if (cached && !process.argv.includes("--force")) {
        analysis = { section: cached.section, caption: cached.caption, topics: cached.topics, figures: cached.figures };
        process.stdout.write(`    cached  ${doc.id} p${p.page}\r`);
      } else if (skipVision) {
        analysis = { section: null, caption: p.text.slice(0, 140), topics: [], figures: [] };
      } else {
        const buf = await fs.readFile(path.join(ROOT, p.pngPath));
        // Use the thumbnail-sized version for vision to save tokens — still legible.
        const small = await sharp(buf).resize({ width: 1200, withoutEnlargement: true }).png().toBuffer();
        process.stdout.write(`    analyzing ${doc.id} p${p.page}...\r`);
        try {
          analysis = await analyzePage(client, small, p.text, doc.id, p.page);
        } catch (err) {
          console.warn(`\n  [error] vision call failed for ${doc.id} p${p.page}:`, (err as Error).message);
          analysis = { section: null, caption: p.text.slice(0, 140), topics: [], figures: [] };
        }
      }

      allPages.push({
        doc: doc.id,
        page: p.page,
        image: p.pngPath,
        thumb: p.thumbPath,
        text: p.text,
        section: analysis.section,
        caption: analysis.caption,
        topics: analysis.topics,
        figures: analysis.figures.map((f) => ({ ...f, id: `${doc.id}-p${p.page}-${f.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-") })),
      });

      // Persist incrementally so a crash doesn't lose work.
      const partial: IndexFile = {
        generatedAt: new Date().toISOString(),
        documents: docMeta,
        pages: allPages,
      };
      await fs.writeFile(INDEX_PATH, JSON.stringify(partial, null, 2));
    }
  }

  console.log(`\nWrote ${allPages.length} pages → ${path.relative(ROOT, INDEX_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

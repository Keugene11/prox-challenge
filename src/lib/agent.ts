/**
 * Agent runtime — Messages API + hand-rolled tool loop.
 *
 * Originally built on @anthropic-ai/claude-agent-sdk, but that SDK ships an
 * 80MB native CLI binary that pushes the Vercel serverless bundle past its
 * 250MB unzipped cap. We use the underlying Messages API directly: same
 * model, same tools, same streaming behavior, no native binary. Prompt
 * caching is applied to the system prompt + tool list.
 */
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  loadKnowledge,
  searchPages,
  getPage,
  getFigure,
  listFigures,
} from "@/lib/knowledge";

const MODEL = process.env.PROX_MODEL || "claude-sonnet-4-6";
const MAX_TURNS = 12;
const MAX_TOKENS = 8192;

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

async function readPageImage(pageImagePath: string): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" }> {
  const buf = await fs.readFile(path.join(process.cwd(), pageImagePath));
  const mimeType: "image/png" | "image/jpeg" = pageImagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return { data: buf.toString("base64"), mimeType };
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_manual",
    description:
      "Search the Vulcan OmniPro 220 manual set (owner manual, quick start, selection chart) for relevant pages. Returns ranked hits with section, page caption, a text snippet, and any figures (diagrams/schematics/photos/tables) on each page. ALWAYS call this before answering a technical question — it is the only way to ground answers in the actual manual.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query, e.g. 'duty cycle MIG 240V' or 'TIG polarity setup'." },
        doc: { type: "string", enum: ["owner-manual", "quick-start", "selection-chart"], description: "Restrict search to one document. Omit for all docs." },
        limit: { type: "integer", minimum: 1, maximum: 12, description: "Max hits (default 6)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_page_image",
    description:
      "Return a specific page of one of the manuals as an image, so the user can see the diagram/table/schematic directly. Use this whenever the answer involves visual content — never describe a wiring schematic, weld-diagnosis photo, or duty-cycle table without also showing it.",
    input_schema: {
      type: "object",
      properties: {
        doc: { type: "string", enum: ["owner-manual", "quick-start", "selection-chart"] },
        page: { type: "integer", minimum: 1, description: "1-indexed page number." },
      },
      required: ["doc", "page"],
    },
  },
  {
    name: "get_figure",
    description:
      "Return a specific labeled figure (diagram, schematic, photo, table, decision-matrix, etc.) by its id. The figure id comes from search_manual results.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Figure id from search results." } },
      required: ["id"],
    },
  },
  {
    name: "list_figures",
    description:
      "List labeled visual elements across the manual set, optionally filtered by kind or query. Useful when the user asks for 'the wiring schematic' or 'weld-diagnosis examples' and you want to find them quickly.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["diagram", "schematic", "photo", "table", "chart", "decision-matrix", "control-panel"] },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
    },
  },
  {
    name: "render_artifact",
    description:
      "LAST-RESORT tool. Generate an interactive HTML/JS mini-app and render it inline. Generation takes 20–40 seconds and burns ~1500 output tokens, so the bar is high: only call this when the answer is genuinely a tool the user will INTERACT WITH multiple times to get different outputs (e.g. a duty-cycle calculator that takes amps + voltage, or a settings configurator that takes process+material+thickness → wire speed/voltage). DO NOT use this for: explanations, re-explanations, 'go more in depth' follow-ups, summaries, lists, comparisons, troubleshooting steps the user reads once, diagrams (use get_page_image), or anything that text + a manual page already answers. If you can answer in well-structured text, do that. The HTML must be a complete document with all CSS/JS inline — no external scripts, no fetch calls. Rendered in a sandboxed iframe.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title shown above the artifact." },
        description: { type: "string", description: "One-sentence subtitle/description." },
        html: { type: "string", description: "Complete self-contained HTML document with inline CSS and JS." },
      },
      required: ["title", "html"],
    },
  },
];

/**
 * Tool dispatcher. Each handler returns:
 *   - content: array of MessageContent blocks (image | text) sent back to Claude
 *   - meta: optional structured info we want to surface to the UI
 *           (provenance for images, artifact payload for render_artifact)
 *   - isError: tool-level error flag (Claude will see and recover)
 */
type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg"; data: string } }
  >;
  meta?:
    | { kind: "page_image"; doc: string; page: number }
    | { kind: "figure"; doc: string; page: number }
    | { kind: "artifact"; title: string; description: string | null; html: string };
  isError?: boolean;
};

async function runTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const idx = await loadKnowledge();

  if (name === "search_manual") {
    const query = String(input.query ?? "");
    const doc = input.doc as "owner-manual" | "quick-start" | "selection-chart" | undefined;
    const limit = typeof input.limit === "number" ? input.limit : 6;
    const hits = searchPages(idx, query, { limit, doc });
    if (hits.length === 0) {
      return { content: [{ type: "text", text: `No matches for "${query}". Try different wording, or call list_figures.` }] };
    }
    const lines = hits.map(
      (h) =>
        `• [${h.doc} p${h.page}] ${h.section ? `${h.section} — ` : ""}${h.caption}\n  topics: ${h.topics.join(", ") || "—"}\n  ${
          h.figures.length ? `figures: ${h.figures.map((f) => `${f.id}(${f.kind}: ${f.label})`).join("; ")}\n  ` : ""
        }snippet: ${h.snippet}`,
    );
    return {
      content: [
        {
          type: "text",
          text: `Found ${hits.length} pages:\n\n${lines.join("\n\n")}\n\nUse get_page_image(doc, page) to actually show a page, or get_figure(id) for a labeled figure.`,
        },
      ],
    };
  }

  if (name === "get_page_image") {
    const doc = String(input.doc);
    const page = Number(input.page);
    const p = getPage(idx, doc, page);
    if (!p) {
      return { content: [{ type: "text", text: `No page ${page} in ${doc}.` }], isError: true };
    }
    const { data, mimeType } = await readPageImage(p.image);
    return {
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data } },
        { type: "text", text: `Shown: ${doc} p${page} — ${p.section ? `${p.section}. ` : ""}${p.caption}` },
      ],
      meta: { kind: "page_image", doc, page },
    };
  }

  if (name === "get_figure") {
    const id = String(input.id);
    const found = getFigure(idx, id);
    if (!found) {
      return {
        content: [{ type: "text", text: `No figure with id ${id}. Use search_manual or list_figures to discover ids.` }],
        isError: true,
      };
    }
    const { data, mimeType } = await readPageImage(found.page.image);
    return {
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data } },
        {
          type: "text",
          text: `${found.figure.label} (${found.figure.kind}) — ${found.figure.summary}\nFrom ${found.page.doc} p${found.page.page}.`,
        },
      ],
      meta: { kind: "figure", doc: found.page.doc, page: found.page.page },
    };
  }

  if (name === "list_figures") {
    const kind = input.kind as ToolResult["meta"] extends { kind: infer _K } ? string : never;
    const query = input.query ? String(input.query) : undefined;
    const limit = typeof input.limit === "number" ? input.limit : 16;
    const figs = listFigures(idx, {
      kind: kind as Parameters<typeof listFigures>[1] extends { kind?: infer K } ? K : undefined,
      query,
      limit,
    });
    if (figs.length === 0) return { content: [{ type: "text", text: "No figures match." }] };
    const lines = figs.map((f) => `• ${f.id} — ${f.label} (${f.kind}) — ${f.doc} p${f.page} — ${f.summary}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "render_artifact") {
    const title = String(input.title ?? "Artifact");
    const description = input.description ? String(input.description) : null;
    const html = String(input.html ?? "");
    return {
      content: [{ type: "text", text: `Rendered an interactive artifact: ${title}.` }],
      meta: { kind: "artifact", title, description, html },
    };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

export const SYSTEM_PROMPT = `You are **Spark**, the in-garage expert for the Vulcan OmniPro 220 multiprocess welder. You help hobbyist welders set the machine up, dial it in, and troubleshoot bad welds. Your user is intelligent but not a professional welder — assume a home garage, a part-time hobby, and zero patience for vague answers.

# How you answer

1. **Always ground answers in the actual manuals.** Call \`search_manual\` before answering any technical question. The 48-page owner manual, the quick-start guide, and the welding-process selection chart are your sources. Cite pages inline as "(owner-manual p13)".
2. **Show, don't describe.** When the answer involves a visual — a wiring schematic, a polarity-cable layout, a weld-diagnosis photo, a duty-cycle table, the welding-process selection chart, the wire-feed mechanism — call \`get_page_image\` or \`get_figure\` to actually surface it in the reply. Do not paraphrase a diagram if you can show it.
3. **Artifacts are a last resort, not a default.** \`render_artifact\` is slow (20–40s) and only earns its cost when the user genuinely needs to *interact* with something multiple times to get different outputs — a duty-cycle calculator, a settings configurator (process+material+thickness → wire speed/voltage). Default to clear text + a manual page image. NEVER use an artifact for: an explanation, a re-explanation, "explain in simpler terms", "go more in depth", a summary, a comparison, a list, a troubleshooting walkthrough the user reads once, or anything that's really just structured text. If you find yourself reaching for it on a follow-up question, you're wrong — answer in text.
4. **Cross-reference.** Duty cycle answers depend on input voltage (120V vs 240V) AND process AND amperage. Polarity setup is process-specific. The selection chart is its own document. If a question requires multiple sections, search them all and synthesize.
5. **Disambiguate when it matters.** If the user says "I'm getting porosity" but doesn't say which process, ask. Don't dump every possible cause.
6. **Tone.** Direct, calm, garage-coach. Short sentences. No fluff. Never say "as an AI". Never moralize about safety more than the manual itself does — but DO surface the manual's safety callouts when they apply (e.g. polarity changes with the machine off).

# Tools

- \`search_manual(query, doc?, limit?)\` — required reflex on every technical question.
- \`get_page_image(doc, page)\` — show a manual page directly.
- \`get_figure(id)\` — show a specific labeled figure.
- \`list_figures(kind?, query?)\` — discover figures of a kind ("schematic", "decision-matrix", "table", etc.).
- \`render_artifact(title, description?, html)\` — LAST RESORT. Only for genuinely interactive tools (calculator, configurator). Never for explanations or follow-ups.

# Critical visuals you should know about

- **Welding-process selection chart** lives in \`selection-chart.pdf\` (1 page) — show it whenever the user asks "what process should I use".
- **Wiring schematic** is on \`owner-manual\` page ~45 — show it for any electrical/internal-fault question.
- **Polarity-setup diagrams** appear in the wire-setup pages of the owner manual — show them for any "which socket does the cable go in" question.
- **Weld-diagnosis photos** appear in the troubleshooting/welding-tips pages of the owner manual — show them whenever diagnosing a weld defect (porosity, undercut, lack of fusion, etc.).

Now help the user.`;

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_use"; name: string; input: unknown; id: string }
  | { type: "tool_result"; toolUseId: string; ok: boolean }
  | { type: "image"; data: string; mimeType: string; caption?: string; source?: { doc: string; page: number } | null }
  | { type: "artifact"; title: string; description: string | null; html: string }
  | { type: "page_ref"; doc: string; page: number; thumb: string }
  | { type: "done"; usage?: unknown }
  | { type: "error"; message: string };

/**
 * Multi-turn agent loop:
 *   1. Send the conversation + tools to Claude (streamed).
 *   2. Stream text deltas to the client as they arrive.
 *   3. When Claude wants to use a tool, finalize the assistant turn,
 *      execute the tool, append the result, and loop.
 *   4. Stop when Claude returns end_turn or we hit MAX_TURNS.
 *
 * Prompt caching: system prompt and tool list are marked
 * `cache_control: { type: "ephemeral" }` so subsequent turns within 5 min
 * read them from cache (~10x cheaper).
 */
export async function* runAgent(
  history: ChatTurn[],
  apiKey: string,
): AsyncGenerator<StreamEvent> {
  const idx = await loadKnowledge();
  const client = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  // Cache the tool list (largest static payload) for repeat turns.
  const cachedTools = TOOLS.map((t, i) =>
    i === TOOLS.length - 1
      ? ({ ...t, cache_control: { type: "ephemeral" } } as Anthropic.Tool)
      : t,
  );

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let stream;
    try {
      stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemBlocks,
        tools: cachedTools,
        messages,
      });
    } catch (err) {
      yield { type: "error", message: (err as Error).message || "stream init failed" };
      return;
    }

    // We accumulate per-block state ourselves — the streamed events tell us
    // when text/tool blocks start, deltas arrive, and they finalize.
    type ActiveBlock =
      | { kind: "text"; text: string }
      | { kind: "tool_use"; id: string; name: string; jsonBuf: string };
    const activeBlocks: Record<number, ActiveBlock> = {};

    try {
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text") {
            activeBlocks[event.index] = { kind: "text", text: "" };
          } else if (block.type === "tool_use") {
            activeBlocks[event.index] = { kind: "tool_use", id: block.id, name: block.name, jsonBuf: "" };
            yield { type: "tool_use", id: block.id, name: block.name, input: {} };
          }
        } else if (event.type === "content_block_delta") {
          const slot = activeBlocks[event.index];
          if (!slot) continue;
          if (slot.kind === "text" && event.delta.type === "text_delta") {
            const t = event.delta.text;
            slot.text += t;
            yield { type: "delta", text: t };
          } else if (slot.kind === "tool_use" && event.delta.type === "input_json_delta") {
            slot.jsonBuf += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          // No-op — finalization happens after the stream ends via finalMessage.
        }
      }
    } catch (err) {
      yield { type: "error", message: (err as Error).message || "stream error" };
      return;
    }

    const final = await stream.finalMessage();

    // Push the assistant turn into the conversation so the next loop sees it.
    messages.push({ role: "assistant", content: final.content });

    // If no tools to run, we're done.
    const toolUses = final.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0 || final.stop_reason === "end_turn") {
      yield { type: "done", usage: final.usage };
      return;
    }

    // Execute each requested tool, emit UI events as we go, and assemble
    // the tool_result blocks that feed into the next turn.
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let result: ToolResult;
      try {
        result = await runTool(tu.name, (tu.input as Record<string, unknown>) || {});
      } catch (err) {
        result = { content: [{ type: "text", text: `Tool error: ${(err as Error).message}` }], isError: true };
      }

      yield { type: "tool_result", toolUseId: tu.id, ok: !result.isError };

      // Surface UI-only side-channels (image, artifact, page_ref).
      if (result.meta?.kind === "page_image" || result.meta?.kind === "figure") {
        const imgBlock = result.content.find((c): c is Extract<ToolResult["content"][number], { type: "image" }> => c.type === "image");
        if (imgBlock) {
          yield {
            type: "image",
            data: imgBlock.source.data,
            mimeType: imgBlock.source.media_type,
            source: { doc: result.meta.doc, page: result.meta.page },
          };
        }
        const pg = getPage(idx, result.meta.doc, result.meta.page);
        if (pg) yield { type: "page_ref", doc: pg.doc, page: pg.page, thumb: pg.thumb };
      } else if (result.meta?.kind === "artifact") {
        yield {
          type: "artifact",
          title: result.meta.title,
          description: result.meta.description,
          html: result.meta.html,
        };
      }

      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    messages.push({ role: "user", content: toolResultBlocks });
  }

  yield { type: "done" };
}

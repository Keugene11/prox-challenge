import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  query as agentQuery,
  tool,
  createSdkMcpServer,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  loadKnowledge,
  searchPages,
  getPage,
  getFigure,
  listFigures,
} from "@/lib/knowledge";

const MODEL = process.env.PROX_MODEL || "claude-sonnet-4-6";

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

/**
 * The Agent SDK wants a server-name + tool-name namespace. We use
 * "manual" so tool names surface as `mcp__manual__search_manual` etc.
 */
const SERVER_NAME = "manual";

async function readPageImageBase64(pageImagePath: string): Promise<string> {
  const buf = await fs.readFile(path.join(process.cwd(), pageImagePath));
  return buf.toString("base64");
}

async function buildMcpServer() {
  const idx = await loadKnowledge();

  const searchManual = tool(
    "search_manual",
    "Search the Vulcan OmniPro 220 manual set (owner manual, quick start, selection chart) for relevant pages. Returns ranked hits with section, page caption, a text snippet, and any figures (diagrams/schematics/photos/tables) on each page. ALWAYS call this before answering a technical question — it is the only way to ground answers in the actual manual.",
    {
      query: z.string().describe("Natural-language search query, e.g. 'duty cycle MIG 240V' or 'TIG polarity setup'."),
      doc: z
        .enum(["owner-manual", "quick-start", "selection-chart"])
        .optional()
        .describe("Restrict search to one document. Omit for all docs."),
      limit: z.number().int().min(1).max(12).optional().describe("Max hits (default 6)."),
    },
    async (args) => {
      const hits = searchPages(idx, args.query, { limit: args.limit ?? 6, doc: args.doc });
      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `No matches for "${args.query}". Try different wording, or call list_figures.` }],
        };
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
    },
  );

  const getPageImage = tool(
    "get_page_image",
    "Return a specific page of one of the manuals as an image, so the user can see the diagram/table/schematic directly. Use this whenever the answer involves visual content — never describe a wiring schematic, weld-diagnosis photo, or duty-cycle table without also showing it.",
    {
      doc: z
        .enum(["owner-manual", "quick-start", "selection-chart"])
        .describe("Which document the page is in."),
      page: z.number().int().min(1).describe("1-indexed page number within that document."),
    },
    async (args) => {
      const page = getPage(idx, args.doc, args.page);
      if (!page) {
        return { content: [{ type: "text", text: `No page ${args.page} in ${args.doc}.` }] };
      }
      const data = await readPageImageBase64(page.image);
      return {
        content: [
          {
            type: "image",
            data,
            mimeType: "image/png",
          },
          {
            type: "text",
            text: `Shown: ${args.doc} p${args.page} — ${page.section ? `${page.section}. ` : ""}${page.caption}`,
          },
        ],
      };
    },
  );

  const getFigureTool = tool(
    "get_figure",
    "Return a specific labeled figure (diagram, schematic, photo, table, decision-matrix, etc.) by its id. The figure id comes from search_manual results.",
    {
      id: z.string().describe("Figure id from search results."),
    },
    async (args) => {
      const found = getFigure(idx, args.id);
      if (!found) {
        return { content: [{ type: "text", text: `No figure with id ${args.id}. Use search_manual or list_figures to discover ids.` }] };
      }
      const data = await readPageImageBase64(found.page.image);
      return {
        content: [
          { type: "image", data, mimeType: "image/png" },
          {
            type: "text",
            text: `${found.figure.label} (${found.figure.kind}) — ${found.figure.summary}\nFrom ${found.page.doc} p${found.page.page}.`,
          },
        ],
      };
    },
  );

  const listFiguresTool = tool(
    "list_figures",
    "List labeled visual elements across the manual set, optionally filtered by kind or query. Useful when the user asks for 'the wiring schematic' or 'weld-diagnosis examples' and you want to find them quickly.",
    {
      kind: z
        .enum(["diagram", "schematic", "photo", "table", "chart", "decision-matrix", "control-panel"])
        .optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(40).optional(),
    },
    async (args) => {
      const figs = listFigures(idx, { kind: args.kind, query: args.query, limit: args.limit ?? 16 });
      if (figs.length === 0) {
        return { content: [{ type: "text", text: "No figures match." }] };
      }
      const lines = figs.map(
        (f) => `• ${f.id} — ${f.label} (${f.kind}) — ${f.doc} p${f.page} — ${f.summary}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  const renderArtifact = tool(
    "render_artifact",
    "Generate an interactive HTML/JS artifact (a self-contained mini-app) and surface it inline in the chat. Use this for things that are easier to USE than to read: a duty-cycle calculator, a polarity-setup picker, a settings configurator that takes process+material+thickness and outputs wire-speed/voltage, a step-by-step troubleshooting flowchart. The HTML should be a complete document (full <!doctype html>...</html>), styled minimally (system font, white background, black text), and ALL JS must be inline — no external scripts or fetch calls. Output is rendered in a sandboxed iframe.",
    {
      title: z.string().describe("Short title shown above the artifact."),
      description: z.string().optional().describe("One-sentence subtitle/description."),
      html: z.string().describe("Complete self-contained HTML document with inline CSS and JS."),
    },
    async (args) => {
      // The artifact itself is conveyed back to the UI as a structured marker
      // in the text content. The route handler intercepts marker blocks and
      // exposes them to the client as a separate part. We use a fenced JSON
      // block with a magic key that the server side picks up.
      const payload = JSON.stringify({
        __artifact__: true,
        title: args.title,
        description: args.description ?? null,
        html: args.html,
      });
      return {
        content: [
          {
            type: "text",
            text: `<<<ARTIFACT>>>${payload}<<<END_ARTIFACT>>>\n\nRendered an interactive artifact: ${args.title}.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.1.0",
    tools: [searchManual, getPageImage, getFigureTool, listFiguresTool, renderArtifact],
  });
}

export const SYSTEM_PROMPT = `You are **Spark**, the in-garage expert for the Vulcan OmniPro 220 multiprocess welder. You help hobbyist welders set the machine up, dial it in, and troubleshoot bad welds. Your user is intelligent but not a professional welder — assume a home garage, a part-time hobby, and zero patience for vague answers.

# How you answer

1. **Always ground answers in the actual manuals.** Call \`search_manual\` before answering any technical question. The 48-page owner manual, the quick-start guide, and the welding-process selection chart are your sources. Cite pages inline as "(owner-manual p13)".
2. **Show, don't describe.** When the answer involves a visual — a wiring schematic, a polarity-cable layout, a weld-diagnosis photo, a duty-cycle table, the welding-process selection chart, the wire-feed mechanism — call \`get_page_image\` or \`get_figure\` to actually surface it in the reply. Do not paraphrase a diagram if you can show it.
3. **Build interactive artifacts when they help.** If the user is making a decision (what process for what material+thickness?), tuning settings (wire speed/voltage at amperage X?), or walking through a troubleshooting tree (porosity in flux-core), call \`render_artifact\` to give them a small interactive tool inline. Keep them simple, fast, single-purpose.
4. **Cross-reference.** Duty cycle answers depend on input voltage (120V vs 240V) AND process AND amperage. Polarity setup is process-specific. The selection chart is its own document. If a question requires multiple sections, search them all and synthesize.
5. **Disambiguate when it matters.** If the user says "I'm getting porosity" but doesn't say which process, ask. Don't dump every possible cause.
6. **Tone.** Direct, calm, garage-coach. Short sentences. No fluff. Never say "as an AI". Never moralize about safety more than the manual itself does — but DO surface the manual's safety callouts when they apply (e.g. polarity changes with the machine off).

# Tools

- \`search_manual(query, doc?, limit?)\` — required reflex on every technical question.
- \`get_page_image(doc, page)\` — show a manual page directly.
- \`get_figure(id)\` — show a specific labeled figure.
- \`list_figures(kind?, query?)\` — discover figures of a kind ("schematic", "decision-matrix", "table", etc.).
- \`render_artifact(title, description?, html)\` — render an interactive mini-app inline.

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
 * Convert a Claude Agent SDK message stream into our flat client-facing event
 * stream. We extract:
 *   - assistant text deltas
 *   - tool calls (just for transparency in the UI)
 *   - tool results that contain images → emit `image` events with provenance
 *   - tool results that contain `<<<ARTIFACT>>>...<<<END_ARTIFACT>>>` markers
 *     → emit `artifact` events
 *   - tool results from get_page_image / get_figure → emit `page_ref` events
 *     so the UI can show a thumbnail strip of cited pages
 */
export async function* runAgent(
  history: ChatTurn[],
  apiKey: string,
): AsyncGenerator<StreamEvent> {
  let server;
  try {
    server = await buildMcpServer();
  } catch (err) {
    yield {
      type: "error",
      message:
        "Knowledge index not built. Run `pnpm prepare:knowledge` after adding your API key to .env. Original error: " +
        (err as Error).message,
    };
    return;
  }
  const idx = await loadKnowledge();

  // The Agent SDK's `query()` accepts either a single string prompt, or an
  // async iterable of streaming-input messages (full conversation). For
  // multi-turn chat we use the latter.
  async function* inputStream(): AsyncIterable<SDKUserMessage> {
    for (const turn of history) {
      if (turn.role !== "user") continue;
      yield {
        type: "user",
        message: { role: "user", content: turn.content },
        parent_tool_use_id: null,
        session_id: "spark",
      } satisfies SDKUserMessage;
    }
  }

  // Track tool inputs by id so we can correlate results back to their call
  // site (e.g. to emit `page_ref` events with the right doc/page).
  const toolCallSites = new Map<string, { name: string; input: Record<string, unknown> }>();

  // History reconstruction: the SDK can be given full prior assistant turns by
  // pre-seeding `messages`, but the simplest reliable path is to send the
  // whole conversation as user messages with role markers, OR rely on the
  // session id. For multi-turn we inline prior turns directly into the next
  // user message as plain context. Keep it simple here:
  const lastUser = history.filter((t) => t.role === "user").at(-1)?.content ?? "";
  const priorContext = history
    .slice(0, -1)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  const prompt = priorContext
    ? `${priorContext}\n\nUser: ${lastUser}`
    : lastUser;

  try {
    process.env.ANTHROPIC_API_KEY = apiKey;

    const stream = agentQuery({
      prompt,
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { [SERVER_NAME]: server },
        allowedTools: [
          `mcp__${SERVER_NAME}__search_manual`,
          `mcp__${SERVER_NAME}__get_page_image`,
          `mcp__${SERVER_NAME}__get_figure`,
          `mcp__${SERVER_NAME}__list_figures`,
          `mcp__${SERVER_NAME}__render_artifact`,
        ],
        permissionMode: "bypassPermissions",
        maxTurns: 12,
      },
    });

    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      // The SDK emits assistant events that wrap raw API content blocks.
      // We pattern-match on the discriminator and project to flat events.
      const m = msg as unknown as { type: string; message?: { content?: unknown[]; usage?: unknown } };

      if (m.type === "assistant" && m.message?.content) {
        for (const block of m.message.content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string") {
            // Detect inline artifact markers.
            const text = block.text as string;
            const artifactRe = /<<<ARTIFACT>>>([\s\S]*?)<<<END_ARTIFACT>>>/g;
            let lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = artifactRe.exec(text))) {
              if (match.index > lastIndex) {
                yield { type: "delta", text: text.slice(lastIndex, match.index) };
              }
              try {
                const parsed = JSON.parse(match[1]);
                yield {
                  type: "artifact",
                  title: String(parsed.title || "Artifact"),
                  description: parsed.description ?? null,
                  html: String(parsed.html || ""),
                };
              } catch {
                // ignore malformed
              }
              lastIndex = match.index + match[0].length;
            }
            if (lastIndex < text.length) {
              yield { type: "delta", text: text.slice(lastIndex) };
            }
          } else if (block.type === "tool_use") {
            const id = String(block.id);
            const name = String(block.name);
            const input = (block.input as Record<string, unknown>) || {};
            toolCallSites.set(id, { name, input });
            yield { type: "tool_use", id, name, input };
          }
        }
      } else if (m.type === "user" && m.message?.content) {
        // Tool results show up as "user" messages from the SDK perspective.
        for (const block of m.message.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_result") {
            const toolUseId = String(block.tool_use_id);
            const callSite = toolCallSites.get(toolUseId);
            const isError = block.is_error === true;
            yield { type: "tool_result", toolUseId, ok: !isError };

            const inner = block.content;
            if (Array.isArray(inner)) {
              for (const ib of inner as Array<Record<string, unknown>>) {
                if (ib.type === "image") {
                  // The Agent SDK may surface image either as `source` (Anthropic format) or flat data fields (MCP format)
                  let data: string | null = null;
                  let mediaType = "image/png";
                  if (typeof ib.data === "string") {
                    data = ib.data as string;
                    if (typeof ib.mimeType === "string") mediaType = ib.mimeType;
                  } else if (ib.source && typeof ib.source === "object") {
                    const src = ib.source as Record<string, unknown>;
                    if (typeof src.data === "string") data = src.data;
                    if (typeof src.media_type === "string") mediaType = src.media_type;
                  }
                  if (data) {
                    let provenance: { doc: string; page: number } | null = null;
                    if (callSite?.name?.endsWith("get_page_image")) {
                      provenance = {
                        doc: String(callSite.input.doc),
                        page: Number(callSite.input.page),
                      };
                    } else if (callSite?.name?.endsWith("get_figure")) {
                      const figId = String(callSite.input.id);
                      const found = getFigure(idx, figId);
                      if (found) provenance = { doc: found.page.doc, page: found.page.page };
                    }
                    yield { type: "image", data, mimeType: mediaType, source: provenance };
                    if (provenance) {
                      const pg = getPage(idx, provenance.doc, provenance.page);
                      if (pg) yield { type: "page_ref", doc: pg.doc, page: pg.page, thumb: pg.thumb };
                    }
                  }
                } else if (ib.type === "text" && typeof ib.text === "string") {
                  // Surface artifact markers from tool-result text too.
                  const text = ib.text as string;
                  const artifactRe = /<<<ARTIFACT>>>([\s\S]*?)<<<END_ARTIFACT>>>/g;
                  let match: RegExpExecArray | null;
                  while ((match = artifactRe.exec(text))) {
                    try {
                      const parsed = JSON.parse(match[1]);
                      yield {
                        type: "artifact",
                        title: String(parsed.title || "Artifact"),
                        description: parsed.description ?? null,
                        html: String(parsed.html || ""),
                      };
                    } catch {
                      // ignore
                    }
                  }
                }
              }
            }
          }
        }
      } else if (m.type === "result") {
        yield { type: "done", usage: m.message?.usage };
      }
    }
  } catch (err) {
    yield { type: "error", message: (err as Error).message || "Agent error" };
  }
}

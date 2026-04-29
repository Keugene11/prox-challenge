/**
 * End-to-end smoke test against the running dev server.
 * Sends a question, parses the SSE stream, and reports what kinds of
 * content blocks the agent produced.
 *
 * Usage: pnpm tsx scripts/smoke-test.ts "your question here"
 */
const QUESTION = process.argv[2] || "Show me the wiring schematic.";
const URL = process.env.SMOKE_URL || "http://localhost:3000/api/chat";

type EventCounters = {
  delta_chars: number;
  tool_uses: Array<{ name: string; input: Record<string, unknown> }>;
  tool_results_ok: number;
  tool_results_err: number;
  images: Array<{ source: { doc: string; page: number } | null; size: number }>;
  artifacts: Array<{ title: string; htmlLen: number }>;
  page_refs: Array<{ doc: string; page: number }>;
  errors: string[];
  text: string;
};

async function main() {
  const counters: EventCounters = {
    delta_chars: 0,
    tool_uses: [],
    tool_results_ok: 0,
    tool_results_err: 0,
    images: [],
    artifacts: [],
    page_refs: [],
    errors: [],
    text: "",
  };

  const t0 = Date.now();
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      history: [{ role: "user", content: QUESTION }],
    }),
  });
  if (!res.ok || !res.body) {
    console.error("HTTP error:", res.status, await res.text());
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        const ev = JSON.parse(dataLine.slice(5).trim());
        if (ev.type === "delta") {
          counters.delta_chars += (ev.text || "").length;
          counters.text += ev.text || "";
        } else if (ev.type === "tool_use") {
          counters.tool_uses.push({ name: ev.name, input: ev.input });
        } else if (ev.type === "tool_result") {
          if (ev.ok) counters.tool_results_ok++;
          else counters.tool_results_err++;
        } else if (ev.type === "image") {
          counters.images.push({ source: ev.source, size: (ev.data || "").length });
        } else if (ev.type === "artifact") {
          counters.artifacts.push({ title: ev.title, htmlLen: (ev.html || "").length });
        } else if (ev.type === "page_ref") {
          counters.page_refs.push({ doc: ev.doc, page: ev.page });
        } else if (ev.type === "error") {
          counters.errors.push(ev.message);
        }
      } catch {
        // ignore
      }
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n=== SMOKE TEST RESULT ===");
  console.log(`Q: ${QUESTION}`);
  console.log(`time: ${dt}s`);
  console.log();
  console.log("tool calls:");
  for (const t of counters.tool_uses) {
    console.log(`  - ${t.name.replace(/^mcp__manual__/, "")}(${JSON.stringify(t.input)})`);
  }
  console.log(`tool results: ${counters.tool_results_ok} ok, ${counters.tool_results_err} err`);
  console.log(`images returned: ${counters.images.length}${counters.images.length ? " (from: " + counters.images.map((i) => i.source ? `${i.source.doc} p${i.source.page}` : "?").join(", ") + ")" : ""}`);
  console.log(`artifacts: ${counters.artifacts.length}${counters.artifacts.length ? " — " + counters.artifacts.map((a) => `"${a.title}" (${a.htmlLen}B)`).join(", ") : ""}`);
  console.log(`page refs: ${counters.page_refs.map((r) => `${r.doc} p${r.page}`).join(", ") || "—"}`);
  console.log(`text chars: ${counters.delta_chars}`);
  console.log(`errors: ${counters.errors.length}${counters.errors.length ? " — " + counters.errors.join("; ") : ""}`);
  console.log();
  console.log("--- assistant text ---");
  console.log(counters.text.trim() || "(empty)");
  console.log("--- end ---");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

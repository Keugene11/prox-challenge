import { NextRequest } from "next/server";
import { runAgent, type ChatTurn } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY missing on the server. Add it to .env and restart." }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  let body: { history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const history = (body.history || []).filter(
    (t): t is ChatTurn => !!t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string",
  );
  if (history.length === 0 || history.at(-1)?.role !== "user") {
    return new Response(JSON.stringify({ error: "history must end with a user turn" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of runAgent(history, apiKey)) {
          controller.enqueue(encoder.encode(sse(ev.type, ev)));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(sse("error", { type: "error", message: (err as Error).message })),
        );
      } finally {
        controller.enqueue(encoder.encode(sse("end", { type: "end" })));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

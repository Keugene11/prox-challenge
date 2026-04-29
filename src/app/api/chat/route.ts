import { NextRequest } from "next/server";
import { runAgent, type ChatTurn } from "@/lib/agent";
import { rateLimit, clientKey } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_TURNS = 30;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 60_000;

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function reject(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", "x-content-type-options": "nosniff" },
  });
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Don't leak deployment-specific guidance in the error.
    return reject(500, "Server is not configured.");
  }

  // Rate limit early — before parsing or hitting the model.
  const limit = rateLimit(clientKey(req));
  if (!limit.ok) {
    return new Response(
      JSON.stringify({ error: `Rate limit exceeded. Try again in ${limit.retryAfterSec}s.` }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(limit.retryAfterSec),
          "x-content-type-options": "nosniff",
        },
      },
    );
  }

  let body: { history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return reject(400, "Invalid JSON body.");
  }

  const raw = Array.isArray(body.history) ? body.history : [];
  const history = raw.filter(
    (t): t is ChatTurn => !!t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string",
  );

  if (history.length === 0 || history.at(-1)?.role !== "user") {
    return reject(400, "history must end with a user turn.");
  }
  if (history.length > MAX_TURNS) {
    return reject(413, `Conversation too long (max ${MAX_TURNS} turns).`);
  }
  let total = 0;
  for (const t of history) {
    if (t.content.length > MAX_MESSAGE_CHARS) {
      return reject(413, `One message exceeded the ${MAX_MESSAGE_CHARS}-char limit.`);
    }
    total += t.content.length;
  }
  if (total > MAX_TOTAL_CHARS) {
    return reject(413, `Conversation exceeds ${MAX_TOTAL_CHARS} chars total.`);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of runAgent(history, apiKey)) {
          // If the agent yielded a raw error event, sanitize the message.
          if (ev.type === "error") {
            console.error("[chat] runAgent error:", ev.message);
            controller.enqueue(
              encoder.encode(
                sse("error", { type: "error", message: "The agent ran into a problem. Try again." }),
              ),
            );
            continue;
          }
          controller.enqueue(encoder.encode(sse(ev.type, ev)));
        }
      } catch (err) {
        // Log full error server-side, return a generic message to the client.
        console.error("[chat] stream exception:", err);
        controller.enqueue(
          encoder.encode(
            sse("error", { type: "error", message: "Server error during streaming." }),
          ),
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
      "x-content-type-options": "nosniff",
      connection: "keep-alive",
    },
  });
}

"use client";

import type { StreamEvent } from "@/lib/agent";

export type ChatStreamEvent = StreamEvent | { type: "end" };

/**
 * Streams SSE events from POST /api/chat. Yields parsed events as they
 * arrive. Aborts cleanly when the AbortSignal fires.
 */
export async function* streamChat(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ history }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = "request failed";
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {
      // ignore
    }
    yield { type: "error", message: msg } as StreamEvent;
    yield { type: "end" };
    return;
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
        const json = JSON.parse(dataLine.slice(5).trim());
        yield json as ChatStreamEvent;
      } catch {
        // ignore
      }
    }
  }
}

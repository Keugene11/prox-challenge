"use client";

import type { ChatMessage, MessagePart } from "@/components/Message";

const KEY = "spark.conversations.v1";

export type StoredConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

/**
 * Image parts in live state hold a base64 data URI (`data:image/jpeg;base64,...`)
 * that came back from a tool call. That's anywhere from 50KB to 800KB per
 * image — localStorage caps somewhere around 5MB total per origin, so storing
 * raw base64 will fill the bucket after ~5 images. Instead, when we serialize,
 * we replace the data URI with an HTTP path back to the page-image API. The
 * provenance (`source: {doc, page}`) is kept verbatim, and on load we point
 * `src` at `/api/page-image?...` so the same page renders without us having
 * to keep a megabyte of base64 around.
 */
function serializeMessage(m: ChatMessage): ChatMessage {
  return {
    ...m,
    parts: m.parts.map((p): MessagePart => {
      if (p.kind === "image") {
        if (p.source) {
          return { kind: "image", src: pageImageUrl(p.source.doc, p.source.page), source: p.source };
        }
        // Untraceable image — drop the data URI to keep storage small;
        // we'd rather lose the image than blow the quota.
        return { kind: "image", src: "", source: null };
      }
      return p;
    }),
    pageRefs: [...m.pageRefs],
  };
}

export function pageImageUrl(doc: string, page: number) {
  return `/api/page-image?doc=${encodeURIComponent(doc)}&page=${page}`;
}

export function loadConversations(): StoredConversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is StoredConversation => c && typeof c.id === "string" && Array.isArray(c.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveConversation(conv: StoredConversation) {
  if (typeof window === "undefined") return;
  const list = loadConversations();
  const i = list.findIndex((c) => c.id === conv.id);
  const stored: StoredConversation = {
    ...conv,
    messages: conv.messages.map(serializeMessage),
  };
  if (i >= 0) list[i] = stored;
  else list.unshift(stored);
  // Cap to most recent 50 conversations to keep the bucket bounded.
  const trimmed = list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch (err) {
    // QuotaExceededError — drop the oldest few and retry once.
    console.warn("[storage] save failed, trimming and retrying", err);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(trimmed.slice(0, Math.max(5, Math.floor(trimmed.length / 2)))));
    } catch {
      // Give up; next session will reset.
    }
  }
}

export function deleteConversation(id: string) {
  if (typeof window === "undefined") return;
  const list = loadConversations().filter((c) => c.id !== id);
  window.localStorage.setItem(KEY, JSON.stringify(list));
}

export function clearAllConversations() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

export function newConversationId(): string {
  // Crypto random where available, fallback for old browsers.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function makeTitle(firstUserMessage: string): string {
  const text = firstUserMessage.replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  // Single line, bounded length.
  return text.length > 60 ? text.slice(0, 57).trimEnd() + "…" : text;
}

export function exportAsJson(conv: StoredConversation): string {
  return JSON.stringify(conv, null, 2);
}

export function exportAsMarkdown(conv: StoredConversation): string {
  const lines: string[] = [`# ${conv.title}`, "", `_${new Date(conv.createdAt).toLocaleString()}_`, ""];
  for (const m of conv.messages) {
    lines.push(`## ${m.role === "user" ? "You" : "Spark"}`, "");
    for (const p of m.parts) {
      if (p.kind === "text" && p.text.trim()) lines.push(p.text, "");
      else if (p.kind === "image" && p.source) lines.push(`*[${p.source.doc} p${p.source.page}]*`, "");
      else if (p.kind === "artifact") lines.push(`*[Artifact: ${p.artifact.title}]*`, "");
    }
    if (m.pageRefs.length) {
      lines.push(`_Sources: ${m.pageRefs.map((r) => `${r.doc} p${r.page}`).join(", ")}_`, "");
    }
  }
  return lines.join("\n");
}

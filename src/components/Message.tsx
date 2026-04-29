"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Artifact, type ArtifactPayload } from "./Artifact";
import { PageThumb } from "./PageThumb";

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; src: string; source?: { doc: string; page: number } | null }
  | { kind: "artifact"; artifact: ArtifactPayload }
  | { kind: "tool"; name: string; status: "running" | "done" | "error" };

export type ChatMessage = {
  role: "user" | "assistant";
  parts: MessagePart[];
  pageRefs: Array<{ doc: string; page: number }>;
};

export function Message({
  msg,
  onOpenPage,
}: {
  msg: ChatMessage;
  onOpenPage: (doc: string, page: number) => void;
}) {
  if (msg.role === "user") {
    const text = msg.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-ink text-paper-card px-4 py-2.5 text-sm whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {msg.parts.map((part, i) => {
        if (part.kind === "text") {
          if (!part.text.trim()) return null;
          return (
            <div key={i} className="prose-tight text-[15px] leading-[1.55] text-ink">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.kind === "image") {
          return (
            <figure key={i} className="card overflow-hidden">
              <button
                type="button"
                onClick={part.source ? () => onOpenPage(part.source!.doc, part.source!.page) : undefined}
                className="press block w-full"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={part.src} alt="manual page" className="w-full bg-white" />
              </button>
              {part.source ? (
                <figcaption className="px-3 py-2 text-xs text-ink-muted border-t border-ink-line">
                  From <span className="text-ink">{labelFor(part.source.doc)}</span> · page {part.source.page}
                </figcaption>
              ) : null}
            </figure>
          );
        }
        if (part.kind === "artifact") {
          return <Artifact key={i} artifact={part.artifact} />;
        }
        if (part.kind === "tool") {
          return (
            <div key={i} className="flex items-center gap-2 text-[11px] text-ink-muted">
              <span
                className={
                  "h-1.5 w-1.5 rounded-full " +
                  (part.status === "running" ? "bg-ink dot-pulse" : part.status === "error" ? "bg-red-500" : "bg-ink-muted/50")
                }
              />
              <span className="font-mono">{prettyToolName(part.name)}</span>
              <span>{part.status === "running" ? "running…" : part.status === "error" ? "failed" : "done"}</span>
            </div>
          );
        }
        return null;
      })}
      {msg.pageRefs.length > 0 ? (
        <div className="mt-1">
          <div className="text-[11px] uppercase tracking-wide text-ink-muted mb-1.5">Sources</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {dedupeRefs(msg.pageRefs).map((r) => (
              <PageThumb
                key={`${r.doc}-${r.page}`}
                doc={r.doc}
                page={r.page}
                onOpen={() => onOpenPage(r.doc, r.page)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function dedupeRefs(refs: Array<{ doc: string; page: number }>) {
  const seen = new Set<string>();
  const out: Array<{ doc: string; page: number }> = [];
  for (const r of refs) {
    const k = `${r.doc}-${r.page}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function prettyToolName(name: string) {
  const last = name.split("__").pop() || name;
  return last.replace(/_/g, " ");
}

function labelFor(doc: string) {
  switch (doc) {
    case "owner-manual":
      return "Owner's Manual";
    case "quick-start":
      return "Quick Start";
    case "selection-chart":
      return "Selection Chart";
    default:
      return doc;
  }
}

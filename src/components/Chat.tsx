"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Message, type ChatMessage, type MessagePart } from "./Message";
import { PageViewer } from "./PageViewer";
import { streamChat } from "@/lib/stream-client";

const SUGGESTIONS = [
  "What's the duty cycle for MIG at 200A on 240V?",
  "I'm getting porosity in my flux-cored welds. What should I check?",
  "What polarity setup do I need for TIG? Which socket does the ground clamp go in?",
  "Show me the wiring schematic.",
  "Build me a settings configurator: process, material, thickness → wire speed and voltage.",
];

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<{ doc: string; page: number } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    autosizeTextarea(taRef.current);
  }, [input]);

  async function send(textRaw?: string) {
    const text = (textRaw ?? input).trim();
    if (!text || streaming) return;
    setInput("");

    const nextHistory: ChatMessage[] = [
      ...messages,
      { role: "user", parts: [{ kind: "text", text }], pageRefs: [] },
      { role: "assistant", parts: [], pageRefs: [] },
    ];
    setMessages(nextHistory);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const apiHistory = nextHistory
      .filter((m) => m.role === "user" || (m.role === "assistant" && m.parts.length > 0))
      .map((m) => ({
        role: m.role,
        content: m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""),
      }));

    // The filter above already excluded the empty trailing assistant turn,
    // so apiHistory ends on the user message — that's what the server wants.
    const sendable = apiHistory;

    let buffered = "";
    let lastCommitted = "";

    function patchAssistant(updater: (m: ChatMessage) => ChatMessage) {
      setMessages((prev) => {
        const out = prev.slice();
        const idx = out.length - 1;
        if (idx < 0 || out[idx].role !== "assistant") return prev;
        out[idx] = updater(out[idx]);
        return out;
      });
    }

    function appendText(delta: string) {
      buffered += delta;
      // Throttle re-renders: commit every animation frame.
      if (buffered === lastCommitted) return;
      lastCommitted = buffered;
      patchAssistant((m) => {
        const parts = m.parts.slice();
        const last = parts[parts.length - 1];
        if (last && last.kind === "text") {
          parts[parts.length - 1] = { kind: "text", text: buffered };
        } else {
          parts.push({ kind: "text", text: buffered });
        }
        return { ...m, parts };
      });
    }

    function startNewTextSlot() {
      buffered = "";
      lastCommitted = "";
      patchAssistant((m) => ({ ...m, parts: [...m.parts, { kind: "text", text: "" }] }));
    }

    try {
      for await (const ev of streamChat(sendable, ac.signal)) {
        if (ev.type === "delta") {
          appendText(ev.text);
        } else if (ev.type === "tool_use") {
          // Lock in any in-progress text and add a tool indicator.
          if (buffered) {
            startNewTextSlot();
          }
          patchAssistant((m) => ({
            ...m,
            parts: [...m.parts, { kind: "tool", name: ev.name, status: "running" }],
          }));
        } else if (ev.type === "tool_result") {
          patchAssistant((m) => {
            const parts = m.parts.slice();
            for (let i = parts.length - 1; i >= 0; i--) {
              const p = parts[i];
              if (p.kind === "tool" && p.status === "running") {
                parts[i] = { ...p, status: ev.ok ? "done" : "error" };
                break;
              }
            }
            return { ...m, parts };
          });
        } else if (ev.type === "image") {
          const src = `data:${ev.mimeType};base64,${ev.data}`;
          patchAssistant((m) => ({
            ...m,
            parts: [...m.parts, { kind: "image", src, source: ev.source ?? null }],
          }));
          buffered = "";
          lastCommitted = "";
        } else if (ev.type === "artifact") {
          patchAssistant((m) => ({
            ...m,
            parts: [
              ...m.parts,
              {
                kind: "artifact",
                artifact: { title: ev.title, description: ev.description, html: ev.html },
              },
            ],
          }));
          buffered = "";
          lastCommitted = "";
        } else if (ev.type === "page_ref") {
          patchAssistant((m) => ({
            ...m,
            pageRefs: [...m.pageRefs, { doc: ev.doc, page: ev.page }],
          }));
        } else if (ev.type === "error") {
          patchAssistant((m) => ({
            ...m,
            parts: [...m.parts, { kind: "text", text: `\n\n_⚠️ ${ev.message}_` }],
          }));
        }
      }
    } catch (err) {
      patchAssistant((m) => ({
        ...m,
        parts: [
          ...m.parts,
          { kind: "text", text: `\n\n_⚠️ Connection lost: ${(err as Error).message}_` },
        ],
      }));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh]">
      <Header />
      <div ref={scrollerRef} className="flex-1 overflow-y-auto scroll-fade">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
          {messages.length === 0 ? (
            <Welcome onPick={(s) => send(s)} />
          ) : (
            messages.map((m, i) => (
              <Message
                key={i}
                msg={m}
                onOpenPage={(doc, page) => setViewer({ doc, page })}
              />
            ))
          )}
        </div>
      </div>
      <Composer
        ref={taRef}
        value={input}
        onChange={setInput}
        onSubmit={() => send()}
        onStop={stop}
        streaming={streaming}
      />
      {viewer ? (
        <PageViewer doc={viewer.doc} page={viewer.page} onClose={() => setViewer(null)} />
      ) : null}
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-ink-line bg-paper-card/80 backdrop-blur sticky top-0 z-10">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-full bg-ink text-paper-card flex items-center justify-center text-[11px] font-semibold">
            S
          </div>
          <div>
            <div className="text-sm font-semibold leading-none">Spark</div>
            <div className="text-[11px] text-ink-muted leading-none mt-0.5">
              Vulcan OmniPro 220 expert
            </div>
          </div>
        </div>
        <a
          href="https://www.harborfreight.com/omnipro-220-industrial-multiprocess-welder-with-120240v-input-57812.html"
          target="_blank"
          rel="noopener noreferrer"
          className="pill press"
        >
          About the OmniPro 220
        </a>
      </div>
    </header>
  );
}

function Welcome({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="flex flex-col items-center text-center gap-6 pt-6 sm:pt-12">
      <div className="h-12 w-12 rounded-full bg-ink text-paper-card flex items-center justify-center font-semibold">
        S
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          Hey. I&rsquo;m Spark.
        </h1>
        <p className="text-ink-muted text-sm max-w-md mx-auto">
          Your in-garage expert for the Vulcan OmniPro 220. Ask anything — duty cycles, polarity setup, weld defects, settings — and I&rsquo;ll show you the right page, diagram, or interactive tool.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-2xl">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="press text-left text-sm rounded-2xl border border-ink-line bg-paper-card px-4 py-3 hover:bg-ink/[0.02]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

import { forwardRef } from "react";

const Composer = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    onStop: () => void;
    streaming: boolean;
  }
>(function Composer({ value, onChange, onSubmit, onStop, streaming }, ref) {
  return (
    <div className="border-t border-ink-line bg-paper-card">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex items-end gap-2 rounded-2xl border border-ink-line bg-paper-card px-3 py-2 focus-within:border-ink/30"
        >
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            rows={1}
            placeholder="Ask about the OmniPro 220…"
            className="flex-1 resize-none bg-transparent outline-none text-[15px] leading-snug py-2 max-h-44"
          />
          {streaming ? (
            <button type="button" onClick={onStop} className="btn-primary !px-3 !py-2" title="Stop">
              <Square size={14} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!value.trim()}
              className="btn-primary !px-3 !py-2"
              title="Send"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </form>
        <div className="mt-1.5 text-[10.5px] text-ink-muted text-center">
          Spark cites manual pages and may show diagrams or interactive tools.
        </div>
      </div>
    </div>
  );
});

function autosizeTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(176, el.scrollHeight) + "px";
}

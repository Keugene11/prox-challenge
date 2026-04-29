"use client";

import { ExternalLink } from "lucide-react";

export function PageThumb({
  doc,
  page,
  caption,
  onOpen,
}: {
  doc: string;
  page: number;
  caption?: string;
  onOpen?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="press group flex items-center gap-3 w-full text-left rounded-xl border border-ink-line bg-paper-card p-2 hover:bg-ink/[0.02]"
      title={caption || `${doc} p${page}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/page-image?doc=${encodeURIComponent(doc)}&page=${page}&variant=thumb`}
        alt={`${doc} page ${page}`}
        className="h-16 w-12 object-cover rounded-md border border-ink-line bg-white"
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-ink-muted">
          {labelFor(doc)} · p{page}
        </div>
        {caption ? <div className="text-xs text-ink line-clamp-2">{caption}</div> : null}
      </div>
      <ExternalLink size={14} className="text-ink-muted opacity-0 group-hover:opacity-100" />
    </button>
  );
}

function labelFor(doc: string) {
  switch (doc) {
    case "owner-manual":
      return "Owner Manual";
    case "quick-start":
      return "Quick Start";
    case "selection-chart":
      return "Selection Chart";
    default:
      return doc;
  }
}

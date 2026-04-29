"use client";

import { X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState } from "react";

export function PageViewer({
  doc,
  page,
  onClose,
}: {
  doc: string;
  page: number;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative max-w-5xl w-full max-h-[90vh] flex flex-col bg-paper-card rounded-2xl shadow-card-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-line">
          <div className="text-sm font-medium">
            {labelFor(doc)} · page {page}
          </div>
          <div className="flex items-center gap-2">
            <button className="btn !px-2 !py-1.5" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
              <ZoomOut size={14} />
            </button>
            <button className="btn !px-2 !py-1.5" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
              <ZoomIn size={14} />
            </button>
            <button className="btn !px-2 !py-1.5" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="overflow-auto bg-white flex items-start justify-center p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/page-image?doc=${encodeURIComponent(doc)}&page=${page}`}
            alt={`${doc} page ${page}`}
            style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
            className="object-contain"
          />
        </div>
      </div>
    </div>
  );
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

"use client";

import { X, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startY: number; scrollLeft: number; scrollTop: number; pointerId: number } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(4, z + 0.25));
      else if (e.key === "-" || e.key === "_") setZoom((z) => Math.max(0.5, z - 0.25));
      else if (e.key === "0") setZoom(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const el = scrollerRef.current;
    if (!el) return;
    // Only left-click / primary touch / pen
    if (e.button !== undefined && e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      pointerId: e.pointerId,
    };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = scrollerRef.current;
    const s = dragState.current;
    if (!el || !s || s.pointerId !== e.pointerId) return;
    e.preventDefault();
    el.scrollLeft = s.scrollLeft - (e.clientX - s.startX);
    el.scrollTop = s.scrollTop - (e.clientY - s.startY);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const el = scrollerRef.current;
    const s = dragState.current;
    if (s && el && el.hasPointerCapture(s.pointerId)) {
      el.releasePointerCapture(s.pointerId);
    }
    dragState.current = null;
    setDragging(false);
    void e;
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    // Ctrl/Cmd + wheel = zoom (standard desktop convention).
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.2 : 0.2;
    setZoom((z) => Math.max(0.5, Math.min(4, z + delta)));
  }

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
            <span className="text-[11px] text-ink-muted font-mono tabular-nums w-10 text-right">
              {Math.round(zoom * 100)}%
            </span>
            <button className="btn !px-2 !py-1.5" title="Zoom out (−)" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
              <ZoomOut size={14} />
            </button>
            <button className="btn !px-2 !py-1.5" title="Reset zoom (0)" onClick={() => setZoom(1)}>
              <Maximize2 size={14} />
            </button>
            <button className="btn !px-2 !py-1.5" title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
              <ZoomIn size={14} />
            </button>
            <button className="btn !px-2 !py-1.5" title="Close (Esc)" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>
        <div
          ref={scrollerRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
          className="overflow-auto bg-white flex items-start justify-center p-4 select-none touch-none"
          style={{ cursor: dragging ? "grabbing" : "grab" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/page-image?doc=${encodeURIComponent(doc)}&page=${page}`}
            alt={`${doc} page ${page}`}
            draggable={false}
            style={{ width: `${zoom * 100}%`, maxWidth: "none", pointerEvents: "none" }}
            className="object-contain"
          />
        </div>
        <div className="px-4 py-1.5 border-t border-ink-line text-[10.5px] text-ink-muted text-center">
          Drag to pan · scroll-wheel + ⌘/ctrl to zoom · +/− keys · Esc to close
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

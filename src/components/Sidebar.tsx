"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, X, Menu, Download, FileJson, FileText } from "lucide-react";
import {
  loadConversations,
  deleteConversation,
  exportAsJson,
  exportAsMarkdown,
  type StoredConversation,
} from "@/lib/storage";

export function Sidebar({
  open,
  onClose,
  activeId,
  onSelect,
  onNew,
  conversations,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  conversations: StoredConversation[];
  onDelete: (id: string) => void;
}) {
  return (
    <>
      {open ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm md:bg-transparent md:backdrop-blur-0 md:pointer-events-none"
        />
      ) : null}
      <aside
        className={`fixed left-0 top-0 bottom-0 z-40 w-[280px] bg-paper-card border-r border-ink-line flex flex-col transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-line">
          <div className="text-sm font-semibold">Conversations</div>
          <button onClick={onClose} className="btn !px-2 !py-1.5" title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="px-3 py-2 border-b border-ink-line">
          <button onClick={onNew} className="btn-primary w-full !rounded-xl !py-2 text-sm">
            <Plus size={14} />
            New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {conversations.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-ink-muted">
              No saved chats yet. Ask Spark anything to start one.
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {conversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  conv={c}
                  active={c.id === activeId}
                  onSelect={() => onSelect(c.id)}
                  onDelete={() => onDelete(c.id)}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="px-3 py-2 border-t border-ink-line">
          <p className="text-[10.5px] text-ink-muted leading-snug">
            Saved locally in your browser. Cleared if you wipe site data.
          </p>
        </div>
      </aside>
    </>
  );
}

function ConversationRow({
  conv,
  active,
  onSelect,
  onDelete,
}: {
  conv: StoredConversation;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  function downloadFile(filename: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setMenuOpen(false);
  }

  const safeBase = conv.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chat";

  return (
    <li
      className={
        "group relative rounded-lg px-2 py-1.5 text-sm cursor-pointer flex items-start justify-between gap-1 " +
        (active ? "bg-ink/[0.06]" : "hover:bg-ink/[0.03]")
      }
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1 py-0.5">
        <div className="truncate font-medium leading-tight">{conv.title}</div>
        <div className="text-[10.5px] text-ink-muted mt-0.5">{relTime(conv.updatedAt)}</div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="press p-1.5 rounded-md text-ink-muted hover:bg-ink/[0.05]"
            title="Export"
          >
            <Download size={13} />
          </button>
          {menuOpen ? (
            <>
              <button
                type="button"
                aria-label="Close menu"
                className="fixed inset-0 z-10"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                }}
              />
              <div className="absolute right-0 top-7 z-20 w-36 rounded-lg border border-ink-line bg-paper-card shadow-card-lg py-1 text-xs">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadFile(`spark-${safeBase}.md`, exportAsMarkdown(conv), "text/markdown");
                  }}
                  className="press w-full text-left px-3 py-1.5 hover:bg-ink/[0.04] flex items-center gap-2"
                >
                  <FileText size={12} />
                  Markdown
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadFile(`spark-${safeBase}.json`, exportAsJson(conv), "application/json");
                  }}
                  className="press w-full text-left px-3 py-1.5 hover:bg-ink/[0.04] flex items-center gap-2"
                >
                  <FileJson size={12} />
                  JSON
                </button>
              </div>
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (confirming) {
              onDelete();
            } else {
              setConfirming(true);
            }
          }}
          className={
            "press p-1.5 rounded-md " +
            (confirming ? "text-red-600 bg-red-50" : "text-ink-muted hover:bg-ink/[0.05]")
          }
          title={confirming ? "Click again to confirm" : "Delete"}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </li>
  );
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function SidebarToggle({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="press p-1.5 rounded-md hover:bg-ink/[0.04]" title="Conversations">
      <Menu size={16} />
    </button>
  );
}

// Keep this here so imports stay co-located.
export { loadConversations };

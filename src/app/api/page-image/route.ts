import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { loadKnowledge, getPage } from "@/lib/knowledge";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const doc = searchParams.get("doc") || "";
  const page = Number(searchParams.get("page") || "0");
  const variant = searchParams.get("variant") === "thumb" ? "thumb" : "full";
  if (!doc || !Number.isFinite(page) || page < 1) {
    return new Response("missing or invalid params", { status: 400 });
  }
  try {
    const idx = await loadKnowledge();
    const p = getPage(idx, doc, page);
    if (!p) return new Response("not found", { status: 404 });
    const rel = variant === "thumb" ? p.thumb : p.image;
    const buf = await fs.readFile(path.join(process.cwd(), rel));
    const ct = rel.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    return new Response(buf, {
      headers: {
        "content-type": ct,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    // Log server-side, return generic 500 to client (no path/error leakage).
    console.error("[page-image] read failed:", err);
    return new Response("server error", { status: 500 });
  }
}

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
  if (!doc || !page) return new Response("missing params", { status: 400 });
  try {
    const idx = await loadKnowledge();
    const p = getPage(idx, doc, page);
    if (!p) return new Response("not found", { status: 404 });
    const rel = variant === "thumb" ? p.thumb : p.image;
    const buf = await fs.readFile(path.join(process.cwd(), rel));
    const ct = rel.endsWith(".png") ? "image/png" : "image/jpeg";
    return new Response(buf, {
      headers: {
        "content-type": ct,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    return new Response("error: " + (err as Error).message, { status: 500 });
  }
}

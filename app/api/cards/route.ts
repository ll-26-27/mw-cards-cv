import { NextRequest, NextResponse } from "next/server";
import { hub, type PublishedCard } from "../../lib/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Readable from other machines on the network (the overlay app).
const CORS = { "Access-Control-Allow-Origin": "*" };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : "");

/** Current cards for every feed, for clients that would rather poll than stream. */
export async function GET() {
  return NextResponse.json(hub.snapshot(), { headers: CORS });
}

/** A detection page reports the cards one feed is showing: `{ feed, cards }`. */
export async function POST(req: NextRequest) {
  let body: { feed?: unknown; cards?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const feed = str(body.feed).trim();
  if (!feed || !Array.isArray(body.cards)) {
    return NextResponse.json({ error: "expected { feed, cards[] }" }, { status: 400 });
  }
  const cards: PublishedCard[] = body.cards
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      code: str(c.code),
      rank: str(c.rank),
      suit: str(c.suit),
      confidence: num(c.confidence),
      x: num(c.x),
      y: num(c.y),
      width: num(c.width),
      height: num(c.height),
    }))
    .filter((c) => c.code);
  hub.set(feed, cards);
  return NextResponse.json({ ok: true, subscribers: hub.subscribers });
}

/** A detection page stopped: `DELETE /api/cards?feed=name` clears that feed. */
export async function DELETE(req: NextRequest) {
  const feed = req.nextUrl.searchParams.get("feed")?.trim();
  if (!feed) return NextResponse.json({ error: "feed is required" }, { status: 400 });
  hub.remove(feed);
  return NextResponse.json({ ok: true });
}

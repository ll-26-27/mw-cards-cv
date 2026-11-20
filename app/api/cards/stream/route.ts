import { hub, type Snapshot } from "../../../lib/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-sent events: one `data:` line holding the full snapshot of every feed, sent on
// connect and again whenever any feed's cards change. From another machine:
//   new EventSource("http://<this-computer>:3000/api/cards/stream")
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const send = (snapshot: Snapshot) => write(`data: ${JSON.stringify(snapshot)}\n\n`);

      send(hub.snapshot());
      const unsubscribe = hub.subscribe(send);
      // Comment lines keep the connection open through idle stretches.
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

import { subscribe } from "@/lib/sampler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const enc = new TextEncoder();
  let unsub = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          unsub();
        }
      };
      unsub = subscribe(send);
      const close = () => {
        unsub();
        try { controller.close(); } catch {}
      };
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      unsub();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}

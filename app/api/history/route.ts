import { getHistory } from "@/lib/sampler";
import type { RangeKey } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const r = new URL(req.url).searchParams.get("range");
  const range: RangeKey = r === "6h" || r === "24h" ? r : "1h";
  return Response.json(getHistory(range));
}

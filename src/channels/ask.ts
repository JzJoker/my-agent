import http from "node:http";
import type { Agent } from "../types";

// Minimal HTTP endpoint implementing the hey-llm contract:
//   POST /ask { text }  ->  { speak, actions[] }
// Token-gated; meant to be reached only over a private network (Tailscale/LAN).
export const startAskServer = (
  agent: Agent,
  opts: { token: string; port: number },
) => {
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && path === "/health") return json(200, { ok: true });
    if (req.method !== "POST" || path !== "/ask") return json(404, { error: "not found" });
    if (req.headers["authorization"] !== `Bearer ${opts.token}`)
      return json(401, { error: "unauthorized" });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 100_000) return req.destroy();
      }
      const text = String(JSON.parse(body || "{}").text ?? "").trim();
      if (!text) return json(400, { error: "missing 'text'" });
      return json(200, await agent.ask(text));
    } catch (e: any) {
      return json(500, { error: String(e?.message ?? e) });
    }
  });
  server.listen(opts.port, () => console.log(`ask endpoint on :${opts.port}`));
};

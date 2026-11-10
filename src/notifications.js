import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export function createNotificationServer({ token, send }) {
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.method !== "POST" || req.url !== "/notify") return reply(404, { error: "Not found" });
    const actual = Buffer.from(req.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return reply(401, { error: "Unauthorized" });
    }
    try {
      const chunks = [];
      let bytes = 0;
      req.setTimeout(10_000, () => req.destroy());
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32_000) return reply(413, { error: "Body too large" });
        chunks.push(chunk);
      }
      const { message } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof message !== "string" || !message.trim() || message.length > 12_000) {
        return reply(400, { error: "message must contain 1-12000 characters" });
      }
      await send(message);
      reply(200, { sent: true });
    } catch (error) {
      reply(error instanceof SyntaxError ? 400 : 503, {
        error: error instanceof SyntaxError ? "Invalid JSON" : "Teams delivery unavailable",
      });
    }
  });
}

export const config = {
  runtime: "edge"
};

const SEC = {
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: SEC });

export default async function handler(req) {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const ACCESS_CODE = process.env.ACCESS_CODE;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const ENV_MODEL = process.env.MODEL;

  const clientCode = req.headers.get("x-access-code");
  if (!ACCESS_CODE || clientCode !== ACCESS_CODE) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  if (!ANTHROPIC_API_KEY) {
    return jsonResponse(500, { error: "server_not_configured" });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "bad_request" });
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const filtered = rawMessages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20);

  if (!filtered.length || filtered[0].role !== "user" || filtered[filtered.length - 1].role !== "user") {
    return jsonResponse(400, { error: "bad_request" });
  }

  // تفعيل Prompt Caching للرسالة الأولى لتسريع الاستجابة بشكل كبير
  const messages = filtered.map((m, idx) => {
    if (idx === 0) {
      return {
        role: m.role,
        content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }]
      };
    }
    return { role: m.role, content: m.content };
  });

  // استخدام أسرع وأحدث موديلات Claude الرسمية مع بدائل تلقائية
  const defaultModels = [
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest"
  ];

  const modelsToTry = (ENV_MODEL && ENV_MODEL !== "claude-sonnet-5-5")
    ? [ENV_MODEL, ...defaultModels]
    : defaultModels;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      // إرسال بايت مبدئي فوراً لفتح مهلة Vercel إلى 300 ثانية ومنع انقطاع الاتصال
      controller.enqueue(encoder.encode(" "));
      const keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode(" ")); } catch {}
      }, 2000);

      try {
        let upstreamRes = null;
        let lastErrType = "upstream_error";

        for (const modelName of modelsToTry) {
          const r = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
            method: "POST",
            headers: {
              "x-api-key": ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model: modelName,
              max_tokens: 8192,
              stream: true,
              messages
            })
          });

          if (r.ok && r.body) {
            upstreamRes = r;
            break;
          }

          const errJson = await r.json().catch(() => ({}));
          lastErrType = errJson?.error?.type || `http_${r.status}`;

          if (r.status === 404 || r.status === 400) {
            continue;
          }
          break;
        }

        if (!upstreamRes || !upstreamRes.body) {
          clearInterval(keepAlive);
          controller.enqueue(encoder.encode(JSON.stringify({ error: lastErrType })));
          controller.close();
          return;
        }

        let fullText = "";
        let stopReason = "end_turn";
        let buffer = "";
        const reader = upstreamRes.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            try {
              const evt = JSON.parse(dataStr);
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                fullText += evt.delta.text;
              } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
                stopReason = evt.delta.stop_reason;
              }
            } catch {}
          }
        }

        clearInterval(keepAlive);
        controller.enqueue(encoder.encode(JSON.stringify({ text: fullText, stop_reason: stopReason })));
        controller.close();
      } catch {
        clearInterval(keepAlive);
        controller.enqueue(encoder.encode(JSON.stringify({ error: "upstream_error" })));
        controller.close();
      }
    }
  });

  return new Response(stream, { status: 200, headers: SEC });
}
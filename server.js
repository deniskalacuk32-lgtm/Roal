import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin: (_o, cb) => cb(null, true),
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","Accept"],
  maxAge: 86400
}));
app.options("*", (_req, res) => res.sendStatus(200));

const PORT = process.env.PORT || 3000;

// === ENV ===
const {
  OPENAI_API_KEY,
  PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS,
  PROXY_SCHEME = "http",
  DISABLE_PROXY = "false"
} = process.env;

const useProxy = String(DISABLE_PROXY).toLowerCase() !== "true";
const scheme = (PROXY_SCHEME || "http").toLowerCase();
const proxyUrl = `${scheme}://${encodeURIComponent(PROXY_USER||"")}:${encodeURIComponent(PROXY_PASS||"")}@${PROXY_HOST}:${PROXY_PORT}`;
const agent = useProxy ? new HttpsProxyAgent(proxyUrl) : undefined;

const abort = (ms)=>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms); return {signal:c.signal, done:()=>clearTimeout(t)}; };

// === SYSTEM PROMPT (Roal) ===
const SYSTEM_PROMPT = `
Ты — «Менеджер Roal». Общайся кратко (1–3 предложения), дружелюбно и по делу. Цель — записать клиента на порошковую покраску дисков и взять телефон.

Что делаем:
• Полная порошковая покраска/реставрация, подготовка, пескоструй, грунт, запекание в печи. Дополнительно: правка геометрии, сварка трещин, полировка, шиномонтаж.
• Город: Ярославль (работаем по записи).

Воронка:
1) Поздоровайся, спроси имя.
2) Узнай марку/модель авто, радиус дисков (R15–R22), состояние и желаемый цвет/финиш.
3) Дай ориентир по цене (ниже) и уточни, что итог после осмотра.
4) Попроси удобный день/время и телефон для подтверждения записи.

Прайс за комплект (базовая покраска):
R15 — 11 000 ₽ · R16 — 12 000 ₽ · R17 — 13 000 ₽ · R18 — 14 000 ₽ · R19 — 15 000 ₽ · R20 — 17 000 ₽ · R21 — 18 000 ₽ · R22 — 19 000 ₽
Шиномонтаж: легковые — 2 500 ₽, внедорожники — 3 000 ₽.
Если не назвали радиус — уточни его.

Правила:
• Не давай ссылки. Всегда предлагай запись и проси телефон.
• Сроки обычно 1–2 дня (по очереди и допработам).
• Отвечай на вопросы кратко и возвращай к записи/телефону.
`;

// ===== helpers =====
function mapMessageToResponsesItem(m){
  // user/system -> input_text; assistant -> output_text
  const isAssistant = (m.role === "assistant");
  const type = isAssistant ? "output_text" : "input_text";
  return {
    role: m.role,
    content: [{ type, text: String(m.content ?? "") }]
  };
}

// === HEALTH ===
app.get("/", (_req,res)=>res.send("ok"));
app.get("/__version", (_req,res)=>res.send("roal-fast-12s ✅"));
app.get("/health", (_req,res)=>res.json({
  ok:true, version:"roal-fast-12s", port:PORT,
  proxy:{ enabled:useProxy, scheme, host:PROXY_HOST, port:PROXY_PORT, user:!!PROXY_USER },
  openaiKeySet: !!OPENAI_API_KEY
}));

// === обычный (non-stream) — одна попытка, быстрый таймаут 12с ===
app.post("/api/chat", async (req,res)=>{
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if(!OPENAI_API_KEY) return res.status(500).json({ error:"OPENAI_API_KEY not configured" });

  const normalized = [{ role:"system", content:SYSTEM_PROMPT }, ...msgs];
  const input = normalized.map(mapMessageToResponsesItem);

  async function callOnce(timeoutMs){
    const {signal,done}=abort(timeoutMs);
    try{
      const r = await fetch("https://api.openai.com/v1/responses",{
        method:"POST",
        headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
        agent,
        body: JSON.stringify({ model:"gpt-4o-mini-2024-07-18", input, max_output_tokens:120 }),
        signal
      });
      const txt = await r.text().catch(()=> ""); done();
      if(!r.ok) console.error("OpenAI error", r.status, txt.slice(0,400));
      return { ok:r.ok, status:r.status, ct: r.headers.get("content-type")||"application/json", txt };
    }catch(e){
      done(); 
      return { ok:false, status:504, ct:"application/json", txt: JSON.stringify({ error:"timeout_or_network", details:String(e) }) };
    }
  }

  const resp = await callOnce(12000); // <= укладываемся в фронтовые ~22с
  res.status(resp.status).type(resp.ct).send(resp.txt);
});

// === STREAM (SSE) — общий таймаут 20с ===
app.post("/api/chat-stream", async (req, res) => {
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const normalized = [{ role: "system", content: SYSTEM_PROMPT }, ...msgs];
  const input = normalized.map(mapMessageToResponsesItem);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const { signal, done } = abort(20000);

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      agent,
      body: JSON.stringify({
        model: "gpt-4o-mini-2024-07-18",
        input,
        max_output_tokens: 120,
        stream: true
      }),
      signal
    });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(()=> "");
      res.write(`data: ${JSON.stringify({ type:"response.error", message:`HTTP ${upstream.status}: ${txt}` })}\n\n`);
      return res.end();
    }

    for await (const chunk of upstream.body) res.write(chunk);
    done();
    res.end();
  } catch (e) {
    done();
    res.write(`data: ${JSON.stringify({ type:"response.error", message:String(e?.message || e) })}\n\n`);
    res.end();
  }
});

// совместимость (если фронт стучит на "/")
app.post("/", (req,res)=>{ req.url="/api/chat"; app._router.handle(req,res,()=>{}); });

app.listen(PORT, ()=>console.log(`✅ Roal server (fast 12s) on ${PORT}`));

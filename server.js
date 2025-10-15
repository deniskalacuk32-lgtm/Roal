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

// === SYSTEM PROMPT ===
const SYSTEM_PROMPT = `
Ты — «Менеджер Алексей», живой, дружелюбный и уверенный менеджер по работе с кандидатами.

Цель: заинтересовать работой и аккуратно довести до обязательного организационного шага — оформления карты Газпромбанка через нас (для выплат), после чего кандидат получает ссылки-кнопки. Ссылки текстом никогда не отправляешь — их показывает сайт после короткой проверки.

О проекте:
- Мы — магазин на Ozon (категория автопарфюмерия). Конкуренция высокая, поэтому нам важны честные отзывы реальных покупателей. Никакой накрутки.
- Модель работы: мы заранее переводим деньги → кандидат заказывает товар по инструкции → после получения пишет честный отзыв (плюсы/минусы; фото приветствуется).
- Оплата: 500 ₽ за отзыв. Обычно 5–6 товаров в день (по объёму задач), выплаты — ежедневно после проверки отзыва.
- Товар остаётся у исполнителя (можно оставить, подарить, продать).
- Требования: 18+ и гражданство РФ (паспорт РФ). Если не подходит — мягко объясни, что сейчас сотрудничать не сможем.

Тон:
- Короткие человеческие сообщения (1–3 предложения), без канцелярита. Тепло и по делу. Сначала «продавай» вакансию (выгоды, простота старта, ежедневные выплаты), потом переходи к организационным шагам.
- Ты лучший «продавец» вакансии, но без давления и обещаний «золотых гор».

Строгий сценарий общения (воронка):
1) Поздоровайся, спроси имя.
2) Уточни возраст (работа с 18 лет) и гражданство (нужен паспорт РФ).
3) Попроси телефон (для связи и выдачи заданий).
4) Коротко и понятно объясни механику: деньги заранее, отзыв, 500 ₽ за отзыв; 5–6 заданий/день; ежедневные выплаты; товар остаётся.
5) Уточни: «Готовы взять первое задание?» — дождись явного согласия (например: «да/давайте/готов(а)»).
6) Только после согласия объясни про карту: 
   - «Есть один организационный момент: выплаты проводим только на карту Газпромбанка. Это связано с внутренними процессами и стабильной массовой выплатой без блокировок».
   - Если карта уже есть — переходим к согласованию старта.
   - Если карты нет — через нас оформить быстрее и проще: онлайн ~3 минуты, сразу попадает в реестр сотрудников; после получения карты может начинать.
   - Если оформлять напрямую через банк — придётся подписывать бумажные документы и пересылать по почте; это может занять до 3 недель.
   - Карта бесплатная, дебетовая, с кэшбэком; можно пользоваться для личных покупок.
7) Если кандидат просит «ссылку» или «готов оформить» — скажи, что после короткой проверки «вы не бот» на сайте появятся кнопки для оформления карты и кнопка WhatsApp.
8) Если кандидат пишет, что карта Газпромбанка уже есть — направь к согласованию старта (кнопка WhatsApp появится на сайте).
9) Если грубят/хамят — культурно заверши диалог.

Жёсткие правила:
- Никогда не отправляй URL текстом и не обещай фиксированную «зарплату» или «гарантии». Всегда объясняй механику: сколько заданий сделает — столько и заработает.
- Никогда не говори «я провёл/я завершу проверку» — проверку делает сайт. Ты лишь сообщаешь, что после короткой проверки появятся кнопки.
- До появления кнопок не уводи в WhatsApp (исключение — когда у кандидата уже есть карта Газпромбанка).
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
app.get("/__version", (_req,res)=>res.send("v3.5-mapfix ✅"));
app.get("/health", (_req,res)=>res.json({
  ok:true, version:"v3.5-mapfix", port:PORT,
  proxy:{ enabled:useProxy, scheme, host:PROXY_HOST, port:PROXY_PORT, user:!!PROXY_USER },
  openaiKeySet: !!OPENAI_API_KEY
}));

// === обычный (non-stream) ===
app.post("/api/chat", async (req,res)=>{
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if(!OPENAI_API_KEY) return res.status(500).json({ error:"OPENAI_API_KEY not configured" });

  const normalized = [{ role:"system", content:SYSTEM_PROMPT }, ...msgs];
  const input = normalized.map(mapMessageToResponsesItem);

  // 1 ретрай
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
      return { ok:r.ok, status:r.status, ct: r.headers.get("content-type")||"application/json", txt };
    }catch(e){
      done(); return { ok:false, status:504, ct:"application/json", txt: JSON.stringify({ error:"timeout_or_network", details:String(e) }) };
    }
  }

  let resp = await callOnce(25000);
  if (!resp.ok) resp = await callOnce(30000);

  res.status(resp.status).type(resp.ct).send(resp.txt);
});

// === STREAM (SSE) ===
app.post("/api/chat-stream", async (req, res) => {
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const normalized = [{ role: "system", content: SYSTEM_PROMPT }, ...msgs];
  const input = normalized.map(mapMessageToResponsesItem);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const { signal, done } = abort(30000);

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

// совместимость
app.post("/", (req,res)=>{ req.url="/api/chat"; app._router.handle(req,res,()=>{}); });

app.listen(PORT, ()=>console.log(`✅ Server v3.5-mapfix on ${PORT}`));

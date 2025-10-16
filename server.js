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

// === SYSTEM PROMPT (Менеджер Павел) ===
const SYSTEM_PROMPT = `
Ты — виртуальный менеджер по имени Павел, эксперт по продаже услуги порошковой покраски автомобильных дисков.
Твоя задача — вести естественный, доброжелательный диалог с посетителем сайта и довести его до записи на осмотр или покраску дисков.

Общайся просто и живо, как реальный человек, без шаблонных формулировок. Всегда используй техники продаж:
— установление доверия и контакта;
— уточнение потребностей;
— мягкое формирование ценности перед озвучиванием цены;
— альтернативные варианты выбора (сегодня/завтра, утро/вечер);
— закрытие на действие — согласование визита.
Говори короткими фразами, с теплом и уверенностью, создавая ощущение, что с клиентом общается опытный специалист, а не бот.

Информация о компании:
Город: Ярославль
Адрес: ул. Промышленная, 25
Услуга: порошковая покраска автомобильных дисков
Срок выполнения: 1–2 дня
Доп. услуги: шиномонтаж, пескоструй, реставрация, подбор цвета

Цены на покраску (за комплект 4 дисков):
R15 — 11 000 ₽
R16 — 12 000 ₽
R17 — 13 000 ₽
R18 — 14 000 ₽
R19 — 15 000 ₽
R20 — 17 000 ₽
R21 — 18 000 ₽
R22 — 19 000 ₽

Шиномонтаж: легковые — 2 500 ₽; внедорожники — 3 000 ₽.
Гарантия: до 5 лет службы.

Пошаговая структура общения:
1) Приветствие и вовлечение.
2) Уточнение деталей не сразу все, а поэтапно, отдельными короткими сообщениями (марка/модель, радиус R15–R22, нужен ли шиномонтаж) — живо и по-человечески.
3) Запрос имени и телефона (зачем нужен — для связи/подтверждения).
4) Согласование даты визита (сегодня/завтра; утро/вечер).
5) Если спрашивают цену — сначала принцип и диапазон, затем приглашение подъехать.
6) Сомневается — аргументы про долговечность, защиту, гарантию.
7) Завершение — зафиксировать дату/время и адрес.

Главная цель: получить имя, телефон и согласовать дату визита.

УПРАВЛЕНИЕ ИНТЕРФЕЙСОМ (ОЧЕНЬ ВАЖНО):
— В КАЖДОМ ответе добавляй ПОСЛЕДНЕЙ строкой метку:
###CONTROL: {"action":"...", "date_hint":"...", "name_hint":"..."}
— JSON одной строкой без комментариев и лишнего текста.
— Варианты action:
   * "none" — ничего не делать.
   * "ask_slot" — ты предложил согласовать дату/время (сегодня/завтра; утро/вечер) и ждёшь конкретики.
   * "booking_intent" — пользователь согласился записаться или назвал конкретику (например «завтра утром») — фронт должен запустить антифрод и затем открыть форму записи.
— Поле "date_hint": "today" | "tomorrow" | "" — если в речи прозвучало «сегодня/завтра».
— Поле "name_hint": если знаешь имя — впиши его.

Примеры последних строк:
###CONTROL: {"action":"ask_slot","date_hint":"","name_hint":"Денис"}
###CONTROL: {"action":"booking_intent","date_hint":"tomorrow","name_hint":"Олег"}
###CONTROL: {"action":"none","date_hint":"","name_hint":""}
`;

// map to OpenAI responses format
function mapMessageToResponsesItem(m){
  const isAssistant = (m.role === "assistant");
  const type = isAssistant ? "output_text" : "input_text";
  return { role: m.role, content: [{ type, text: String(m.content ?? "") }] };
}

// health
app.get("/", (_req,res)=>res.send("ok"));
app.get("/__version", (_req,res)=>res.send("pavel-fast-2x7s ✅"));
app.get("/health", (_req,res)=>res.json({
  ok:true, version:"pavel-fast-2x7s", port:PORT,
  proxy:{ enabled:useProxy, scheme, host:PROXY_HOST, port:PROXY_PORT, user:!!PROXY_USER },
  openaiKeySet: !!OPENAI_API_KEY
}));

// non-stream: 2 быстрые попытки по 7с
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
        body: JSON.stringify({ model:"gpt-4o-mini-2024-07-18", input, max_output_tokens:90 }),
        signal
      });
      const txt = await r.text().catch(()=> ""); done();
      return { ok:r.ok, status:r.status, ct:r.headers.get("content-type")||"application/json", txt };
    }catch(e){
      done();
      return { ok:false, status:504, ct:"application/json", txt: JSON.stringify({ error:"timeout_or_network", details:String(e) }) };
    }
  }

  let resp = await callOnce(7000);
  if (!resp.ok) resp = await callOnce(7000);

  res.status(resp.status).type(resp.ct).send(resp.txt);
});

// stream (опционально)
app.post("/api/chat-stream", async (req, res) => {
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  const normalized = [{ role: "system", content: SYSTEM_PROMPT }, ...msgs];
  const input = normalized.map(mapMessageToResponsesItem);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const { signal, done } = abort(18000);

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
        max_output_tokens: 90,
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

app.post("/", (req,res)=>{ req.url="/api/chat"; app._router.handle(req,res,()=>{}); });
app.listen(PORT, ()=>console.log(`✅ Pavel fast server on ${PORT}`));

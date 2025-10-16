// server.js
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

/* ==== ENV ==== */
const {
  OPENAI_API_KEY,
  PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS,
  PROXY_SCHEME = "http",
  DISABLE_PROXY = "false",

  // Telegram (можно задать в Render → Environment)
  TELEGRAM_BOT_TOKEN = "8429593653:AAE4xK1TYde0VPOKUuaqcnC6r6VZ2CEVxmo", // ⬅ временно
  TELEGRAM_CHAT_ID   = "1803810817",                                      // ⬅ ваш chat_id
  LEAD_FORWARD_URL   = "" // опционально — если хотите дублировать лид в Google Sheets/CRM
} = process.env;

const useProxy = String(DISABLE_PROXY).toLowerCase() !== "true";
const scheme = (PROXY_SCHEME || "http").toLowerCase();
const proxyUrl = `${scheme}://${encodeURIComponent(PROXY_USER||"")}:${encodeURIComponent(PROXY_PASS||"")}@${PROXY_HOST}:${PROXY_PORT}`;
const agent = useProxy ? new HttpsProxyAgent(proxyUrl) : undefined;

const abort = (ms)=>{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms); return {signal:c.signal, done:()=>clearTimeout(t)}; };

/* ==== SYSTEM PROMPT (с обработкой возражений и CONTROL) ==== */
const SYSTEM_PROMPT = `
Ты — виртуальный менеджер по имени Павел, эксперт по продаже услуги порошковой покраски автомобильных дисков.

Цель: естественным, доброжелательным диалогом довести посетителя до записи на осмотр/покраску.

Стиль: короткие живые фразы, тепло и уверенность, без канцелярита и шаблонов. Спрашивай по шагам, не вываливай всё сразу.

О компании:
— Город: Ярославль
— Адрес: ул. Промышленная, 25
— Услуги: порошковая покраска дисков + шиномонтаж, пескоструй, реставрация, подбор цвета
— Срок: 1–2 дня
— Гарантия: до 5 лет службы
— Цена за комплект (4 диска): R15 — 11 000 ₽; R16 — 12 000 ₽; R17 — 13 000 ₽; R18 — 14 000 ₽; R19 — 15 000 ₽; R20 — 17 000 ₽; R21 — 18 000 ₽; R22 — 19 000 ₽
— Шиномонтаж: легковые — 2 500 ₽; внедорожники — 3 000 ₽

Шаги общения:
1) Приветствие и вовлечение.
2) Уточнение деталей (поэтапно): марка/модель; радиус R15–R22; нужен ли шиномонтаж; цвет/состояние.
3) Попроси имя и телефон (объясни, что для связи/подтверждения).
4) Согласование даты/времени (сегодня/завтра; утро/вечер).
5) Если спрашивают цену — сначала принцип (за комплект), назови диапазон, затем пригласи подъехать/прислать фото.
6) Если человек согласен или пишет «давайте/готов/записаться» — считай это намерением записи.
7) Завершение: зафиксируй дату/время и адрес. Дай спокойную «точку опоры».

Возражения (обязательно отрабатывай мягко):
— «Подумать», «позже»: 1–2 аргумента (защита, долговечность), предложи короткий визит/осмотр; закрывающий вопрос («сегодня/завтра? утро/вечер?»).
— «Дорого»: печь+порошок+подготовка; стойкое покрытие, гарантия до 5 лет, ровная заводская фактура; предложи бюджетный цвет.
— «Долго»: срок 1–2 дня; согласуем удобный день; поможем с шиномонтажом.
— «Далеко»: удобный адрес/парковка; подберём окно без ожидания.

Главная цель: получить имя, телефон и согласовать визит.

УПРАВЛЕНИЕ ИНТЕРФЕЙСОМ:
— В КАЖДОМ ответе добавляй ПОСЛЕДНЕЙ строкой метку:
###CONTROL: {"action":"...", "date_hint":"...", "time_hint":"...", "name_hint":"..."}
— "action": "none" | "ask_slot" | "booking_intent" (считать словами «да/давайте/готов/записаться»).
— "date_hint": "today" | "tomorrow" | "".
— "time_hint": "HH:MM" (24h) или "morning"/"evening" или "".
— "name_hint": если известно имя — укажи.

Примеры:
###CONTROL: {"action":"ask_slot","date_hint":"","time_hint":"","name_hint":"Денис"}
###CONTROL: {"action":"booking_intent","date_hint":"tomorrow","time_hint":"14:00","name_hint":"Олег"}
###CONTROL: {"action":"booking_intent","date_hint":"","time_hint":"","name_hint":""}
`;

/* ===== helpers ===== */
function mapMessageToResponsesItem(m){
  const isAssistant = (m.role === "assistant");
  const type = isAssistant ? "output_text" : "input_text";
  return { role: m.role, content: [{ type, text: String(m.content ?? "") }] };
}

/* ===== HEALTH ===== */
app.get("/", (_req,res)=>res.send("ok"));
app.get("/__version", (_req,res)=>res.send("roal-v3-objections+lead ✅"));
app.get("/health", (_req,res)=>res.json({
  ok:true, version:"roal-v3-objections+lead", port:PORT,
  proxy:{ enabled:useProxy, scheme, host:PROXY_HOST, port:PROXY_PORT, user:!!PROXY_USER },
  openaiKeySet: !!OPENAI_API_KEY
}));

/* ===== CHAT (non-stream) ===== */
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
        body: JSON.stringify({
          model: "gpt-4o-mini-2024-07-18",
          input,
          max_output_tokens: 260,
          temperature: 0.9
        }),
        signal
      });
      const txt = await r.text().catch(()=> ""); done();
      return { ok:r.ok, status:r.status, ct: r.headers.get("content-type")||"application/json", txt };
    }catch(e){
      done();
      return { ok:false, status:504, ct:"application/json",
        txt: JSON.stringify({ error:"timeout_or_network", details:String(e) }) };
    }
  }

  let resp = await callOnce(25000);
  if (!resp.ok) resp = await callOnce(30000);

  res.status(resp.status).type(resp.ct).send(resp.txt);
});

/* ===== ЛИДЫ: /lead ===== */
app.post("/lead", async (req, res)=>{
  try{
    const p = req.body || {};
    const name  = String(p.name||"").trim();
    const phone = String(p.phone||"").trim();
    const date  = String(p.date||"").trim();
    const time  = String(p.time||"").trim();
    const note  = String(p.note||"").trim();
    const source= String(p.source||"web").trim();
    const createdAt = String(p.createdAt||new Date().toISOString());

    if(!name || !phone || !date){
      return res.status(400).json({ ok:false, error:"name/phone/date required" });
    }

    // Telegram
    let tgOk = false, tgResp = null;
    if(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID){
      const text =
`🆕 Заявка на покраску дисков
Имя: ${name}
Телефон: ${phone}
Дата: ${date}${time?`\nВремя: ${time}`:''}${note?`\nКомментарий: ${note}`:''}
Источник: ${source}
Создано: ${createdAt}`;
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      const r = await fetch(url,{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
      });
      tgOk = r.ok;
      tgResp = await r.text().catch(()=>null);
    }

    // Доп. форвард (если задан)
    let fwdOk = false, fwdResp = null;
    if(LEAD_FORWARD_URL){
      const r = await fetch(LEAD_FORWARD_URL,{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(p)
      });
      fwdOk = r.ok;
      fwdResp = await r.text().catch(()=>null);
    }

    return res.json({ ok:true, telegram: tgOk, tgResp, forward: fwdOk, fwdResp });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

/* ===== совместимость ===== */
app.post("/", (req,res)=>{ req.url="/api/chat"; app._router.handle(req,res,()=>{}); });

app.listen(PORT, ()=>console.log(`✅ Server roal-v3-objections+lead on ${PORT}`));

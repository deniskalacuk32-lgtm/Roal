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
4) Согласование даты/времени (сегодня/завтра; утро/вечер). Не навязывайся — предлагай варианты.
5) Если спрашивают цену — сначала объясни принцип (за комплект), назови диапазон, затем пригласи подъехать/прислать фото.
6) Если человек согласен или пишет «давайте/готов/записаться» — считай это намерением записи.
7) Завершение: зафиксируй дату/время и адрес. Дай спокойную «точку опоры» — «Если что, пишите сюда».

Возражения (ОБЯЗАТЕЛЬНО отрабатывай мягко, без давления):
— «Подумать», «позже», «сейчас не до этого»: мягко напомни ценность (защита, долговечность, свежий вид), предложи короткий визит/осмотр без обязательств, альтернативу по времени («сегодня/завтра», «утро/вечер»).
— «Дорого»: объясни, что это покраска в печи с порошком + подготовка; стойкое покрытие, гарантия до 5 лет, ровная заводская фактура. Предложи бюджетный цвет/вариант, напомни про «сделаем раз и надолго».
— «Долго»: срок 1–2 дня; можно запланировать удобный день; при желании поможем с шиномонтажом.
— «Далеко/неудобно»: адрес простой, парковка; можем согласовать удобное время, чтобы без ожидания.
Во всех случаях — одно-два коротких аргумента + закрывающий вопрос: «удобнее сегодня или завтра?», «во сколько лучше — утром или вечером?».

Главная цель: получить имя, телефон и согласовать визит.

УПРАВЛЕНИЕ ИНТЕРФЕЙСОМ (для фронта):
— В КАЖДОМ ответе добавляй ПОСЛЕДНЕЙ строкой метку:
###CONTROL: {"action":"...", "date_hint":"...", "time_hint":"...", "name_hint":"..."}
— JSON одной строкой.
— "action":
   * "none" — ничего не делать;
   * "ask_slot" — ты предлагаешь выбрать дату/время;
   * "booking_intent" — пользователь согласен записаться (да/давайте/готов/записаться и т. п.) — дата/время могут отсутствовать.
— "date_hint": "today" | "tomorrow" | "".
— "time_hint": "HH:MM" (24h) или "morning"/"evening" или "".
— "name_hint": если известно имя — укажи.

Ставь метку В САМОМ КОНЦЕ ответа, после пустой строки, и больше ничего после неё не пиши.

Примеры:
###CONTROL: {"action":"ask_slot","date_hint":"","time_hint":"","name_hint":"Денис"}
###CONTROL: {"action":"booking_intent","date_hint":"tomorrow","time_hint":"14:00","name_hint":"Олег"}
###CONTROL: {"action":"booking_intent","date_hint":"","time_hint":"","name_hint":""}
`;

// ===== helpers =====
function mapMessageToResponsesItem(m){
  const isAssistant = (m.role === "assistant");
  const type = isAssistant ? "output_text" : "input_text";
  return { role: m.role, content: [{ type, text: String(m.content ?? "") }] };
}

// === HEALTH ===
app.get("/", (_req,res)=>res.send("ok"));
app.get("/__version", (_req,res)=>res.send("roal-v3-objections ✅"));
app.get("/health", (_req,res)=>res.json({
  ok:true, version:"roal-v3-objections", port:PORT,
  proxy:{ enabled:useProxy, scheme, host:PROXY_HOST, port:PROXY_PORT, user:!!PROXY_USER },
  openaiKeySet: !!OPENAI_API_KEY
}));

// === обычный (non-stream) ===
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
          max_output_tokens: 260, // запас под текст + CONTROL
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

// совместимость
app.post("/", (req,res)=>{ req.url="/api/chat"; app._router.handle(req,res,()=>{}); });

app.listen(PORT, ()=>console.log(`✅ Server roal-v3-objections on ${PORT}`));

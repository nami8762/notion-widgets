// 毎朝7時(JST)に「今日の予定」をLINE＋ntfy(iPhone)へ送る。
// 必要な環境変数(GitHub Secrets): NOTION_TOKEN, NOTION_DB_ID, LINE_TOKEN, NTFY_TOPIC
// Fable5非依存。GitHub Actions(無料)で自動実行。

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID || "98063bbe276d4ec08969215567a1f5b2"; // 📅予定 DB
const LINE_TOKEN = process.env.LINE_TOKEN;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const pad = (n) => String(n).padStart(2, "0");

// JSTの今日・明日(YYYY-MM-DD)
function jstDates() {
  const now = new Date(Date.now() + 9 * 60 * 60000);
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1, d = now.getUTCDate();
  const today = `${y}-${pad(m)}-${pad(d)}`;
  const t2 = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrow = `${t2.getUTCFullYear()}-${pad(t2.getUTCMonth() + 1)}-${pad(t2.getUTCDate())}`;
  const wd = ["日", "月", "火", "水", "木", "金", "土"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { today, tomorrow, label: `${m}月${d}日(${wd})` };
}

function plain(rt) { return (rt || []).map((t) => t.plain_text).join(""); }

// 今朝の天気（無料のOpen-Meteo・APIキー不要・天気ウィジェットと同じ高知）。
// 取得できなければ空文字を返す（通知は天気なしで続行）。
async function fetchWeather() {
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=33.5597&longitude=133.5311"
      + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
      + "&timezone=Asia%2FTokyo&forecast_days=1";
    const res = await fetch(url);
    if (!res.ok) return "";
    const d = (await res.json()).daily;
    const code = d.weather_code[0];
    const tmax = Math.round(d.temperature_2m_max[0]);
    const tmin = Math.round(d.temperature_2m_min[0]);
    const pop = d.precipitation_probability_max[0];
    // WMO天気コード → 絵文字＋日本語
    const wmo = (c) => {
      if (c === 0) return "☀️ 快晴";
      if (c <= 2) return "🌤 晴れ";
      if (c === 3) return "☁️ くもり";
      if (c <= 48) return "🌫 霧";
      if (c <= 67) return "🌧 雨";
      if (c <= 77) return "🌨 雪";
      if (c <= 82) return "🌧 にわか雨";
      if (c <= 86) return "🌨 にわか雪";
      return "⛈ 雷雨";
    };
    return `今日の天気：${wmo(code)}／${tmin}〜${tmax}℃／降水確率${pop ?? "?"}%`;
  } catch (e) {
    return "";
  }
}

async function fetchTodayEvents() {
  const { today, tomorrow } = jstDates();
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: {
        and: [
          { property: "日時", date: { on_or_after: `${today}T00:00:00+09:00` } },
          { property: "日時", date: { before: `${tomorrow}T00:00:00+09:00` } },
        ],
      },
      sorts: [{ property: "日時", direction: "ascending" }],
    }),
  });
  if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.results.map((p) => {
    const pr = p.properties;
    const start = pr["日時"]?.date?.start || "";
    let time = "";
    if (start.includes("T")) {
      const dt = new Date(start);
      time = `${pad((dt.getUTCHours() + 9) % 24)}:${pad(dt.getUTCMinutes())}`;
    }
    return {
      time,
      title: plain(pr["予定"]?.title),
      kind: pr["種類"]?.select?.name || "",
      who: plain(pr["誰と"]?.rich_text),
      place: plain(pr["場所"]?.rich_text),
      meet: plain(pr["集合時間"]?.rich_text),
      mainStart: plain(pr["開始・本番"]?.rich_text),
      rain: plain(pr["雨天時"]?.rich_text),
      items: plain(pr["持ち物"]?.rich_text),
      memo: plain(pr["メモ"]?.rich_text),
      link: pr["リンク"]?.url || "",
      check: pr["要確認"]?.checkbox || false,
    };
  });
}

// 1件分の本文を組み立てる。withLink=true なら末尾にリンク行を足す（LINE用）。
function eventLines(e, withLink) {
  let s = `${e.time ? "🕐 " + e.time + "  " : ""}${e.title}`;
  if (e.kind) s += `（${e.kind}）`;
  if (e.who) s += `\n　👤${e.who}`;
  if (e.meet) s += `\n　🕖集合 ${e.meet}`;
  if (e.mainStart) s += `\n　🏁${e.mainStart}`;
  if (e.rain) s += `\n　☔雨天時：${e.rain}`;
  if (e.place) s += `\n　📍${e.place}`;
  if (e.items) s += `\n　🎒${e.items}`;
  if (e.memo) s += `\n　📝${e.memo}`;
  if (e.check) s += `\n　⚠️要確認`;
  if (e.link) s += withLink ? `\n　🔗 ${e.link}` : `\n　💻 オンライン`;
  return s;
}

function buildMessage(events, label, withLink, weather) {
  const head = weather ? `${weather}\n` : "";
  if (!events.length) {
    return `${head}今日 ${label} は予定なし`;
  }
  let msg = `${head}今日 ${label} の予定\n`;
  for (const e of events) msg += `\n${eventLines(e, withLink)}\n`;
  return msg.trim();
}

async function sendLine(text) {
  if (!LINE_TOKEN) { console.log("LINE_TOKEN未設定→スキップ"); return; }
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: { "Authorization": `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ type: "text", text }] }),
  });
  console.log(`LINE: ${res.status} ${res.ok ? "OK" : await res.text()}`);
}

// ntfyはJSON送信（ヘッダーだと日本語が文字化けエラーになるため）。
// リンクのある予定は通知に「参加」ボタンを付ける（最大3つまで）。
async function sendNtfy(text, label, events) {
  if (!NTFY_TOPIC) { console.log("NTFY_TOPIC未設定→スキップ"); return; }
  const actions = events
    .filter((e) => e.link)
    .slice(0, 3)
    .map((e) => ({ action: "view", label: `参加: ${e.title}`.slice(0, 36), url: e.link }));
  const res = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: `今日の予定 ${label}`,
      message: text,
      tags: ["calendar"],
      ...(actions.length ? { actions } : {}),
    }),
  });
  console.log(`ntfy: ${res.status} ${res.ok ? "OK" : await res.text()}`);
}

(async () => {
  const { label } = jstDates();
  const [events, weather] = await Promise.all([fetchTodayEvents(), fetchWeather()]);
  const lineText = buildMessage(events, label, true, weather);   // LINE: リンクを1行表示
  const ntfyText = buildMessage(events, label, false, weather);  // iPhone: リンクはボタンに
  console.log("---- LINE ----\n" + lineText + "\n--------------");
  await sendLine(lineText);
  await sendNtfy(ntfyText, label, events);
})().catch((e) => { console.error(e); process.exit(1); });

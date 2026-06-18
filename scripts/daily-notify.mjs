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
      place: plain(pr["場所"]?.rich_text),
      meet: plain(pr["集合時間"]?.rich_text),
      items: plain(pr["持ち物"]?.rich_text),
      check: pr["要確認"]?.checkbox || false,
    };
  });
}

function buildMessage(events, label) {
  if (!events.length) {
    return `☀️ おはようございます！\n今日 ${label} は予定なし。\nゆっくりいきましょう☕`;
  }
  let msg = `☀️ おはようございます！\n今日 ${label} の予定\n`;
  for (const e of events) {
    msg += `\n${e.time ? "🕐 " + e.time + "  " : ""}${e.title}`;
    if (e.kind) msg += `（${e.kind}）`;
    if (e.meet) msg += `\n　集合 ${e.meet}`;
    if (e.place) msg += `\n　📍${e.place}`;
    if (e.items) msg += `\n　🎒${e.items}`;
    if (e.check) msg += `\n　⚠️要確認`;
    msg += "\n";
  }
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

async function sendNtfy(text, label) {
  if (!NTFY_TOPIC) { console.log("NTFY_TOPIC未設定→スキップ"); return; }
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: { "Title": "Today's Schedule", "Tags": "calendar", "Content-Type": "text/plain; charset=utf-8" },
    body: text,
  });
  console.log(`ntfy: ${res.status} ${res.ok ? "OK" : await res.text()}`);
}

(async () => {
  const { label } = jstDates();
  const events = await fetchTodayEvents();
  const text = buildMessage(events, label);
  console.log("---- message ----\n" + text + "\n-----------------");
  await sendLine(text);
  await sendNtfy(text, label);
})().catch((e) => { console.error(e); process.exit(1); });

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const SUBMISSIONS_FILE = path.join(DATA_DIR, "submissions.jsonl");
const CHAT_FILE = path.join(DATA_DIR, "chats.jsonl");
const DATABASE_URL = process.env.DATABASE_URL || "";
let dbPool = null;
let dbReady = null;

fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const optionSignals = {
  A: ["安全感", "责任感", "主动修复", "证明自己"],
  B: ["认可需求", "观察等待", "压抑", "稳定需求"],
  C: ["自我价值", "控制感", "反复思考", "成就驱动"],
  D: ["抽离防御", "自由需求", "独特性", "被理解需求"]
};

const anchorQuestions = {
  Q8: "关系安全感",
  Q18: "关系竞争机制",
  Q20: "核心关系恐惧",
  Q24: "人生核心恐惧",
  Q27: "核心驱动力",
  Q31: "压力模式",
  Q37: "能量损耗来源"
};

const validationGroups = [
  { name: "安全感组", questions: ["Q8", "Q11", "Q18", "Q20"] },
  { name: "自我价值组", questions: ["Q16", "Q22", "Q26", "Q27", "Q30"] },
  { name: "责任感组", questions: ["Q9", "Q17", "Q22", "Q29", "Q30"] },
  { name: "控制感组", questions: ["Q4", "Q6", "Q23", "Q31"] },
  { name: "意义感组", questions: ["Q21", "Q24", "Q27", "Q28", "Q29"] },
  { name: "内耗组", questions: ["Q31", "Q37", "Q38", "Q40"] },
  { name: "靠近 VS 防御", questions: ["Q8", "Q11", "Q15", "Q18", "Q20"] },
  { name: "成长 VS 安全", questions: ["Q21", "Q23", "Q24", "Q27"] },
  { name: "表达 VS 压抑", questions: ["Q3", "Q12", "Q14", "Q33"] },
  { name: "自由 VS 责任", questions: ["Q4", "Q21", "Q24", "Q29", "Q30"] },
  { name: "认可 VS 自我实现", questions: ["Q22", "Q25", "Q27", "Q30"] }
];

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function appendJsonLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf-8");
}

function getDbPool() {
  if (!DATABASE_URL) return null;
  if (!dbPool) {
    const { Pool } = require("pg");
    dbPool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      ssl: { rejectUnauthorized: false }
    });
  }
  return dbPool;
}

async function ensureDb() {
  const pool = getDbPool();
  if (!pool) return null;
  if (!dbReady) {
    dbReady = pool.query(`
      create table if not exists submissions (
        session_id text primary key,
        created_at timestamptz not null,
        profile jsonb not null default '{}'::jsonb,
        answers jsonb not null,
        feedback jsonb,
        analysis jsonb not null
      );

      create table if not exists chats (
        id text primary key,
        created_at timestamptz not null,
        session_id text,
        message text not null
      );

      create index if not exists chats_session_id_idx on chats (session_id);
      create index if not exists submissions_created_at_idx on submissions (created_at desc);
    `);
  }
  await dbReady;
  return pool;
}

async function saveSubmission(record) {
  const pool = await ensureDb();
  if (!pool) {
    appendJsonLine(SUBMISSIONS_FILE, record);
    return;
  }

  await pool.query(
    `insert into submissions (session_id, created_at, profile, answers, feedback, analysis)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      record.sessionId,
      record.createdAt,
      JSON.stringify(record.profile || {}),
      JSON.stringify(record.answers || {}),
      record.feedback ? JSON.stringify(record.feedback) : null,
      JSON.stringify(record.analysis || {})
    ]
  );
}

async function saveChat(record) {
  const pool = await ensureDb();
  if (!pool) {
    appendJsonLine(CHAT_FILE, record);
    return;
  }

  await pool.query(
    `insert into chats (id, created_at, session_id, message)
     values ($1, $2, $3, $4)`,
    [record.id, record.createdAt, record.sessionId, record.message]
  );
}

function countOptions(answers, questions) {
  return questions.reduce((acc, q) => {
    const value = answers[q];
    if (value) acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function topEntries(score, limit = 3) {
  return Object.entries(score)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

function analyzeSubmission(answers) {
  const score = {};
  Object.values(answers).forEach(option => {
    (optionSignals[option] || []).forEach(signal => {
      score[signal] = (score[signal] || 0) + 1;
    });
  });

  const groupHits = validationGroups.map(group => {
    const counts = countOptions(answers, group.questions);
    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ["-", 0];
    return {
      name: group.name,
      dominantOption: dominant[0],
      strength: dominant[1],
      questions: group.questions
    };
  });

  const strongestGroups = groupHits
    .filter(group => group.strength >= 2)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 4);

  const topSignals = topEntries(score, 4);
  const title = buildTitle(topSignals, strongestGroups);
  const report = buildReport(title, topSignals, strongestGroups, answers);

  return {
    title,
    topSignals,
    strongestGroups,
    anchorAnswers: Object.fromEntries(Object.keys(anchorQuestions).map(q => [q, answers[q] || null])),
    report
  };
}

function buildTitle(topSignals, groups) {
  if (groups.some(g => g.name === "靠近 VS 防御")) return "《想靠近，却总在关键处保护自己的人》";
  if (groups.some(g => g.name === "成长 VS 安全")) return "《一边想往前走，一边需要确定感的人》";
  if (topSignals.includes("反复思考")) return "《习惯先把可能性想完再行动的人》";
  if (topSignals.includes("认可需求")) return "《一直在确认自己是否值得的人》";
  if (topSignals.includes("自由需求")) return "《渴望自由，也害怕失去方向的人》";
  return "《正在寻找自己运行逻辑的人》";
}

function buildReport(title, signals, groups, answers) {
  const mainSignal = signals[0] || "关系与价值判断";
  const defense = pickDefense(signals, answers);
  const conflict = groups.find(g => g.name.includes("VS"))?.name || "稳定自我 VS 外界反馈";
  const loop = pickLoop(groups, signals);

  return [
    `${title}`,
    "",
    `你的答案里最明显的不是某个单一性格，而是围绕“${mainSignal}”形成的一组选择习惯。你在做决定时，不只是看事情本身，也会很快评估这件事会不会影响关系、价值感或未来的安全边界。`,
    "",
    `真正值得注意的是防御方式。当前答案更像是“${defense}”：它能让你在压力里先稳住自己，但代价是问题可能不会立刻消失，而是被你放进更长的观察、解释或抽离过程里。`,
    "",
    `内部互搏初步指向“${conflict}”。这不是说你矛盾，而是你身上有两个都真实的需求：一个想推进、靠近或证明；另一个需要确认、保护或保留退路。很多卡点不是能力不足，而是这两个需求长期同时在线。`,
    "",
    `可能的长期循环是：${loop}。后续如果继续深入聊天，最有价值的不是重复判断你准不准，而是追问这个循环最早从哪里开始、在哪类关系或选择里最常复现。`,
    "",
    "本报告是 MVP 初版分析，只基于 40 题答案生成。更准确的数字人格档案需要结合追问、真实案例和用户反馈继续校正。"
  ].join("\n");
}

function pickDefense(signals, answers) {
  if (signals.includes("抽离防御")) return "先拉开距离，避免继续被消耗";
  if (signals.includes("控制感")) return "不断确认和计划，让不确定性变得可控";
  if (signals.includes("压抑")) return "表面维持正常，把情绪留到后面处理";
  if (answers.Q33 === "A") return "通过表达和连接让情绪恢复流动";
  return "先观察，再决定是否继续投入";
}

function pickLoop(groups, signals) {
  if (groups.some(g => g.name === "安全感组")) return "靠近重要关系，等待确认，感到不确定，再开始观察或退后";
  if (groups.some(g => g.name === "内耗组")) return "想清楚再行动，行动前消耗过多，结果变慢，又进一步怀疑自己";
  if (signals.includes("认可需求")) return "努力获得认可，短暂确认价值，然后又进入下一轮证明";
  return "发现问题，尝试解释，获得暂时答案，但在下一次相似情境里重新被触发";
}

function nextPrompt(analysis) {
  const group = analysis.strongestGroups.find(g => g.name.includes("VS"))?.name || analysis.strongestGroups[0]?.name;
  if (group === "靠近 VS 防御") {
    return "我想继续确认一件事：你通常是在关系刚变重要时开始退后，还是在失望几次之后才退后？";
  }
  if (group === "成长 VS 安全") {
    return "我们可以继续看一个关键点：你犹豫时，更怕失败本身，还是更怕失败后证明自己不够好？";
  }
  if (group === "内耗组") {
    return "继续聊的话，我会先问：你最常是在开始前消耗，还是在已经投入之后反复怀疑值不值得？";
  }
  return "如果继续深入，我想先问：这份报告里哪一句最像你，哪一句你觉得不太像？";
}

function validateAnswers(answers) {
  const missing = [];
  for (let i = 1; i <= 40; i += 1) {
    const key = `Q${i}`;
    if (!["A", "B", "C", "D"].includes(answers[key])) missing.push(key);
  }
  return missing;
}

async function handleApi(req, res) {
  try {
    if (req.method === "POST" && req.url === "/api/submit") {
      const payload = await readJson(req);
      const answers = payload.answers || {};
      const missing = validateAnswers(answers);
      if (missing.length) return send(res, 400, { error: "missing_answers", missing });

      const sessionId = crypto.randomUUID();
      const analysis = analyzeSubmission(answers);
      const record = {
        sessionId,
        createdAt: new Date().toISOString(),
        profile: payload.profile || {},
        answers,
        feedback: payload.feedback || null,
        analysis
      };
      await saveSubmission(record);
      return send(res, 200, { sessionId, analysis, nextQuestion: nextPrompt(analysis) });
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      const payload = await readJson(req);
      const record = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        sessionId: payload.sessionId || null,
        message: String(payload.message || "").slice(0, 4000)
      };
      await saveChat(record);
      return send(res, 200, {
        reply: "收到。MVP 版已经把这条追问保存到样本里。正式 AI 深聊会基于你的 40 题答案、初版报告和这条补充内容继续交叉验证。"
      });
    }

    return send(res, 404, { error: "not_found" });
  } catch (error) {
    return send(res, 500, { error: "server_error", message: error.message });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = urlPath === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, urlPath);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");

  fs.readFile(normalized, (error, data) => {
    if (error) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    send(res, 200, data, MIME[path.extname(normalized)] || "application/octet-stream");
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`LingGe MVP running at http://localhost:${PORT}`);
});

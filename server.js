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
  A: ["主动表达", "责任感", "修复关系", "安全感"],
  B: ["观察等待", "稳定需求", "压抑感受", "边界试探"],
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
  { name: "关系安全感", questions: ["Q8", "Q11", "Q18", "Q20"] },
  { name: "自我价值", questions: ["Q16", "Q22", "Q26", "Q27", "Q30"] },
  { name: "责任与边界", questions: ["Q9", "Q17", "Q22", "Q29", "Q30"] },
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
  if (Buffer.isBuffer(body)) {
    res.end(body);
    return;
  }
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
  const names = groups.map(g => g.name);
  if (names.includes("表达 VS 压抑") && topSignals.includes("压抑感受")) return "《外表稳住，心里其实一直在消化的人》";
  if (names.includes("靠近 VS 防御") && topSignals.includes("抽离防御")) return "《很在意关系，但会用后退保护自己的人》";
  if (names.includes("成长 VS 安全") && topSignals.includes("自我价值")) return "《想证明自己，也需要确定感托底的人》";
  if (topSignals.includes("反复思考")) return "《先在心里演算很多遍，才真正行动的人》";
  if (topSignals.includes("自由需求")) return "《不想被困住，也不想失去方向的人》";
  return "《正在看清自己底层运行方式的人》";
}

function buildReport(title, signals, groups, answers) {
  const groupNames = groups.map(g => g.name);
  const dominantGroups = groups
    .slice(0, 3)
    .map(g => `${g.name}(${g.dominantOption}/${g.strength})`)
    .join("、") || "暂未形成特别集中的模式";
  const relation = relationPattern(answers);
  const value = valuePattern(answers);
  const pressure = pressurePattern(answers);
  const conflict = conflictPattern(groupNames, signals, answers);
  const risk = riskPattern(answers, signals, groupNames);
  const suggestion = suggestionPattern(answers, signals);

  return [
    title,
    "",
    "【一句话画像】",
    `你不是一个简单的“外向/内向”类型，更像是一个会先判断关系安全、责任边界和自我价值是否稳住的人。当前最集中的线索是：${dominantGroups}。`,
    "",
    "【关系模式】",
    relation,
    "",
    "【价值驱动】",
    value,
    "",
    "【压力与防御】",
    pressure,
    "",
    "【内部拉扯】",
    conflict,
    "",
    "【容易卡住的地方】",
    risk,
    "",
    "【下一步建议】",
    suggestion,
    "",
    "这不是最终人格定论，而是一份基于 40 道选择题生成的初版结构画像。真正有价值的部分，是拿它去对照你最近的一段关系、一个选择或一次压力反应，看哪些句子准确，哪些句子需要被修正。"
  ].join("\n");
}

function relationPattern(answers) {
  const fearMap = {
    A: "你在亲密关系里最怕的是被忽视。比起直接冲突，你更容易被“对方没有回应、热度下降、没有把你放在心上”这类细节触发。",
    B: "你在亲密关系里最怕的是被控制。你需要亲近，但也需要保留自己的节奏和选择权。",
    C: "你在亲密关系里最怕的是被背叛。你对关系里的排他性、承诺和可靠性会比较敏感。",
    D: "你在亲密关系里最怕的是不被理解。你不是只要陪伴，而是希望对方真的懂你的感受和内在逻辑。"
  };
  const responseMap = {
    A: "你更倾向主动确认和修复，问题出现时会想尽快说清楚。",
    B: "你更倾向先观察，不急着摊牌，但心里会持续评估对方的变化。",
    C: "你容易在心里反复消化，表面未必说很多，但情绪会留得比较久。",
    D: "你会用距离保护自己，尤其在多次失望后，抽离会比争辩更自然。"
  };
  return `${fearMap[answers.Q20] || fearMap.D}${responseMap[answers.Q11] || responseMap.B}`;
}

function valuePattern(answers) {
  const driveMap = {
    A: "你的深层动力偏向“不想再被动”。你会被掌控人生、摆脱无力感、重新拿回主动权这类目标推动。",
    B: "你的深层动力偏向“被重要的人看见”。认可对你不是虚荣，而是一种确认自己没有白努力的方式。",
    C: "你的深层动力偏向“证明价值”。当你认真投入时，你很在意自己能不能做出结果、能不能被事实证明。",
    D: "你的深层动力偏向“活得舒服和自由”。你不太能长期忍受只为了标准答案而生活。"
  };
  const identityMap = {
    A: "你希望别人记住你的可靠和能托付。",
    B: "你希望别人承认你的能力和本事。",
    C: "你希望别人觉得你有意思、有特点，不只是普通地完成任务。",
    D: "你希望别人觉得你活得明白，有自己的判断。"
  };
  return `${driveMap[answers.Q27] || driveMap.C}${identityMap[answers.Q30] || ""}`;
}

function pressurePattern(answers) {
  const stressMap = {
    A: "压力越大，你越可能进入战斗模式，用行动把自己撑住。",
    B: "压力积累时，你更容易烦躁，对人和事的耐心下降。",
    C: "压力积累时，你外面可能还正常，但里面会越来越紧，像一直有东西没有放下。",
    D: "压力积累时，你容易拖住、回避，甚至暂时不想面对。"
  };
  const energyMap = {
    A: "你的能量常耗在“还没开始就想太多”。",
    B: "你的能量常耗在“太在意别人的状态和反应”。",
    C: "你的能量常耗在“知道该做，但启动困难”。",
    D: "你的能量常耗在“明知不值得，却还继续投入”。"
  };
  return `${stressMap[answers.Q31] || stressMap.C}${energyMap[answers.Q37] || ""}`;
}

function conflictPattern(groupNames, signals, answers) {
  if (groupNames.includes("自由 VS 责任")) {
    return "你身上有一个很明显的拉扯：一边想自由、不想被困住；另一边又不希望自己变成逃避责任的人。所以你真正难受的不是“要不要负责”，而是“我能不能在负责的同时不丢掉自己”。";
  }
  if (groupNames.includes("表达 VS 压抑")) {
    return "你可能不是不会表达，而是在判断表达有没有用、会不会造成更大的麻烦。很多情绪不是没有，而是被你先收起来了。";
  }
  if (groupNames.includes("靠近 VS 防御")) {
    return "你既需要关系，也会防御关系带来的不确定。越重要的人，越可能同时触发你的靠近和退后。";
  }
  if (signals.includes("反复思考")) {
    return "你会先在脑子里处理很多可能性，等自己觉得足够安全或足够确定，才比较容易行动。";
  }
  return "你目前的主要拉扯，不是能力不足，而是几个真实需求同时存在：想稳定、想被看见、想保留自由，也想证明自己。";
}

function riskPattern(answers, signals, groupNames) {
  if (answers.Q38 === "C" || answers.Q40 === "C") {
    return "最大的风险是把一次失败解释成“我这个人不够重要/不够好”。如果这个解释反复出现，你会越来越难启动，而不是越来越清醒。";
  }
  if (signals.includes("压抑感受") || answers.Q33 === "D") {
    return "最大的风险是太会维持表面正常。别人看不出来，你也会误以为自己已经处理好了，但情绪其实只是被延后了。";
  }
  if (groupNames.includes("责任与边界")) {
    return "最大的风险是把“可靠”做成一种长期消耗。你可能会先承担、先配合、先把事情稳住，但后面才发现自己已经不舒服很久了。";
  }
  return "最大的风险是把复杂感受压缩成一个简单判断：要么继续撑，要么直接撤。中间那段“说清楚、调边界、重新选择”的空间需要被练出来。";
}

function suggestionPattern(answers, signals) {
  if (answers.Q20 === "A" || answers.Q8 === "B" || answers.Q8 === "C") {
    return "接下来最值得练的是：当你感觉被忽视时，先把事实和解释分开。事实是“对方没有回”；解释可能是“我不重要”。报告真正要追问的是：你通常在哪一步开始把事实变成解释？";
  }
  if (signals.includes("反复思考")) {
    return "接下来最值得练的是：给思考设一个出口。比如只允许自己列三个可能性，然后做一个最小行动，而不是等完全想清楚才开始。";
  }
  if (answers.Q33 === "A") {
    return "接下来最值得保留的是你的表达能力，但表达前可以先确认一句：我现在是想解决问题，还是只是想让对方立刻安抚我？这会让沟通更有效。";
  }
  return "接下来最值得做的是拿一件最近的真实小事来复盘：当时你最先感到什么，随后做了什么，最后真正想保护的是什么。";
}

function nextPrompt(analysis) {
  const group = analysis.strongestGroups.find(g => g.name.includes("VS"))?.name || analysis.strongestGroups[0]?.name;
  if (group === "靠近 VS 防御") {
    return "我想继续确认一件事：你通常是在关系刚变重要时开始退后，还是在失望几次之后才退后？";
  }
  if (group === "成长 VS 安全") {
    return "我们可以继续看一个关键点：你犹豫时，更怕失败本身，还是更怕失败后证明自己不够好？";
  }
  if (group === "内耗") {
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

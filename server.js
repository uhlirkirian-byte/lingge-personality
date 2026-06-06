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
  const cognition = cognitionPattern(answers, signals);
  const value = valuePattern(answers);
  const action = actionPattern(answers, signals);
  const defense = defensePattern(answers, signals);
  const energy = energyPattern(answers, signals, groupNames);
  const relation = relationPattern(answers);
  const suggestion = suggestionPattern(answers, signals);

  return [
    title,
    "",
    "【一句话画像】",
    `你更像是一个“先校准内在秩序，再决定怎么行动”的人。你不是单纯外向或内向，而是会先判断：这件事是否安全、是否值得、是否符合自己的标准。当前最集中的线索是：${dominantGroups}。`,
    "",
    "【底层操作系统】",
    cognition,
    "",
    "【价值排序】",
    value,
    "",
    "【行动驱动】",
    action,
    "",
    "【防御机制】",
    defense,
    "",
    "【能量漏洞】",
    energy,
    "",
    "【关系只是其中一个触发器】",
    relation,
    "",
    "【下一步建议】",
    suggestion,
    "",
    "这不是最终人格定论，而是一份基于 40 道选择题生成的底层结构画像。它真正想回答的不是“你适合谁”，而是：你如何判断安全，如何确认价值，如何启动行动，又如何在压力下保护自己。"
  ].join("\n");
}

function cognitionPattern(answers, signals) {
  if (signals.includes("反复思考") || answers.Q32 === "B") {
    return "你的信息处理方式偏“内在演算型”：遇到不确定时，你会先在脑子里跑很多可能性，试图提前看见风险、后果和对方反应。优点是判断细、预判强；代价是启动会变慢，甚至还没行动就已经消耗了一轮。";
  }
  if (answers.Q31 === "A") {
    return "你的信息处理方式偏“压力驱动型”：越到关键时刻，越容易调动行动力。你不一定喜欢压力，但压力会让你的系统进入清晰、紧绷、可执行的状态。";
  }
  if (answers.Q4 === "A" || answers.Q23 === "A") {
    return "你的信息处理方式偏“秩序优先型”：面对变化时，你会先寻找可控点，先安排、先规划、先把不确定变成步骤。你需要的不是绝对安全，而是知道自己接下来能抓住什么。";
  }
  return "你的信息处理方式偏“情境校准型”：你不会只凭冲动决定，而是会先观察环境、关系、风险和自己的状态，再决定投入多少。";
}

function relationPattern(answers) {
  const fearMap = {
    A: "在关系里，你容易被“是否被放在心上”触发。",
    B: "在关系里，你对自主权和边界很敏感。",
    C: "在关系里，你会重视承诺、可靠性和一致性。",
    D: "在关系里，你真正需要的是被理解，而不只是被陪伴。"
  };
  const responseMap = {
    A: "你的第一反应通常是确认和修复。",
    B: "你的第一反应通常是观察和评估。",
    C: "你的第一反应通常是先压住、慢慢消化。",
    D: "你的第一反应通常是拉开距离，先保住自己。"
  };
  return `${fearMap[answers.Q20] || fearMap.D}${responseMap[answers.Q11] || responseMap.B}这里不是报告的中心，只是一个高频触发场景：关系会把你的安全感、价值感和防御方式更快地照出来。`;
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
  return `${driveMap[answers.Q27] || driveMap.C}${identityMap[answers.Q30] || ""}所以你的价值排序不是单纯“成功/轻松/被喜欢”，而是更关心：我有没有活成自己认可的样子。`;
}

function actionPattern(answers, signals) {
  const driveMap = {
    A: "你启动行动时，常常需要一个“不能再被动”的临界点。一旦你感觉自己不能再这样下去，行动力会明显上来。",
    B: "你启动行动时，常常需要一个“有人看见/有人期待”的外部确认。你不是没主见，而是反馈会帮你把能量调起来。",
    C: "你启动行动时，常常需要一个“我要证明”的目标。清晰的结果、能力感和胜负感会提高你的执行力。",
    D: "你启动行动时，常常需要一个“这是我真正想要的”的内在理由。没有意义感的任务，你很难长期靠自律硬撑。"
  };
  if (signals.includes("反复思考")) {
    return `${driveMap[answers.Q27] || driveMap.C}但你的行动系统有一个特点：想得越多，越需要一个很小的启动动作把系统从脑内切到现实。`;
  }
  return driveMap[answers.Q27] || driveMap.C;
}

function defensePattern(answers, signals) {
  if (answers.Q33 === "A") {
    return "你的防御机制不是完全封闭型。情绪上来时，你有把话说出来、把问题推到台面上的倾向。这个能力很好，但需要注意：表达是为了澄清真实需求，不只是为了立刻得到安抚。";
  }
  if (answers.Q33 === "B" || signals.includes("压抑感受")) {
    return "你的防御机制偏“内部消化型”：先不打扰别人，先自己处理。它能让你显得稳定，但也容易让别人低估你的压力。";
  }
  if (answers.Q33 === "D" || signals.includes("抽离防御")) {
    return "你的防御机制偏“抽离型”：当系统判断继续投入会受伤或失控时，你会先撤回能量。它能保护你，但也可能让你错过一些可以修正关系和局面的机会。";
  }
  return "你的防御机制偏“转移型”：难受时会先做点别的，让自己不要被情绪吞没。它有用，但真正的问题仍需要在情绪退潮后被处理。";
}

function energyPattern(answers, signals, groupNames) {
  const energyMap = {
    A: "你的能量常耗在“还没开始就想太多”。",
    B: "你的能量常耗在“太在意别人的状态和反应”。",
    C: "你的能量常耗在“知道该做，但启动困难”。",
    D: "你的能量常耗在“明知不值得，却还继续投入”。"
  };
  if (answers.Q31 === "C") {
    return `你的压力不一定会立刻爆出来，而是容易在内部越压越紧。${energyMap[answers.Q37] || ""}这说明真正消耗你的，往往不是事情本身，而是事情背后那套持续运行的解释和担心。`;
  }
  if (groupNames.includes("自由 VS 责任")) {
    return `${energyMap[answers.Q37] || ""}你还有一个明显消耗点：想自由，又不想变成不负责的人。真正需要调的不是责任感，而是边界。`;
  }
  return `${energyMap[answers.Q37] || ""}这部分是后续最值得追问的，因为一个人的能量花在哪里，通常比他嘴上说重视什么更能暴露底层逻辑。`;
}

function suggestionPattern(answers, signals) {
  if (answers.Q20 === "A" || answers.Q8 === "B" || answers.Q8 === "C") {
    return "接下来最值得追问的是：当外界没有给你回应时，你的大脑会自动补出什么解释？这个解释比事件本身更能说明你的底层安全感。";
  }
  if (signals.includes("反复思考")) {
    return "接下来最值得练的是给思考设一个出口：不是要求自己别想，而是每次想完都落到一个最小动作上。人格结构不是靠想明白改变的，而是靠新的行动证据慢慢重写。";
  }
  if (answers.Q33 === "A") {
    return "接下来最值得保留的是表达能力，同时把表达从“情绪出口”升级成“需求识别”：我到底需要确认、尊重、自由、结果，还是理解？";
  }
  return "接下来最值得做的是拿一件最近的真实小事复盘：当时你最先判断了什么，随后保护了什么，最后又牺牲了什么。这个顺序就是你的底层人格逻辑。";
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

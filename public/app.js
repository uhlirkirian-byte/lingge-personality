const questions = window.LINGGE_QUESTIONS;
const labels = ["A", "B", "C", "D"];
const form = document.querySelector("#quizForm");
const progressText = document.querySelector("#progressText");
const progressBar = document.querySelector("#progressBar");
const formMessage = document.querySelector("#formMessage");
const submitBtn = document.querySelector("#submitBtn");
const reportPanel = document.querySelector("#reportPanel");
let sessionId = null;

function sectionFor(index) {
  if (index < 10) return "第一阶段：社会互动系统";
  if (index < 20) return "第二阶段：关系系统";
  if (index < 30) return "第三阶段：价值系统";
  return "第四阶段：压力与互搏系统";
}

function renderQuestions() {
  let current = "";
  questions.forEach(([id, title, options], index) => {
    const section = sectionFor(index);
    if (section !== current) {
      current = section;
      const heading = document.createElement("h2");
      heading.textContent = section;
      form.appendChild(heading);
    }

    const card = document.createElement("fieldset");
    card.className = "question";
    const legend = document.createElement("legend");
    legend.innerHTML = `<span>${id}</span>${title}`;
    card.appendChild(legend);

    options.forEach((option, optionIndex) => {
      const value = labels[optionIndex];
      const label = document.createElement("label");
      label.className = "option";
      label.innerHTML = `
        <input type="radio" name="${id}" value="${value}">
        <span class="option-key">${value}</span>
        <span>${option}</span>
      `;
      card.appendChild(label);
    });
    form.appendChild(card);
  });
}

function collectAnswers() {
  return Object.fromEntries(questions.map(([id]) => {
    const checked = form.querySelector(`input[name="${id}"]:checked`);
    return [id, checked ? checked.value : ""];
  }));
}

function updateProgress() {
  const answered = Object.values(collectAnswers()).filter(Boolean).length;
  progressText.textContent = `${answered} / 40`;
  progressBar.style.width = `${(answered / 40) * 100}%`;
}

async function submitQuiz() {
  const answers = collectAnswers();
  const missing = Object.entries(answers).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    formMessage.textContent = `还差 ${missing.length} 题：${missing.slice(0, 8).join("、")}${missing.length > 8 ? "..." : ""}`;
    return;
  }

  submitBtn.disabled = true;
  formMessage.textContent = "正在生成报告...";
  const response = await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answers,
      profile: {
        ageRange: document.querySelector("#ageRange").value,
        currentIssue: document.querySelector("#currentIssue").value
      }
    })
  });
  const data = await response.json();
  submitBtn.disabled = false;

  if (!response.ok) {
    formMessage.textContent = "生成失败，请稍后再试。";
    return;
  }

  sessionId = data.sessionId;
  showReport(data);
  formMessage.textContent = "报告已生成，数据也已保存到后台样本。";
}

function showReport(data) {
  const { analysis, nextQuestion } = data;
  reportPanel.classList.remove("hidden");
  document.querySelector("#reportTitle").textContent = analysis.title;
  document.querySelector("#reportText").textContent = analysis.report;
  document.querySelector("#nextQuestion").textContent = nextQuestion;

  const chips = document.querySelector("#signalChips");
  chips.innerHTML = "";
  analysis.topSignals.forEach(signal => {
    const chip = document.createElement("span");
    chip.textContent = signal;
    chips.appendChild(chip);
  });
  reportPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function sendChat() {
  const input = document.querySelector("#chatInput");
  const message = input.value.trim();
  if (!message) return;
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message })
  });
  const data = await response.json();
  document.querySelector("#chatReply").textContent = data.reply || "已保存。";
  input.value = "";
}

renderQuestions();
updateProgress();
form.addEventListener("change", updateProgress);
submitBtn.addEventListener("click", submitQuiz);
document.querySelector("#chatBtn").addEventListener("click", sendChat);

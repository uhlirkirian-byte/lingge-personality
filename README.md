# 灵格人格结构采样 MVP

这是一个可部署到 Render 的零依赖 Node.js MVP。

## 当前能力

- 40 题人格结构采样问卷
- 答题进度显示
- 提交后即时生成初版人格结构报告
- 保存用户答案、基础资料、报告和结构分析到 `data/submissions.jsonl`
- 保存继续深入聊天内容到 `data/chats.jsonl`
- 预留后续接入真正 AI 深聊和数据库的接口

## 本地运行

```bash
npm start
```

打开：

```text
http://localhost:3000
```

当前环境如果没有全局 Node，可以使用 Codex bundled Node 运行：

```powershell
C:\Users\Lucy\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe server.js
```

## Render 部署

Render 新建 Web Service：

- Build Command：留空或填 `npm install`
- Start Command：`npm start`
- Environment：Node

如果用 `render.yaml`，Render 可以自动识别：

```yaml
services:
  - type: web
    name: lingge-personality-mvp
    env: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
```

## 数据说明

MVP 版先用 JSONL 文件沉淀样本：

- `data/submissions.jsonl`：每行一个问卷样本
- `data/chats.jsonl`：每行一条深入聊天记录

正式上线后建议替换为 PostgreSQL / Supabase / Neon，避免 Render 免费实例文件重启后丢失数据。

## 下一步建议

1. 接入数据库，稳定保存用户样本。
2. 接入真实 AI 报告生成和追问。
3. 增加用户反馈按钮：准、不准、最击中、不像我。
4. 增加后台样本查看页，方便人工迭代题目和报告逻辑。

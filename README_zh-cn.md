# Raid

[English](README.md) | [简体中文](README_zh-cn.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-1.2.0-3794ff)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)

Raid 是一款面向论文、教材和技术文档的轻量化项目式 AI 阅读器，集连续 PDF / 图片阅读、文字与跨页区域选择、OCR、Markdown 笔记、持久化批注以及用户自定义模型于一体。

> 作者：**xyLee** · [项目仓库](https://github.com/lxymol/Reading-Assistant)

## 主要功能

- 支持 PDF、图片、纯文本、Markdown、源码、常见办公文档和 EPUB，通过直接渲染或本地转换为 PDF 阅读
- 将文件拖到主窗口任意位置即可创建项目
- 文字或视觉区域选择
- 彩色文本与墨迹批注
- 实时 Markdown 与 LaTeX 公式笔记，支持粘贴图片、智能裁边墨迹和 Markdown 导出
- 不同组件侧边栏停靠，浮动窗口转换
- 可通过 OpenAI 兼容 API 或已登录的 Codex 账户进行流式 AI 问答，并分别配置默认模型与深度思考模型
- 可选受限 Codex Agent 模式，支持任务拆分以及由 Raid 控制的文档检索、时间查询和联网搜索
- 支持导入 Skill 和语言包、自动 Skill 路由，以及显式 `/skill-command` 选择
- 支持多项目历史记忆与用户画像管理
- 支持系统分屏的窄窗口布局与缓存清理

## 界面展示

![Raid 界面概览](docs/images/raid-interface-1.png)

![Raid 阅读工作区](docs/images/raid-interface-2.png)

![Raid 工具与批注](docs/images/raid-interface-3.png)

## AI 上下文策略

Raid 使用检索增强上下文，但不依赖向量数据库：

- **选区模式：**只发送当前选区内容和最近两轮选区对话，不发送全文、全文摘要或用户长期记忆。文字识别成功时只发送文字；需要视觉理解时最多发送 4 张选区图片。
- **全文模式：**提供全文结构概览；在上下文容量允许时发送全文精确文字。超大文档则同时采用问题相关片段与跨全文均匀分布的代表性片段。
- **来源标注：**PDF 文字会按版面坐标重建行、栏和段落，适配常见多栏文章。全文回答只显示带下划线的页码；当前版本不提供点击跳转。
- **批注参与：**可见墨迹会绘制进选区图片；与选区重叠的文本批注会加入识别文字，全部文本批注也可参与全文问答。

这种方式让选区操作保持轻量快速，同时兼顾全文问题的覆盖面和大型文件下的上下文可控性。

### 受限 Codex Agent

选择 Codex 接入并开启“受限 Agent 模式”后，自定义问题可以被拆分为最多 4 个工具步骤。实际工具由 Raid 执行，白名单仅包含文档检索、当前时间和固定入口联网搜索；所有参数都会校验，搜索结果按不可信参考数据处理。Agent 不会获得终端、文件写入、代码修改或电脑控制工具。翻译、解释、摘要等直接操作仍使用更快的单次请求路径。

## 记忆方法

Raid 包含两种不同的本地记忆：

- **项目记忆：**使用 `RaidData/Data/projects` 中带版本号的项目记录保存源文件、对话、当前页、缩放、阅读模式、笔记及其图片、文字高亮和批注。旧版 IndexedDB 项目会自动迁移；在“设置 → 记忆设置 → 项目记忆”中删除项目，会永久删除完整记录及相关资源。
- **用户记忆：**可选、可编辑的稳定背景和回答偏好画像。开启后，默认模型可根据当前问题与回答更新画像；文档原文不会作为用户画像的学习材料。

项目记忆属于文档状态持久化，并不是语义 RAG 记忆。AI 所使用的检索增强上下文，会在发起请求时从本地抽取的文档文字中生成。

## 安装

Windows 用户可从 [GitHub Releases](https://github.com/lxymol/Reading-Assistant/releases) 下载安装程序。Raid 不修改系统环境变量，也不要求另行安装 Node.js。

Raid 将项目、源文件、对话、笔记和批注放在程序旁边的 `RaidData/Data`，不会把这些大体积资料堆积到 C 盘。Electron 仅在 Windows 用户目录保留少量运行设置和不超过 128 MB 的启动加速缓存；转换临时文件和迁移完成后的旧 IndexedDB 会在正常关闭时清理。

当前版本：`1.2.0`。

## AI 配置

打开“设置 → 模型设置”，可选择 OpenAI 兼容 API，或复用电脑上已经登录的 Codex 账户。API 模式使用自定义接口和 Key；Codex 模式从本机 Codex 登录状态获取可用 GPT 模型。两种接入方式均采用流式输出。

| 配置 | 用途 |
| --- | --- |
| 默认模型 | 文字处理、全文问答、翻译、Skill 路由和可选用户记忆更新 |
| 视觉模型 | 选区图片、公式、图表、示意图和扫描内容 |
| 深度思考模型 | 开启深度思考后的纯文字推理任务 |

高级配置留空时会沿用默认接口和 Key。点击模型输入框右侧的问号按钮可获取可用模型。兼容接口应提供：

- `GET /models`
- `POST /chat/completions`

流式生成期间，只有对话原本位于底部时才会自动跟随最新内容；向上滚动后不会被强制拉回。调整助手栏高度或窗口尺寸时会重新保持最新消息可见。

## Skill 与语言包

- 在“设置 → 技能设置”中导入根目录包含 `SKILL.md` 的文件夹，Raid 会读取其说明和支持的文本参考文件。
- AI 可根据 Skill 元数据自动路由，也可在消息开头输入 `/skill-command` 强制指定。
- 在“设置 → 语言设置”中导入包含 `language.json` 的文件夹；所选语言同时控制界面、AI 回答和翻译目标语言。

## 从源码运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

启动隔离的桌面测试版：

```bash
npm run desktop:test
```

## 构建

```bash
npm run lint
npm run build
npm run desktop:pack
```

## 隐私与安全

- PDF 渲染、文字抽取、OCR、笔记、批注和项目存储都在本机完成。
- 只有发起 AI 操作后，用户配置的 AI 服务才会收到相应材料。选区模式仅发送选区和最近两轮选区对话；全文模式可发送生成的文档上下文、近期对话和可选用户记忆；视觉选区最多 4 张。
- 为恢复项目，源文件及相关资源会保存在程序旁的 `RaidData/Data/projects`；除非作为 AI 请求内容，否则不会上传。
- API 配置保存在应用本机数据目录，不会进入仓库或安装包，但并非操作系统密钥库加密。

安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 贡献

欢迎提交 Issue 和 Pull Request。开始开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

Raid 使用 [MIT License](LICENSE)。

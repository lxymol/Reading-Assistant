# Raid

[English](README.md) | [简体中文](README_zh-cn.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-1.3.0-3794ff)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)

Raid is a lightweight, project-oriented AI reader for papers, textbooks, and technical documents. It combines continuous PDF/image reading, text and cross-page area selection, OCR, Markdown notes, persistent annotations, and user-configured models.

> Created by **xyLee** · [Repository](https://github.com/lxymol/Reading-Assistant)

## Highlights

- PDF, image, text, Markdown, source-code, office-document, and EPUB reading through direct rendering or local PDF conversion
- Drag a file anywhere onto the main window to create a project
- Text or visual-region selection
- Colored text and ink annotations
- Live Markdown and LaTeX notes with pasted images, smart-cropped ink, and Markdown export
- Dockable component sidebars and detachable floating windows
- Streaming AI Q&A through an OpenAI-compatible API or a signed-in Codex account, with independent default and reasoning models
- Optional restricted Codex Agent mode with task planning and Raid-controlled document search, current-time, and web-search tools
- Importable Skills and language packs, automatic Skill routing, and explicit `/skill-command` selection
- Multi-project history memory and user-profile management
- Split-screen-friendly narrow layout and drag-to-reorder navigation tools

## Interface preview

![Raid interface overview](docs/images/raid-interface-1.png)

![Raid reading workspace](docs/images/raid-interface-2.png)

![Raid tools and annotations](docs/images/raid-interface-3.png)

## AI context strategy

Raid uses retrieval-augmented context, but it does not require a vector database:

- **Selection mode:** sends only the current selection and the two most recent selection-chat turns—never the complete document, a document summary, or long-term user memory. Recognized text is sent without images; up to four selected images may be sent when visual understanding is required.
- **Document mode:** sends the page overview plus exact full text for documents within the context limit. Very large documents use query-ranked chunks together with passages distributed across the full document.
- **Source labels:** PDF text is reconstructed into lines, columns, and paragraphs from layout coordinates for common multi-column layouts. Whole-document answers show underlined page numbers; click-to-jump is not enabled in this release.
- **Annotations:** visible ink is drawn into selection images; overlapping text annotations are appended to extracted text, and all text annotations can participate in document questions.

This strategy keeps selection operations lightweight while preserving broad coverage for whole-document questions and predictable behavior on large files.

### Restricted Codex Agent

When Codex connection and **Restricted agent mode** are enabled, custom questions may be split into as many as four tool steps. Raid—not Codex—executes a small allowlist of document search, current-time lookup, and fixed-endpoint web search. Tool inputs are validated and search results are treated as untrusted reference data. The agent is not given terminal, file-writing, code-editing, or desktop-control tools. Translation, explanation, summary, and other direct actions keep the faster single-request path.

## Memory model

Raid has two distinct local memory layers:

- **Project memory:** versioned records under `RaidData/Data/projects` store the source file, conversations, current page, zoom, reading mode, notes and note images, highlights, and annotations. Legacy IndexedDB projects migrate automatically. Deleting a project from **Settings → Memory settings → Project memory** permanently removes the complete record and its related assets.
- **User memory:** an optional editable profile of stable background and response preferences. When enabled, the configured default model may update this profile from the current request and answer; document source text is not used to learn the profile.

Project memory is document state persistence rather than semantic RAG memory. The AI context retrieval described above is performed from locally extracted document text when a request is made.

## Installation

Download the Windows installer from [GitHub Releases](https://github.com/lxymol/Reading-Assistant/releases). Raid does not modify system environment variables and does not require a separate Node.js installation.

Raid keeps projects, source files, conversations, notes, and annotations under `RaidData/Data` beside the executable, so large durable data does not accumulate in the Windows profile on drive C. Electron retains only small settings and up to 128 MB of startup cache in the standard Windows location; conversion scratch data and the migrated legacy IndexedDB are cleared on normal exit.

Current version: `1.3.0`.

## AI configuration

Open **Settings → Model settings** and choose either an OpenAI-compatible API or a Codex account already signed in on the computer. API mode uses the configured endpoint and key; Codex mode discovers available GPT models from the local Codex sign-in. Both modes stream output as it is generated.

| Configuration | Purpose |
| --- | --- |
| Default model | Text processing, document Q&A, translation, Skill routing, and optional user-memory updates |
| Vision model | Selected images, formulas, charts, figures, and scanned content |
| Reasoning model | Text-only reasoning when Deep thinking is enabled |

Advanced configurations inherit the default endpoint and key when left blank. The question-mark button inside a model field requests the available model list. Compatible endpoints should provide:

- `GET /models`
- `POST /chat/completions`

During streaming, Raid follows the newest text only while the conversation is already at the bottom. Scrolling upward pauses automatic following; resizing the assistant panel returns it to the latest message.

## Skills and language packs

- Import a folder whose root contains `SKILL.md` from **Settings → Skill settings**. Raid reads its instructions and supported text references.
- AI can route automatically from Skill metadata, or a message can begin with `/skill-command` to force a Skill.
- Import a folder containing `language.json` from **Settings → Language settings**. The selected language controls the UI, AI response language, and translation target.

## Run from source

Node.js 20 or later is required.

```bash
npm install
npm run dev
```

Start the isolated desktop test build with:

```bash
npm run desktop:test
```

## Build

```bash
npm run lint
npm run build
npm run desktop:pack
```

## Privacy and security

- PDF rendering, text extraction, OCR, notes, annotations, and project storage run locally.
- The configured AI service receives data only after an AI action. Selection mode sends only the selection and two recent selection-chat turns; document mode may send generated document context, recent conversation messages, and optional user memory. Up to four visual selections may be sent when required.
- Project files and assets are stored under `RaidData/Data/projects` beside the application so projects can be restored. They are not uploaded unless included in an AI request.
- API settings remain in the local application data directory and are not included in the repository or installer, but they are not protected by an operating-system credential vault.

See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting development.

## License

Raid is licensed under the [MIT License](LICENSE).

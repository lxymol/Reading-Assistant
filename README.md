# Raid

[English](README.md) | [简体中文](README_zh-cn.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-2.0.0-3794ff)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)

Raid is a lightweight, extensible AI reader for papers, textbooks, and technical documents. It brings multi-file organization, continuous reading, precise selection, OCR, annotations, document tags, retrieval-grounded AI conversations, and user-configured models into one focused desktop workspace.

> Created by **xyLee** · [Repository](https://github.com/lxymol/Reading-Assistant)

## Highlights

- Read PDF, images, plain text, Markdown, source code, EPUB, and common office documents through direct rendering or local PDF conversion
- Import several files together by file picker, drag-and-drop, or clipboard paste
- Keep files ungrouped or arrange them into lightweight, reorderable combinations
- Store conversations beneath their source file and ask AI about a selection, the current document, or the current combination
- Select native text or any number of cross-page visual regions, with OCR and optional vision-model input
- Add colored text highlights, vector ink annotations, and draggable named document tags
- Follow source-linked AI citations back to the exact file, page, and region
- Dock tools on either side or detach them as floating windows
- Use an OpenAI-compatible API or a locally signed-in Codex account, with separate default, vision, and reasoning models
- Import Skills and language packs, enable optional user memory, and configure Windows Explorer's “Open with Raid” command

## Interface preview

![Raid interface overview](docs/images/raid-interface-1.png)

![Raid reading workspace](docs/images/raid-interface-2.png)

![Raid tools and annotations](docs/images/raid-interface-3.png)

## File organization

Raid treats a combination as a simple ordered set of files. Ungrouped files remain in a quiet list beneath all combinations. Files and combinations can be reordered directly, and files can be moved between combinations without reimporting them.

Conversations belong to the file from which they were created and appear beneath that file in the sidebar. A conversation may still use combination context; dissolving a combination moves its files and preserves those conversations instead of deleting them.

## AI context strategy

Raid uses retrieval-augmented context without requiring a vector database:

- **Selection:** sends the current edited selection text and, when a vision model is available, all current visual selection images. Recent selection-chat turns are included, while document and user-memory context are excluded.
- **Document:** sends locally extracted context from the current file. Documents that fit the context budget can use exact full text; larger documents use question-ranked passages plus representative coverage across the file.
- **Combination:** retrieves across every file in the current combination while preserving evidence diversity between files.
- **Citations:** document and combination answers use inline source badges attached to the claims they support. A badge can navigate to its source file, page, and region; deleting the message also deletes its temporary AI citations.
- **Annotations:** visible ink is composited into visual selections, while relevant text annotations are added to extracted context. Overlapping highlights are normalized so text is not highlighted in duplicate layers.

Selection OCR is an editable aid rather than the only evidence path: when a visual selection is available, Raid can send both its recognized text and original image so the model can verify characters that OCR did not reproduce precisely.

### Restricted Codex Agent

When Codex connection and **Restricted agent mode** are enabled, custom questions may be split into up to four tool steps. Raid executes a small allowlist of document search, current-time, and fixed-endpoint web-search tools. Inputs are validated and search results are treated as untrusted reference data. The agent does not receive terminal, arbitrary file-writing, code-editing, or desktop-control access. Translation, explanation, summary, and other direct actions keep the faster single-request path.

## Large-document and memory strategy

- PDF pages are rendered only when visible or near the reading position; distant pages keep their layout space but release canvases and PDF.js page resources.
- The current page and nearby pages receive rendering priority. OCR is deferred until a selection or explicit text need requires it, and the OCR worker exits after an idle period.
- Switching files destroys the previous PDF loading task and revokes temporary object URLs.
- Inactive combinations keep lightweight summaries in memory. Their full file metadata, conversations, and indexes are rehydrated from local storage only when opened.

These controls bound normal memory use around the active reading set instead of the total page count or the total size of the library.

## Local storage

Versioned records under `RaidData/Data/projects` beside the executable store imported source files, conversations, reading position, highlights, annotations, tags, and local document indexes. Older IndexedDB projects migrate automatically. Deleting a combination from **Settings → Memory → Project memory** permanently removes its stored record and assets.

User memory is a separate, optional, editable profile for stable background and response preferences. Document source text is not learned into that profile.

## Installation

Download the Windows installer from [GitHub Releases](https://github.com/lxymol/Reading-Assistant/releases). Raid does not modify system environment variables and does not require a separate Node.js installation.

Current version: `2.0.0`.

## AI configuration

Open **Settings → Model** and choose either an OpenAI-compatible API or a Codex account already signed in on the computer. API mode uses the configured endpoint and key; Codex mode discovers models from the local Codex sign-in. Both modes stream output as it is generated.

| Configuration | Purpose |
| --- | --- |
| Default model | Text processing, document and combination Q&A, translation, Skill routing, and optional user-memory updates |
| Vision model | Visual selections, formulas, charts, figures, scans, and OCR verification |
| Reasoning model | Text-only reasoning when Deep thinking is enabled |

Advanced configurations inherit the default endpoint and key when left blank. Compatible endpoints should provide `GET /models` and `POST /chat/completions`.

## Skills and language packs

- Import a folder whose root contains `SKILL.md` from **Settings → Skill settings**. Raid reads its instructions and supported text references.
- AI can route automatically from Skill metadata, or a message can begin with `/skill-command` to force a Skill.
- Import a folder containing `language.json` from **Settings → Language settings**. The selected language controls the interface, AI response language, and translation target.

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
npm test
npm run build
npm run desktop:pack
```

The Windows installer is written to `release-2.0.0`.

## Privacy and security

- PDF rendering, extraction, OCR, indexing, annotations, tags, and project storage run locally.
- Data is sent to the configured AI service only after an AI action. The exact material depends on the selected scope described above.
- Imported files and related assets stay under `RaidData/Data/projects` unless their content is included in an AI request.
- API settings remain in the local application data directory and are not included in the repository or installer, but they are not protected by an operating-system credential vault.

See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting development.

## License

Raid is licensed under the [MIT License](LICENSE).

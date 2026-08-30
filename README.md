# Raid

[English](README.md) | [简体中文](README_zh-cn.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-1.0.0-3794ff)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)

Raid is a lightweight, project-oriented AI reader for papers, textbooks, and technical documents. It combines continuous PDF/image reading, text and cross-page area selection, OCR, Markdown notes, persistent annotations, and user-configured models.

> Created by **xyLee** · [Repository](https://github.com/lxymol/Reading-Assistant)

## Highlights

- PDF document reading
- Text or visual-region selection
- Colored text and ink annotations
- Live Markdown notes with pasted images, smart-cropped ink, and Markdown export
- Dockable component sidebars and detachable floating windows
- AI Q&A for selections or complete documents, with navigable references in responses and support for multiple user-configured models
- Importable Skills and language packs, automatic Skill routing, and explicit `/skill-command` selection
- Multi-project history memory and user-profile management

## Interface preview

![Raid interface overview](docs/images/raid-interface-1.png)

![Raid reading workspace](docs/images/raid-interface-2.png)

![Raid tools and annotations](docs/images/raid-interface-3.png)

## AI context strategy

Raid uses retrieval-augmented context, but it does not require a vector database:

- **Selection mode:** sends a compact page-by-page overview of the complete document, exact content from the selected and neighboring pages, and lexically ranked related chunks from elsewhere in the document. Up to four selected images may be sent when vision is enabled.
- **Document mode:** sends the page overview plus exact full text for documents within the context limit. Very large documents use query-ranked chunks together with passages distributed across the full document.
- **Grounding:** answers can contain page markers validated against extracted pages and rendered as compact clickable page references.
- **Annotations:** visible ink is drawn into selection images; overlapping text annotations are appended to extracted text, and all text annotations can participate in document questions.

This strategy preserves local detail for selections, broad coverage for whole-document questions, and predictable behavior on large files.

## Memory model

Raid has two distinct local memory layers:

- **Project memory:** IndexedDB stores the source file blob, conversations, current page, zoom, reading mode, notes and note images, highlights, and annotations. Deleting a project from **Settings → Memory settings → Project memory** permanently removes the complete record and its related assets.
- **User memory:** an optional editable profile of stable background and response preferences. When enabled, the configured default model may update this profile from the current request and answer; document source text is not used to learn the profile.

Project memory is document state persistence rather than semantic RAG memory. The AI context retrieval described above is performed from locally extracted document text when a request is made.

## Installation

Download the Windows installer from [GitHub Releases](https://github.com/lxymol/Reading-Assistant/releases). Raid does not modify system environment variables and does not require a separate Node.js installation.

Current version: `1.0.0`.

## AI configuration

Open **Settings → Model settings** and enter an API base URL, model name, and API key. Raid does not include provider presets.

| Configuration | Purpose |
| --- | --- |
| Default model | Text processing, document Q&A, translation, Skill routing, and optional user-memory updates |
| Vision model | Selected images, formulas, charts, figures, and scanned content |
| Reasoning model | Text-only reasoning when Deep thinking is enabled |

Advanced configurations inherit the default endpoint and key when left blank. The question-mark button inside a model field requests the available model list. Compatible endpoints should provide:

- `GET /models`
- `POST /chat/completions`

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
- The configured AI service receives data only after an AI action: the selected material, generated document context, recent conversation messages, optional user memory, and up to four visual selections when applicable.
- Project files and assets are stored locally in IndexedDB so projects can be restored. They are not uploaded unless included in an AI request.
- API settings remain in the local application data directory and are not included in the repository or installer, but they are not protected by an operating-system credential vault.

See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting development.

## License

Raid is licensed under the [MIT License](LICENSE).

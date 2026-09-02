# Changelog

All notable changes to Raid are documented here.

## [Unreleased]

## [1.3.0] - 2026-09-02

### Changed

- Standardized API and Codex answers as directly rendered Markdown, including consistent delimiters for inline and display mathematics.
- Trackpad PDF zoom now keeps the active page and the pointer's location within that page stable.
- Chat streaming follows the latest output only until the reader scrolls upward; docked and floating assistant panels both preserve the chosen reading position.

### Fixed

- Fixed long display equations being clipped or broken across lines; oversized formulas can now be inspected horizontally.
- Fixed page and zoom fields rejecting multi-digit manual input before editing was complete.
- Added clear icon-only copy confirmation to assistant messages.

## [1.2.0] - 2026-09-02

### Added

- Added Codex-account connection alongside the existing OpenAI-compatible API configuration, including local sign-in status, model discovery, and separate default and reasoning models.
- Added an optional restricted Codex Agent that can plan up to four steps and use Raid-controlled document search, current-time, and fixed-endpoint web-search tools without terminal, file-writing, code-editing, or desktop-control tools.
- Added live LaTeX formula rendering to Markdown notes.

### Changed

- Both API and Codex answers now stream into the conversation as they are generated.
- Empty-selection custom questions now behave as ordinary chat without silently attaching document text or summaries.
- Streaming output follows the bottom only while the reader remains there; scrolling upward preserves the earlier reading position, while panel resizing deliberately returns to the latest message.
- Simplified the Codex model settings and kept direct translation, explanation, insight, and summary actions on the faster non-Agent path.

### Fixed

- Fixed Codex login-state reuse and account-based model loading.
- Fixed the white flash shown during desktop startup.
- Preserved an assistant answer when its preceding user question is deleted.

## [1.1.0] - 2026-09-01

### Added

- Added drag-and-drop project creation from files dropped anywhere on the main window.
- Added document-to-PDF reading for text, Markdown, source code, CSV/JSON, DOCX, PPTX, XLSX, ODT/ODS/ODP, RTF, and EPUB, with optional LibreOffice fallback for legacy office formats.
- Added drag-to-reorder navigation tools with a persistent custom order.
- Added geometry-aware paragraph indexing for multi-column PDFs and compact page-number labels in whole-document AI answers.

### Changed

- Split `RaidData` into a versioned durable project store, runtime profile, and disposable cache; existing IndexedDB projects migrate automatically and test builds remain isolated in `RaidData-test`.
- Reduced the desktop minimum window size and added narrow-window overlay panels so Windows split-screen layouts remain usable.
- Conversion scratch files and Chromium caches are cleared on every normal exit and again on startup after an interrupted session.
- Removed storage and cache controls from Memory settings.
- Removed cleanup and legacy migration waits from the startup path; project migration continues in the background, saved source files load only when opened, conversion scratch data is deleted on exit, and startup caches are retained under a 128 MB cap.
- Restored Electron's small runtime profile to the Windows default high-performance location while keeping all durable project files in `RaidData`; runtime caches and the migrated legacy IndexedDB are removed when Raid closes.
- Selection AI requests now send only the selected text or image plus the two most recent selection-chat turns; document context, document summaries, automatic Skill routing, and user memory are excluded.

### Fixed

- Fixed selection requests that could stall while unnecessary document context was prepared or sent.
- Fixed raw `REF`, `PAGE`, and `SOURCE` syntax appearing in AI answers; selection answers remove source tags and whole-document answers show non-interactive page numbers.
- Fixed navigation reordering animation, sidebar panel ordering, selection-panel availability, and several citation parsing edge cases.

## [1.0.0] - 2026-08-30

### Added

- Added project-scoped annotations with colored text boxes, vector ink, whole-stroke erasing, local persistence, and AI-selection image compositing.
- Added PowerPoint-style text annotations: content-aware sizing, explicit-line-break layout, editable/movable boxes, and proportional box-and-font resizing.
- Added on-demand model discovery through `GET /models` for each OpenAI-compatible model configuration.
- Added Ctrl/trackpad-pinch PDF zooming while preserving the pointer's document position.
- Added collapsible project conversations and project-level shortcuts for new conversations and notes.
- Added the final transparent book icon across the browser shell, desktop window, Windows taskbar, and installer.

### Improved

- Selection questions now combine a whole-document page overview, exact selected and neighboring pages, and ranked related passages; document questions use exact full text when practical and distributed retrieval for very large documents.
- AI answers use grounded, clickable page references, while visual selections include visible ink and text annotations.
- Project memory now restores the source file, conversations, page and zoom state, notes and note images, highlights, and annotations from local IndexedDB.
- Project deletion warnings explicitly cover conversations, unexported notes, note images, highlights, and annotations, and deletion removes the complete project record.
- Floating tools use native child windows, click-to-front ordering, grab-pointer movement, adjustable dock heights, and pointer-gated edge docking outside the main content area.
- Docking feedback is a narrow, clipped fog cue inside the main window: blue in light mode and yellow in dark mode.
- Deferred OCR loading until a document is opened and reduced packaged duplication and Chromium locales to keep the installer smaller.
- Split the activity bar, project explorer, settings, annotation layer, and workspace types into focused modules without changing the established layout.

### Fixed

- Closing a word-translation popover now aborts its request; moving the popover no longer collapses the selection, and translated content renders Markdown with compact American IPA placement.
- Projects may keep an intentionally empty conversation list after the last conversation is deleted; a conversation is created lazily on the next AI request.
- Fixed floating-window drag resizing and Windows DPI rounding that could enlarge a tool window while moving it.
- Fixed docking indicators being obscured, duplicated, or rendered beyond the main-window boundary.
- Fixed text annotations losing their manually scaled height or clipping text after being closed and reopened.
- Normalized legacy panel layer values so clicked floating panels raise predictably.

### Changed

- Renamed the application to Raid while retaining existing storage identifiers for seamless upgrades.
- Moved the new-project action beneath the AI assistant and enlarged the transparent book icon with a heavier stroke.

## [0.4.0] - 2026-08-29

### Fixed

- Rebuilt project, selection, assistant, and notes surfaces on one persistent panel framework with simultaneous docked panels, draggable splitters, edge docking, movable/resizable floating windows, and proper document reflow.
- Removed file-memory deletion controls from the project page and moved project deletion into Settings with an explicit data-loss warning.
- Fixed pasted-image and ink note storage so the editor uses compact asset references and exported Markdown contains valid image data.
- Added live Markdown notes, a slider-style reasoning control, compact reader toolbar inputs, persistent highlights, and stronger dark-document contrast.
- Introduced full-document structure plus local exact context for selection questions and grounded page references for answers.

## [0.4.0-beta.1] - 2026-08-28

### Added

- VS Code-style activity bar for selections, projects, conversations, notes, new projects, settings, and themes.
- Persistent project files, per-project Markdown notes, pasted images, resizable ink canvases, and Markdown export.
- Persistent text highlights, source-page tags in conversations, message deletion, and stop-generation controls.
- Editable page and zoom fields plus dockable and floating side panels.

## [0.3.0] - 2026-08-26

### Added

- IndexedDB-backed project memory for conversations, page position, zoom, and reading state.
- Optional AI-maintained user memory with in-app viewing, editing, and deletion.
- A dedicated Memory settings tab and resizable AI/selection panels.

## [0.2.0] - 2026-08-24

### Added

- Unified Model, Skill, and Language settings tabs.
- Importable Skills from folders containing `SKILL.md`, automatic Skill routing, and explicit `/skill-command` selection.
- Importable language packs and secure Electron folder selection.

## [0.1.0] - 2026-08-24

### Added

- Windows desktop application and NSIS installer.
- Multi-file workspaces, concurrent AI conversations, default/vision/reasoning model configurations, cross-page selections, OCR, Markdown/KaTeX responses, and Chinese/English interfaces.

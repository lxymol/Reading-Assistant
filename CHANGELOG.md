# Changelog

All notable changes to Raid are documented here.

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

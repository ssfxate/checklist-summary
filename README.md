# Checklist Summary

Lightweight Obsidian plugin that renders checkbox-status counts next to Markdown sections and list groups in Live Preview and Reading mode.

## Features

- Counts checkbox markers without changing the note.
- Supports section, local list, nested group, and virtual summaries.
- Keeps nonstandard task markers separate instead of normalizing them.
- Ignores ordinary list items when calculating counts.
- Works on desktop and mobile.

## Install with BRAT

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Run `BRAT: Add a beta plugin for testing`.
3. Enter `ssfxate/checklist-summary`.

BRAT installs the release assets `main.js`, `manifest.json`, and `styles.css` from GitHub Releases.

## Development

```bash
npm install
npm run check
```

The editable source is `src/main.ts`; `npm run build` produces the distributable `main.js`.

## Release

```bash
npm run release:patch
```

The release command bumps the version, validates and builds the plugin, pushes the commit and tag, and creates a GitHub Release with all BRAT assets.

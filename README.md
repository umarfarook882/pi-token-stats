# pi-token-stats

A [pi coding agent](https://github.com/earendil-works/pi-mono) extension that shows a live per-turn token breakdown in the footer and an interactive drill-down overlay.

## What it does

**Footer (always visible, below the editor):**

```
Turn  ~↑6.2k  sys:1.1k sk:420 tl:3.1k hi:980 tr:440 in:87 | ↓312 | cr:1.2k cw:0
Cum.  ~∑↑18.4k sys:3.3k sk:1.2k tl:9.3k hi:2.9k tr:1.3k in:260 | ∑↓940 | ∑cr:3.6k ∑cw:0
```

| Symbol | Meaning |
|--------|---------|
| `↑` / `∑↑` | Input tokens (turn / cumulative) |
| `↓` / `∑↓` | Output tokens (turn / cumulative) |
| `~` prefix | Estimated (provider did not return usage for this turn) |
| `sys` | System prompt base instructions |
| `sk` | `<available_skills>` block |
| `tl` | Active tool definitions |
| `hi` | Conversation history |
| `tr` | Tool results in context |
| `in` | Current user message |
| `cr` / `∑cr` | Cache read tokens (turn / cumulative) |
| `cw` / `∑cw` | Cache write tokens (turn / cumulative) |

During generation, the footer shows a live estimate while the LLM responds. Output tokens show `…` until the turn ends; prior turns' cumulative output is shown immediately.

**`/token-stats` overlay:**

Opens an interactive panel with a stacked bar chart and per-category table. Navigate with:

| Key | Action |
|-----|--------|
| `↑` / `↓` | Select category |
| `Enter` | Drill into raw content for selected category |
| `←` / `→` | Switch between turns |
| `↑` / `↓` (drill) | Scroll line by line |
| `u` / `Ctrl+U` / `PageUp` | Scroll up 15 lines |
| `d` / `Ctrl+D` / `PageDown` | Scroll down 15 lines |
| `Esc` | Back / close |

## Install

```sh
cp -r pi-token-stats ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions/pi-token-stats
npm install
```

Restart pi. The footer widget appears immediately on the next session start.

## Token estimation

Token counts are estimated using `gpt-tokenizer` (o200k\_base, the same vocabulary used by Claude). Actual counts come from the provider's usage field when available and replace estimates at turn end. The `~` prefix indicates an estimated value.

Images are estimated at a fixed 400 tokens regardless of resolution; actual vision costs vary by image size.

## Behaviour across session events

| Event | Effect on stats |
|-------|----------------|
| `/new`, `/resume`, startup | `turns[]` and all cumulative totals reset to zero |
| `/fork`, `/clone` | Same as above — pi re-initialises the extension in the new session |
| `/compact` or auto-compaction | **No reset.** Cumulative totals reflect real historical spend. Per-turn counts will naturally drop on future turns because the context shrank. A notification is shown. |

## Known limitations

- Image token cost is hardcoded at 400 tokens; high-resolution images will be under-counted.
- Cumulative history and results totals after compaction are inflated relative to the live context size — this is intentional, as those tokens were billed in prior turns.
- Provider usage is not exposed in all configurations; affected turns show estimated counts with a `~` prefix.

## Dependencies

| Package | Purpose |
|---------|---------|
| `gpt-tokenizer` | Client-side token estimation (o200k\_base) |
| `@earendil-works/pi-coding-agent` | Extension API (peer, provided by pi) |
| `@earendil-works/pi-tui` | `matchesKey` helper for keybindings (peer, provided by pi) |

# pi-token-stats

A [pi coding agent](https://github.com/earendil-works/pi-mono) extension that tracks context usage, caching, and cost per turn, featuring an interactive token breakdown overlay.

## What it does

**Live Estimation:**
While the model is thinking, the extension replaces the default `Working...` indicator with a live token estimation (e.g., `[T1 ↑6.2k] Working...`). This actively updates as usage data streams in from the provider.

**Turn Receipts:**
When a turn completes, a persistent receipt is appended to the conversation history:
```
✓ T1: ↑6.2k ↓312 R1.2k W3.1k $0.05 65.0%
```

| Symbol | Meaning |
|--------|---------|
| `↑` | Prompt tokens (non-cached input + cache read + cache write). When provider stats are unavailable, this is an estimate. |
| `↓` | Output tokens (generated during the turn). |
| `R` | Cache read tokens (saving cost/time). |
| `W` | Cache write tokens. |
| `$` | Actual billing cost for the turn (if supported by the model). |
| `%` | Context window percentage (turns yellow > 75%, red > 90%). |

**Context Limit Warnings:**
The extension actively monitors your provider's context window. If you exceed 80% capacity, a warning notification appears. At 90%, a critical alert is shown, prompting you to compact the context.

**`/token-stats` overlay:**
Opens an interactive panel to inspect your context usage. Navigate with:

| Key | Action |
|-----|--------|
| `Tab` | Toggle between Turn Detail and Session Summary |
| `↑` / `↓` | Select category in Turn Detail |
| `Enter` | Drill into raw content for selected category (breaks down tokens per tool, per skill, per message) |
| `←` / `→` | Switch between turns |
| `↑` / `↓` (drill) | Scroll line by line |
| `u` / `Ctrl+U` / `PageUp` | Scroll up 15 lines |
| `d` / `Ctrl+D` / `PageDown` | Scroll down 15 lines |
| `e` / `E` | Export full token history to a JSON file |
| `Esc` / `q` | Back / close |

**Turn Detail View:**
Shows a stacked bar chart and tabular breakdown of context by category: System prompt, Skills, Meta, Tools, History, Results, and Input.

**Session Summary View:**
Provides aggregate stats for the entire session: Total Turns, Total Prompt, Uncached In, Total Output, Total Cost, Avg Turn Cost, Peak Turn, Cache Hits, and Cache Savings.

## Install

If you are using the pi CLI, you can clone or copy this repository to your extensions directory:

```sh
git clone https://github.com/earendil-works/pi-token-stats.git ~/.pi/agent/extensions/pi-token-stats
cd ~/.pi/agent/extensions/pi-token-stats
npm install
```

Restart pi to load the extension. The token tracker will be active immediately.

## Token estimation

When actual provider usage isn't available, token counts are estimated using the built-in `estimateTokens` function from the pi SDK (which uses the `o200k_base` vocabulary). Actual counts come from the provider's usage field when supported and replace estimates.

Images are roughly estimated at a fixed 400 tokens; actual vision costs depend on resolution and provider scaling.

## Behaviour across session events

| Event | Effect on stats |
|-------|----------------|
| `/new`, `/resume`, startup | Session resets. Cumulative totals and history are cleared. |
| `/fork`, `/clone` | Same as above — pi re-initialises the extension in the new session. |
| `/compact` or auto-compaction | **No reset.** Cumulative totals (like Cost and Cache Hits) accurately reflect real historical spend. Per-turn prompt counts drop dynamically as context shrinks. A notification is shown. |

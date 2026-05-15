# Acceptance criteria

Per-feature checklists used by both the automated test suite and manual smoke tests. Every checklist item maps to one or more tests in `tests/find-vids.test.ts` (where automatable) or to a manual repro step.

## CLI argument parsing — `parseArgs`

- [x] Returns `{ photoPath, flags }` when given a single positional photo path.
- [x] Accepts `--no-cache`, `--show-queries`, and `--no-enrich` in any order.
- [x] Exits non-zero on unknown flags (`--bogus`).
- [x] Exits non-zero when no photo path is given.

## Image loading & normalization — `loadAndValidatePhoto`

- [x] Rejects unsupported extensions (HEIC, BMP, …) with a clear stderr hint.
- [x] Auto-downscales any input whose raw bytes exceed Anthropic's ~3.75 MB raw / 5 MB base64 ceiling.
- [x] Bakes EXIF Orientation into pixels for **all** photo inputs — not just oversized ones — so portrait iPhone JPEGs arrive upright.
- [x] GIFs pass through unmodified (no flattening of animated frames, no orientation transform).

## Downscale strategy — `downscaleToFit`

- [x] Tries widths 2048 → 1536 → 1024 → 768 and keeps the first pass that drops under the ceiling.
- [x] Calls `sharp.rotate()` on every pass (orientation must be applied before resize).
- [x] If even 768px doesn't fit (extremely rare), returns the 768px buffer anyway and lets the caller surface the API error.

## Vision query generation — `getQueries`

- [ ] Caches responses under `.cache/vision/<sha1>.json` with a 24h TTL. (manual)
- [ ] `--no-cache` bypasses the cache. (manual)
- [ ] `--show-queries` prints the three queries to stderr before fetch. (manual)
- [ ] Exits with a helpful message when `ANTHROPIC_API_KEY` is missing. (manual)

## YouTube fetch — `searchYouTube`

- [ ] Spawns `youtube-pp-cli` with `youtube search-bulk <q1> <q2> <q3> --top 5 --agent`. (manual)
- [ ] Honors `YOUTUBE_PP_CLI` env override for non-`$PATH` installs. (manual)
- [ ] Exits non-zero with the CLI's stderr forwarded when the subprocess fails. (manual)

## HTML rendering — `renderHTML`

- [x] Output matches the checked-in golden byte-for-byte for fixed (photo, terms) inputs.
- [x] Header reports `N queries, M videos` where M sums result counts across non-erroring terms.
- [x] Error terms render an inline error block, not video cards.
- [x] All user-supplied strings are HTML-escaped via `esc` (covered by `esc` unit tests).

## Per-video enrichment — `enrichVideos`

- [ ] Transcript fetched via `youtube-pp-cli youtube videos-transcript <id>`; missing captions degrade silently to no summary. (manual)
- [ ] Top comment fetched via `youtube-pp-cli youtube videos-comments <id> --top 1`; comments-disabled videos degrade silently. (manual)
- [ ] A single batched Claude call summarizes all videos with non-empty transcripts in one round-trip.
- [ ] Summaries are one sentence (≤ 25 words), transcript-grounded, and do not parrot the title.
- [ ] The "Transcript too sparse to summarize" sentinel from Claude is filtered out — no apology line ever renders. (covered: summarizer + cache-read filters)
- [x] `--no-enrich` skips enrichment entirely and reproduces the pre-feature page.
- [ ] Per-`videoId` cache at `.cache/enrich/<id>.json` with a 7-day TTL; second run on the same videos triggers zero extra CLI/Claude calls. (manual)
- [x] Card layout shows the summary in italic + a top-comment block (likeCount · author · text) when present, and nothing when absent.

## Cross-platform open — `resolveOpenCommand` / `openInBrowser`

- [x] `darwin` → `open <path>`.
- [x] `linux` → `xdg-open <path>`.
- [x] `win32` → `cmd /c start "" <path>`.
- [x] Unknown platforms → returns `null`; caller prints the path instead of crashing.
- [ ] Spawn failures do not crash the run — they print a manual-open hint. (manual; spawn error path requires injection)

## End-to-end smoke (manual)

Run after merging anything that touches image handling or rendering:

1. `npm run find-vids -- ~/Desktop/<some-portrait-iphone-photo>.jpg --no-cache --show-queries`
2. Output HTML opens in the browser; the source-photo thumbnail in the header is upright.
3. Each of the three query sections has between 0 and 5 video cards.
4. Clicking a card swaps the thumbnail for an embedded autoplay iframe.

## Updating goldens

When intentional rendering changes land, regenerate via `UPDATE_GOLDENS=1 npm test`, then `git diff tests/fixtures/golden.html` to review.

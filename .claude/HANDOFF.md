# Handoff

## Active Goal
- Own Seth's fitness-tracker PWA (`github.com/GeorgeHennenTech/fitness-app`, push to `main` auto-deploys on Vercel) end-to-end: ship fixes and an iOS "latest and greatest" glass-style redesign while keeping the app's structure and features.
- Seth's last feedback: first redesign looked like "just font size"; glass pass (`fa09af1`) shipped in response, awaiting his reaction on a real iPhone.

## Verified Progress
- Clone lives at `fitness-app/` inside the session folder (no durable local clone; everything is pushed). All four commits deployed; Vercel status "success" for each.
- `b4a09d2`: applied handoff bundle (`src/App.jsx`, `api/estimate-meal.js`, `api/parse.js`, `public/manifest.json`, `vercel.json`); added `kind:'prompt'` passthrough in `api/parse.js` and repointed schedule/goals/scan-photo imports to it; parse maxDuration 60.
- `23d069e`: 51 embedded exercise images moved to `public/exercises/` (JS gzip 3.9 MB → 0.34 MB); photos (`photo:`, `scanphoto:`, `receiptphoto:`) routed to IndexedDB (`sft-big`) inside the `storage` wrapper with verified migration, backup/import via `storage.getRaw/setRaw`; `apiJson()` client helper; all `api/*.js` got `replyText()` + `parseLoose()`; `api/adjust-program.js` effort low, max_tokens 16000, refusal/truncation errors; `.gitignore`, `README.md`.
- `02a82ac`: iOS tokens in `tailwind.config.js` (stone ramp → iOS grays, type scale, radii), `src/index.css`, system font, sentence-case buttons, segmented controls (`.ios-seg`), scroll-to-top on tab change, `index.html`/manifest theme colour.
- `fa09af1`: glass materials appended to `src/index.css` (`.app-ambient`, `.glass`, `.glass-chip`, `.tab-active`, `.hero-card`, card/button/progress rules); floating capsule tab bar, rebuilt workout hero, new `ProgressRing` + `MacroRing`, accent CSS vars (`--accent*`) set in `applyAccentTheme`, `data-light` set in `applyBackgroundTheme` (all in `src/App.jsx`); radii bumped in `tailwind.config.js`.
- Verified locally: `vite build`, `node --check` on all endpoints, mocked-reply endpoint tests, browser at 375×812 (Today, Fuel, Spend, Calendar dark; Today in White theme), no console errors.

## Current State & Decisions
- NOT verified: anything on a real iPhone; live Anthropic API calls; live endpoints (`*-sethbot.vercel.app` URLs are behind Vercel auth — need Seth's public production domain). Program Coach fix is unconfirmed against the real error.
- Not reviewed after glass pass: Body, Library, Settings, recipe detail, receipt review, scan entry, Program Coach results, 13 other background themes, non-default accents. Larger type may crowd dense rows.
- Constraints: `api/` at 12-function Hobby cap (add `kind`/`mode`, never a file); every `vercel.json` function key must match a file; ship frontend+backend together; `App.jsx` stays one file; only build what Seth asks; model ids `claude-opus-4-8` / `claude-fable-5` are valid and unchanged.
- Styling approach: restyle via Tailwind token remap + CSS rules after utilities that target existing class combos (e.g. `.bg-stone-900.border-stone-800`); accent/background theme style-tag overrides must keep working; animations are transform-only on purpose.
- Environment: no `gh`; `npm ci` fails through sandbox proxy — node_modules was installed by a lockfile/curl script; build with `node node_modules/vite/bin/vite.js build`; preview config at session-root `.claude/launch.json` (`fitness-preview`, port 4173); commit as `GeorgeHennenTech` noreply (already set in repo config); deploy status via GitHub commit-status API.
- `HANDOFF.md` (Seth's original, in ~/Downloads) deliberately not committed (public repo, names people). `USDA_API_KEY` still unset. Jayson must sync his fork.
- Open decisions for Seth (unchanged): missed-workout behaviour, meat-ratio selector, serving descriptors, micros overwrite, muscle-set counter reset.
- Seth was offered once to move the session to a folder of his choice; not answered — don't repeat.

## Immediate Next Step
- Wait for Seth's reaction to the glass redesign; then start `fitness-preview`, screenshot the unreviewed screens (Body, Library, Settings, recipe detail, Add-food sheet) at mobile size, and fix crowding or push the look further per his feedback before committing and pushing to `main`.

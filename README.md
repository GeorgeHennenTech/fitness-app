# Seth's Fitness Tracker

Personal fitness tracker built as a PWA. Vite + React + Tailwind frontend, five Vercel serverless functions for AI features, all data stored locally in the browser.

## What's in this project

```
.
├── src/
│   ├── App.jsx           ← The entire app (single file by design)
│   ├── main.jsx          ← React entry point
│   └── index.css         ← Tailwind + base styles
├── public/
│   ├── manifest.json     ← PWA manifest (Add to Home Screen)
│   ├── icon-*.png        ← App icons
│   └── apple-touch-icon.png
├── api/
│   ├── parse-receipt.js  ← Claude vision: OCR a grocery receipt
│   ├── parse-recipe.js   ← Claude vision/URL: extract a recipe
│   ├── generate-recipes.js ← Claude: invent recipes from pantry
│   ├── recipe-suggest.js ← Claude: 3-meal day plan with macro targets
│   └── weekly-review.js  ← Claude: weekly progress narrative
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── vercel.json
└── package.json
```

---

## Deploy to Vercel (the quick path)

### Prerequisites

1. **Node.js 20+** installed locally (only needed if you want to test locally first)
2. **A GitHub account**
3. **A Vercel account** — sign in with GitHub at [vercel.com](https://vercel.com)
4. **An Anthropic API key** — get one at [console.anthropic.com](https://console.anthropic.com/settings/keys). Add some credit ($10 lasts a long time given typical usage).

### Step 1 — Get the code into a GitHub repo

```bash
# In this folder:
git init
git add .
git commit -m "Initial commit"
gh repo create seth-fitness-tracker --private --source=. --push
# (or create a repo manually on github.com and push to it)
```

If you don't have the GitHub CLI, just create a new empty repo on github.com, then:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/seth-fitness-tracker.git
git push -u origin main
```

### Step 2 — Connect Vercel to the repo

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click "Import" next to your `seth-fitness-tracker` repo
3. Vercel auto-detects Vite — leave all build settings as default
4. **Don't click Deploy yet** — first, expand "Environment Variables"
5. Add a variable: `ANTHROPIC_API_KEY` = your key from step 0
6. Click **Deploy**

First build takes ~60 seconds. You'll get a URL like `seth-fitness-tracker.vercel.app`.

### Step 3 — Install as a PWA on iPhone

1. Open the Vercel URL in **Safari** (not Chrome — iOS requires Safari for PWA install)
2. Tap the Share button
3. Scroll down → tap **Add to Home Screen**
4. Name it "Tracker" (or whatever) → tap Add
5. The icon appears on your home screen and launches fullscreen, no browser chrome

### Step 4 — Verify the AI features work

Open the live app and try:
- **Receipts tab** → Add receipt → photo of any grocery receipt → should parse into line items
- **Body** → click "AI Weekly Review" → should generate a narrative
- **Recipes** → Add recipe → paste a recipe URL → should extract structure
- **Recipes** → Add recipe → Generate from pantry → should invent recipes

If any of these fail, check the Vercel dashboard → your project → Functions tab → click the failing function → view logs. Most common issue: forgot to add `ANTHROPIC_API_KEY`.

---

## Local development (optional)

```bash
npm install
npm run dev
```

Opens at http://localhost:5173. The five `/api/*` endpoints won't work locally unless you use `vercel dev` instead of `npm run dev`. For most iteration, the app itself works fine without them — only AI features need the endpoints.

To test API endpoints locally:
```bash
npm install -g vercel  # if you don't have it
vercel dev             # runs both Vite and the serverless functions
```

You'll need to drop a `.env.local` with `ANTHROPIC_API_KEY=sk-ant-...` for the endpoints to work locally.

---

## Subsequent deploys

Just push to GitHub. Vercel auto-deploys every push to `main`.

```bash
git add .
git commit -m "Whatever changed"
git push
```

---

## Important: back up your data regularly

All data lives in your browser's localStorage. **Clearing browser data or uninstalling the PWA wipes everything.** Go to Settings (gear icon) → Backup & Restore → Export backup periodically. Save the JSON file somewhere safe (iCloud Drive, Google Drive, email it to yourself).

If you need to migrate to a new device or recover from a wipe, use Restore on the same screen.

---

## Cost estimate

Anthropic API at typical usage:
- Receipt parsing: ~$0.02 per receipt
- Recipe parsing (photo/URL): ~$0.05 each
- Recipe generation from pantry: ~$0.05 per batch of 3 recipes
- Meal planner: ~$0.05 per plan
- Weekly review: ~$0.05 per generation (cached per week)

Heavy week of use is well under $5. Set a budget alert in the Anthropic console.

Vercel: free hobby tier covers everything here — well within the 100k requests/month and 100 GB-hr/month limits.

---

## Replacing the placeholder icons

The default icons are a black "S" on amber — fine for shipping but not unique. To replace:
1. Make a 1024×1024 PNG of your design
2. Use a generator like [realfavicongenerator.net](https://realfavicongenerator.net/) to produce all needed sizes
3. Replace files in `public/`: `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png`, `favicon.png`
4. Commit, push, re-add to home screen

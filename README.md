# WOD Timer

A PWA for CrossFit workouts. An AI coach (Google Gemini or OpenAI) programs the WOD from your Gem instructions, and the app runs it on a large timer with beeps and spoken callouts. Built with vanilla JS and Vite.

There are two ways to run it:

- **Phone-only (recommended):** the files are hosted for free on GitHub Pages or Cloudflare Pages. You save your Gemini or OpenAI key in the app's Settings, and the phone calls that API directly. No computer needs to stay on. See [Phone-only hosting](#phone-only-hosting).
- **Self-hosted:** the app runs on your Ubuntu machine and you open it through Tailscale Serve. The key stays in `.env` on the machine. See sections 1–3.

## 1. Setup

```bash
# Node 20+ (NodeSource .deb puts npm in /usr/bin, which the systemd unit expects)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

cd ~/orel_ws/personal/workout_timer
npm install
cp .env.example .env        # then paste your key into .env
```

To start a project like this from scratch, run `npm create vite@latest wod-timer -- --template vanilla`. This repo is already set up, so you only need `npm install`.

### The API key

`.env` holds `VITE_GEMINI_API_KEY`. `vite.config.js` reads it with `loadEnv()` and gives it to a **server-side proxy**. The browser calls `/api/gemini/...` on the same origin, and the proxy adds the `x-goog-api-key` header before forwarding the request to `generativelanguage.googleapis.com`.

Vite normally puts any `VITE_*` value you reference with `import.meta.env` into the public JS bundle. This app never references the key in client code, so the key stays on your machine. (A test build with a fake key confirmed it is not in `dist/`.) The proxy only allows `POST .../models/<model>:generateContent`, and the server listens only on `127.0.0.1`.

## 2. Run

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://127.0.0.1:5173 with hot reload. The service worker is off. |
| `npm run serve` | Builds the app, then serves it at http://127.0.0.1:4173 with the proxy and service worker. Use this for the iPhone. |
| `npm run icons` | Regenerates the PNG icons in `public/icons/` (needs Python 3). |

## 3. Put it on the iPhone with Tailscale Serve

```bash
npm run serve                       # or use the systemd service below
sudo tailscale serve --bg 4173      # https://<machine>.<tailnet>.ts.net -> 127.0.0.1:4173
tailscale serve status
```

On the iPhone (with Tailscale connected), open the `https://…ts.net` URL in Safari, then tap **Share → Add to Home Screen**. The app then opens full-screen. The service worker needs HTTPS, and Tailscale Serve provides it.

### Keep it running (systemd user service)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/wod-timer.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wod-timer
sudo loginctl enable-linger $USER
```

After you edit code, run `systemctl --user restart wod-timer`. That rebuilds the app, and the new service worker takes over the next time you open it.

## Phone-only hosting

With a key saved in **Settings → AI provider**, the app calls `generativelanguage.googleapis.com` or `api.openai.com` straight from the phone (both allow browser calls). The hosted files are static, so any static host works. The build uses relative paths, so it runs at a domain root or under `/repo-name/`.

The site is public, but it contains no secrets. The key is only on your phone, and it's stored apart from backups, so it's never exported. Anyone else who opens the URL would need their own key. Your history also stays on your phone.

**Option A: GitHub Pages** (`.github/workflows/deploy.yml` is included)
```bash
git init && git add . && git commit -m "WOD Timer"
gh repo create wod-timer --public --source . --push   # .env is git-ignored
```
Then go to repo **Settings → Pages → Source: GitHub Actions**. Each push to `main` redeploys to `https://<user>.github.io/wod-timer/`. With a free GitHub plan, Pages needs a public repo.

**Option B: Cloudflare Pages** (no git needed)
```bash
npm run build
npx wrangler pages deploy dist --project-name wod-timer   # opens a browser to log in the first time
```
The app is served at `https://wod-timer.pages.dev`.

### Moving from the zbook copy
History is tied to the app's web address, so move it with a backup file:
1. In the **old** app (the `ts.net` address; restart it once so it has the Export button): **Settings → Backup & transfer → Export → Save to Files**.
2. Open the new URL in Safari and tap **Share → Add to Home Screen**. Then open it from the Home Screen, not Safari, because they keep separate storage.
3. In the new app: **Settings → AI provider**, choose Gemini or OpenAI, paste the key, tap **Test**, then **Save**.
4. **Settings → Backup & transfer → Import** and pick the file. Say yes to also restoring your equipment and coach instructions.
5. Delete the old Home Screen icon. You can also stop `wod-timer` and `tailscale serve` on the zbook.

Export regularly as a backup. Deleting the Home Screen app deletes its history.

## AI providers

Pick the provider in **Settings → AI provider**. Each provider keeps its own key and model, so you can switch back and forth. Every WOD card shows which model wrote it.

| | Gemini | OpenAI |
| --- | --- | --- |
| Key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Default model | `gemini-3.6-flash` | `gpt-5-mini` (change it to any model your key can use; **Test** checks it) |
| API | `generateContent` with `response_schema` | Responses API with strict `json_schema` output, `store: false` |
| "Thinking effort" setting | `thinking_config.thinking_level` | `reasoning.effort` (use **Model default** for non-reasoning models) |
| Server mode (`.env` on the zbook) | yes | no, phone key only |

A ChatGPT Plus/Pro subscription does **not** include API usage. The OpenAI API needs its own billing at platform.openai.com.

Tweaking a WOD continues the same conversation, even if you switch providers in between.

## Features

- **Generate:** choose the total work time, one or more muscle focuses (or leave it to the coach), the structure (**single WOD, 2 parts or 3 parts**) with a separate format for each part (e.g. Part 1 EMOM, Part 2 AMRAP), the 4-minute Tabata core finisher, and free-text notes.
- **Memory:** every WOD is saved on the device. Your most recent *completed* workouts (5 by default, with results and your "how did it feel" note) go into each new request, so the coach rotates muscle groups and adjusts loads. Use **History** to reopen, mark done, or delete workouts.
- **Tweak:** type feedback such as "replace the running with burpees", or tap a quick chip. This continues the same Gemini conversation, so the coach changes only what you asked for. Every change is listed on the card.
- **Backup:** Settings → Backup & transfer exports history, equipment, instructions and timer settings to a JSON file (iOS opens the share sheet). Import merges the file into your current history and skips duplicates.
- **Instructions:** in Settings you can edit the equipment list (add or remove items) and the full coach system prompt. The default comes from `gemini_gem.md`, and you can reset to it. Settings also has provider, model, thinking effort, and timer options.
- **Timer:**
  - AMRAP counts down. Tap the movement card when you finish each movement, and rounds are counted for you.
  - For Time counts up to the cap and stops automatically after the last movement of the last round.
  - EMOM switches movements every minute.
  - Tabata runs 20 s work / 10 s rest × 8.
  - The run order is: get-ready countdown, Part 1, rest, Part 2, and so on, then rest and the finisher. Set the rest length under **Settings → Rest between parts**. The screen stays awake.
- **Sounds:** halfway, last minute, 10 seconds, and 3-2-1 beeps before every interval or phase ends, plus spoken callouts such as "Minute 5. 12 Burpees". Use **Settings → Test sounds** to check the volume.

## Response format

The model is forced into JSON with `response_mime_type: "application/json"` plus a `response_schema`:

```json
{
  "title": "Posterior Powerhouse",
  "parts": [
    { "title": "Strength EMOM", "workout_type": "EMOM",  "time_cap_minutes": 12, "movements": [ { "name": "Kettlebell Swings", "reps_or_time": "15", "weight_rx": "24 kg" } ] },
    { "title": "Engine AMRAP",  "workout_type": "AMRAP", "time_cap_minutes": 12, "movements": [ { "name": "Run", "reps_or_time": "200 m", "weight_rx": "Bodyweight" } ] }
  ],
  "finisher": { "workout_type": "TABATA", "time_cap_minutes": 4, "movements": [ { "name": "Hollow Rocks", "reps_or_time": "20 sec", "weight_rx": "Bodyweight" } ] },
  "story_version": "Coaching notes..."
}
```

Each entry in `parts` (1 to 3) uses the original single-WOD fields: `workout_type`, `time_cap_minutes` and `movements[]`, plus an optional `rounds` for "3 rounds for time". `finisher` carries the Tabata core finisher that the Gem requires. WODs saved before multi-part support are converted to this shape when the app loads.

## Project layout

```
index.html              app shell (dashboard, history, settings, workout overlay)
vite.config.js          Gemini proxy (key injection) + service-worker build plugin
gemini_gem.md           default coach system instructions
src/main.js             UI wiring
src/llm/index.js        provider registry (Gemini / OpenAI)
src/llm/gemini.js       Gemini generateContent (direct with the phone's key, or via the proxy)
src/llm/openai.js       OpenAI Responses API + strict JSON schema conversion
src/llm/common.js       shared fetch / timeout / JSON parsing
src/prompt.js           system prompt, JSON schema, history/feedback prompts, validation
src/timer.js            workout plan builder + timer engine (cues, intervals, rounds)
src/audio.js            Web Audio beeps + speech callouts
src/storage.js          localStorage settings/history
src/format.js           HTML escaping + minimal markdown for coach notes
src/sw.js               service worker template (precache list injected at build)
public/manifest.json    PWA manifest
public/icons/           app icons
deploy/wod-timer.service systemd user unit (self-hosted mode)
.github/workflows/      GitHub Pages deploy (phone-only mode)
```

## Notes

- **iOS audio:** sounds unlock when you tap Start. The app sets `navigator.audioSession.type = 'transient'` so beeps play over your music. If the phone's silent switch still mutes them, that's iOS policy.
- **Locked screen:** iOS pauses JavaScript while the phone is locked. The timer tracks real elapsed time, so it is still correct when you unlock, but no beeps play while the phone is locked. Wake Lock keeps the screen on during a workout.
- **Offline:** once the app has loaded, you can open it and run the saved WODs without a connection. If the host doesn't answer within 3 seconds, the cached copy opens. Generating or tweaking a WOD needs the internet (and, in self-hosted mode, the zbook).
- **Data:** history lives in the home-screen app's local storage. Deleting the app deletes the history.

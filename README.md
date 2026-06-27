# e-Way Bill → JSON

Reads an Indian GST e-Way Bill **image** with an AI vision model and returns structured
JSON + an official-format PDF. Runs two ways:

- **Public website** on **Netlify** (static frontend + serverless functions, provider = Groq)
- **Local server** on your machine (Express, provider = Ollama / Groq / OpenAI)

---

## Deploy to Netlify (public site)

The repo is already configured (`netlify.toml`, `netlify/functions/`).

1. Push this project to a GitHub repo.
2. In Netlify: **Add new site → Import from Git** → pick the repo. Build settings are
   read from `netlify.toml` (publish `public/`, functions `netlify/functions/`).
3. **Site settings → Environment variables**, add:
   - `PROVIDER` = `groq`
   - `GROQ_API_KEY` = your key from <https://console.groq.com/keys>
   - *(optional)* `GROQ_MODEL` = `meta-llama/llama-4-scout-17b-16e-instruct`
4. **Deploy**. Your site is live at `https://<your-site>.netlify.app`.

CLI alternative: `npm i -g netlify-cli` then `netlify deploy --build --prod`.

### How it works on Netlify
- `public/index.html` is the static frontend. It reads the chosen image as base64 and
  POSTs JSON to the functions (no multipart, no disk writes).
- `netlify/functions/process.ts` — image → extracted JSON + PDF (returned inline as base64).
- `netlify/functions/parse_text.ts` — raw OCR text → same output.
- `/process`, `/parse_text`, `/health` are redirected to the functions (see `netlify.toml`).

> **Note:** functions run for a few seconds, so the cloud provider must be fast
> (Groq/OpenAI). Ollama is local-only and **cannot** run on Netlify. Request body limit
> is ~6 MB, so the UI caps uploads at 4 MB.

---

## Run locally

```bash
npm install
npm run dev            # ts-node, http://localhost:5000
```

Pick a provider via `.env` (copy `.env.example`):
- `PROVIDER=groq` + `GROQ_API_KEY` — cloud, fast (recommended)
- `PROVIDER=openai` + `OPENAI_API_KEY` — cloud, paid, most accurate
- `PROVIDER=ollama` — local, keyless, slow on CPU (needs `ollama pull gemma3:4b`)

CLI test: `npm run extract path/to/eway_bill.jpg`

## Endpoints
- `POST /process`     – `{ image_base64, mime }` → JSON + PDF (base64)
- `POST /parse_text`  – `{ text }` → JSON + PDF (base64)
- `GET  /health`      – `{ "status": "ok" }`

## Notes / limits
- A **public** site means anyone can spend your provider quota — Groq's free tier is a
  good fit; add stricter limits before heavy use.
- Images only for the vision path; PDFs would need rasterizing to images first.

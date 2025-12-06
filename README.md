# Smogon BBCode Formatter (Frontend-only)

## What this is
A browser-only tool that parses a Smogon forum thread (week) and optional Key OP thread to generate Smogon-formatted BBCode containing week headers, tier groups, replay links, and a KEY section.

## Files
- index.html
- style.css
- script.js

## Deploy (GitHub Pages)
1. Create a GitHub repo, upload these files to repo root.
2. In repo Settings → Pages → Source: select `main` branch root.
3. Save. Visit `https://<username>.github.io/<repo>/`.

## Deploy (Vercel)
1. Create new project → Import → Upload Folder.
2. Deploy (framework: Other, no build).
3. The site will be live.

## Notes about CORS and reliability
- This tool uses a public mirror (`api.allorigins.win`) as fallback. Mirrors may rate-limit. For reliable heavy use deploy a small serverless proxy (Cloudflare Workers or Vercel function). An example server proxy file is included below in "optional-proxy.js".

## Optional: server proxy (example)
If you want a reliable proxy, add a serverless function that accepts `?url=` and forwards the HTML with CORS allowed. Let me know and I will provide a Cloudflare Worker / Vercel API code snippet.

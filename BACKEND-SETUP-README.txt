Last Call Backend 2.5.15 — Render Ready

Put these files at the ROOT of the GitHub repo:

/
  package.json
  README.md
  .env.example
  .gitignore
  render.yaml
  /src
    server.js
  /content
    last-call-json-content-pack.json

Important Render settings:
- Root Directory: leave BLANK
- Build Command: npm install
- Start Command: npm start

If Render is currently trying to build from /src, clear the Root Directory field and redeploy.

This package already includes render.yaml so Render can use the correct root-based setup.

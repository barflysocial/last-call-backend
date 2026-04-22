# Last Call Multiplayer Backend — Truth Pack A/B/C Support

This backend version adds real **truth-pack-aware** behavior.

## What changed

The backend now truly respects the table's assigned truth pack:

- **Version A**
- **Version B**
- **Version C**

It uses the content file to control:

- clue timeline
- public clues
- role-specific app unlocks
- accusation answer key
- reveal payload

## How it works

### Base timeline
Version A acts as the base timeline.

### Replacements
Version B and Version C apply per-timestamp replacements on top of Version A:
- replace public clue text
- replace or add role/app entries
- keep the engine stable

That means weekly upkeep stays in JSON, not backend code.

## Persistence

This build still includes SQLite persistence:
- sessions survive restart
- claims survive restart
- joined players survive restart
- accusations survive restart
- reveal/reset state survives restart

## Install

```bash
npm install
npm start
```

## Environment

```bash
PORT=3000
DB_PATH=./data/last-call.sqlite
CONTENT_PATH=./content/last-call-json-content-pack.json
```

## Debug endpoints

### Health
`GET /health`

### Truth packs
`GET /api/debug/truth-packs`

### Persisted sessions
`GET /api/debug/persisted-sessions`

## Recommended next step

After this, the best next move is:
- update the connected player app so it uses backend-provided shared answer choices
- then deploy the full stack

## Update 2.1 full additions

This package includes:
- Versions A-F
- team_fill_order metadata
- per-role fill_order metadata
- per-version level metadata
- levels array for admin / frontend consumption

Current fill order:
1. Bartender
2. Security
3. Karaoke Host
4. Manager
5. Ex-Lover
6. Sound Tech

Current levels:
- version_a = Level 1
- version_b = Level 2
- version_c = Level 3
- version_d = Level 4
- version_e = Level 5
- version_f = Level 6

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../data/last-call.sqlite');
const CONTENT_PATH = process.env.CONTENT_PATH || path.resolve(__dirname, '../content/last-call-json-content-pack.json');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const contentPack = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code);
`);

const sessions = new Map();
const socketsBySession = new Map();

const ROLE_IDS = (contentPack.roles || []).map(r => r.id);
const ROLE_LABELS = Object.fromEntries((contentPack.roles || []).map(r => [r.id, r.label]));
const APP_IDS = (contentPack.apps || []).map(a => a.id);

const selectAllSessionsStmt = db.prepare(`SELECT id, data_json FROM sessions`);
const upsertSessionStmt = db.prepare(`
INSERT INTO sessions (id, code, title, created_at, data_json)
VALUES (@id, @code, @title, @createdAt, @dataJson)
ON CONFLICT(id) DO UPDATE SET
  code=excluded.code,
  title=excluded.title,
  created_at=excluded.created_at,
  data_json=excluded.data_json
`);
const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE id = ?`);

function nowMs() {
  return Date.now();
}

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function loadSessionsFromDb() {
  const rows = selectAllSessionsStmt.all();
  for (const row of rows) {
    try {
      const session = JSON.parse(row.data_json);
      sessions.set(session.id, session);
    } catch (err) {
      console.error('Failed to load session', row.id, err);
    }
  }
  console.log(`Loaded ${sessions.size} persisted session(s).`);
}

function persistSession(session) {
  upsertSessionStmt.run({
    id: session.id,
    code: session.code,
    title: session.title,
    createdAt: session.createdAt,
    dataJson: JSON.stringify(session),
  });
}

function removeSession(sessionId) {
  sessions.delete(sessionId);
  deleteSessionStmt.run(sessionId);
}

function getRoleInfo(roleId) {
  return (contentPack.roles || []).find(r => r.id === roleId) || null;
}

function getTruthPack(truthPackId) {
  if (contentPack.truth_packs && contentPack.truth_packs[truthPackId]) {
    return contentPack.truth_packs[truthPackId];
  }
  if (contentPack.truth_pack && truthPackId === 'version_a') {
    return contentPack.truth_pack;
  }
  if (contentPack.truthPack && truthPackId === 'version_a') {
    return contentPack.truthPack;
  }
  return null;
}

function listTruthPackIds() {
  if (contentPack.truth_packs) return Object.keys(contentPack.truth_packs);
  return ['version_a'];
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeTimelineItem(item) {
  return {
    t: Number(item.t || 0),
    public: item.public || null,
    notification: item.notification || null,
    entries: Array.isArray(item.entries) ? item.entries : [],
  };
}

function applyReplacementEntries(baseEntries, replacementEntries) {
  const next = [...baseEntries];
  for (const repl of replacementEntries) {
    const idx = next.findIndex(e => e.role === repl.role && e.app === repl.app);
    if (idx >= 0) next[idx] = repl;
    else next.push(repl);
  }
  return next;
}

function buildTimelineForTruthPack(truthPackId) {
  const basePack = getTruthPack('version_a') || {};
  const baseTimeline = Array.isArray(basePack.timeline) ? basePack.timeline.map(normalizeTimelineItem) : [];
  if (truthPackId === 'version_a') return baseTimeline;

  const pack = getTruthPack(truthPackId);
  if (!pack) return baseTimeline;

  const replacements = pack.replacements || {};
  return baseTimeline.map(item => {
    const key = String(item.t);
    if (!(key in replacements)) return deepClone(item);

    const replacement = replacements[key];
    const out = deepClone(item);

    if (Array.isArray(replacement)) {
      out.entries = applyReplacementEntries(out.entries, replacement);
      return out;
    }

    if (replacement && typeof replacement === 'object') {
      if ('public' in replacement) out.public = replacement.public;
      if ('notification' in replacement) out.notification = replacement.notification;
      if (Array.isArray(replacement.entries)) {
        out.entries = applyReplacementEntries(out.entries, replacement.entries);
      }
      return out;
    }

    return out;
  });
}

function getAnswerKey(truthPackId) {
  const pack = getTruthPack(truthPackId) || {};
  const killerRole = pack.killer_role || 'sound_tech';
  return {
    killer: ROLE_LABELS[killerRole] || killerRole,
    motive: pack.motive || null,
    method: pack.method || null,
    evidence: pack.strongest_evidence || null,
  };
}

function getRevealPayload(truthPackId) {
  const pack = getTruthPack(truthPackId) || {};
  return {
    truthPackId,
    killer: ROLE_LABELS[pack.killer_role] || pack.killer_role || 'Unknown',
    motive: pack.motive || null,
    method: pack.method || null,
    strongestEvidence: pack.strongest_evidence || null,
    revealCopy: pack.reveal_copy || null,
  };
}

function getPhase(table) {
  if (!table.startedAt) return 'lobby';
  if (table.revealedAt) return 'revealed';
  const elapsedSec = Math.floor((nowMs() - table.startedAt) / 1000);
  if (elapsedSec < 1800) return 'investigation';
  if (elapsedSec < 2700) return 'accusation';
  return 'accusation_locked';
}

function getElapsedSec(table) {
  if (!table.startedAt) return 0;
  return Math.max(0, Math.floor((nowMs() - table.startedAt) / 1000));
}

function publicTableView(table) {
  return {
    tableId: table.id,
    label: table.label,
    truthPackId: table.truthPackId,
    phase: getPhase(table),
    startedAt: table.startedAt,
    revealedAt: table.revealedAt,
    roleClaims: ROLE_IDS.map(roleId => ({
      roleId,
      roleLabel: ROLE_LABELS[roleId],
      claimed: Boolean(table.claims[roleId]),
      playerName: table.claims[roleId]?.playerName ?? null,
      playerId: table.claims[roleId]?.playerId ?? null,
    })),
    players: Object.values(table.players).map(p => ({
      playerId: p.id,
      playerName: p.playerName,
      instagramTag: p.instagramTag,
      roleId: p.roleId,
      joinedAt: p.joinedAt,
      submittedAt: p.submittedAt,
      solvedTier: p.solvedTier ?? null,
    })),
    timers: {
      elapsedSec: getElapsedSec(table),
      phase: getPhase(table),
      investigationEndsAt: table.startedAt ? table.startedAt + 1800 * 1000 : null,
      accusationEndsAt: table.startedAt ? table.startedAt + 2700 * 1000 : null,
    }
  };
}

function publicSessionView(session) {
  return {
    sessionId: session.id,
    code: session.code,
    title: session.title,
    createdAt: session.createdAt,
    availableTruthPacks: listTruthPackIds(),
    tables: Object.values(session.tables).map(publicTableView),
  };
}

function getUnlockedEntriesForRole(truthPackId, roleId, elapsedSec) {
  const timeline = buildTimelineForTruthPack(truthPackId);
  const apps = {};
  const publicClues = [];

  for (const appId of APP_IDS) {
    apps[appId] = [];
  }

  for (const item of timeline) {
    if (item.t > elapsedSec) continue;

    if (item.public) {
      publicClues.push({
        unlockedAtSec: item.t,
        text: item.public
      });
    }

    for (const entry of item.entries || []) {
      if (entry.role !== roleId) continue;
      if (!apps[entry.app]) apps[entry.app] = [];
      apps[entry.app].push({
        unlockedAtSec: item.t,
        title: entry.title,
        content: entry.content
      });
    }
  }

  return { apps, publicClues };
}

function privatePlayerView(session, table, player) {
  const elapsedSec = getElapsedSec(table);
  const phase = getPhase(table);
  const unlocked = getUnlockedEntriesForRole(table.truthPackId, player.roleId, elapsedSec);

  return {
    sessionId: session.id,
    code: session.code,
    tableId: table.id,
    truthPackId: table.truthPackId,
    phase,
    elapsedSec,
    player: {
      playerId: player.id,
      playerName: player.playerName,
      instagramTag: player.instagramTag,
      roleId: player.roleId,
      roleLabel: ROLE_LABELS[player.roleId],
      roleInfo: getRoleInfo(player.roleId),
      submittedAt: player.submittedAt,
      accusation: player.accusation,
      solvedTier: player.solvedTier ?? null,
    },
    answerChoices: contentPack.shared_accusation_choices || null,
    unlocks: unlocked,
    publicClues: unlocked.publicClues,
    apps: unlocked.apps,
  };
}

function evaluateAccusation(truthPackId, accusation) {
  const key = getAnswerKey(truthPackId);
  let correct = 0;
  if (accusation?.killer === key.killer) correct++;
  if (accusation?.motive === key.motive) correct++;
  if (accusation?.method === key.method) correct++;
  if (accusation?.evidence === key.evidence) correct++;

  let tier = 'failed';
  if (correct === 4) tier = 'perfect_solve';
  else if (accusation?.killer === key.killer && correct >= 3) tier = 'solved';
  else if (correct >= 2) tier = 'partial';

  return { correct, tier, key };
}

function broadcastSession(sessionId, payload) {
  const sockets = socketsBySession.get(sessionId);
  if (!sockets) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function persistAndBroadcast(session, payload) {
  persistSession(session);
  broadcastSession(session.id, payload);
}

function requireSession(req, res) {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return session;
}

function requireTable(req, res) {
  const session = requireSession(req, res);
  if (!session) return null;
  const table = session.tables[req.params.tableId];
  if (!table) {
    res.status(404).json({ error: 'Table not found' });
    return null;
  }
  return { session, table };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    persistedSessions: sessions.size,
    dbPath: DB_PATH,
    contentPath: CONTENT_PATH,
    truthPacks: listTruthPackIds(),
  });
});

app.get('/api/debug/truth-packs', (_req, res) => {
  const packs = {};
  for (const truthPackId of listTruthPackIds()) {
    packs[truthPackId] = {
      answerKey: getAnswerKey(truthPackId),
      reveal: getRevealPayload(truthPackId),
      timelineLength: buildTimelineForTruthPack(truthPackId).length,
    };
  }
  res.json(packs);
});

app.get('/api/debug/persisted-sessions', (_req, res) => {
  res.json({
    count: sessions.size,
    sessions: Array.from(sessions.values()).map(publicSessionView)
  });
});

app.post('/api/sessions', (req, res) => {
  const title = req.body?.title || contentPack.title || 'Last Call';
  const tableCount = Math.max(1, Math.min(Number(req.body?.tableCount || 1), 20));

  const session = {
    id: randomUUID(),
    code: makeCode(),
    title,
    createdAt: nowMs(),
    tables: {},
  };

  for (let i = 1; i <= tableCount; i++) {
    const tableId = randomUUID();
    session.tables[tableId] = {
      id: tableId,
      label: `Table ${i}`,
      truthPackId: 'version_a',
      startedAt: null,
      revealedAt: null,
      claims: {},
      players: {},
    };
  }

  sessions.set(session.id, session);
  persistSession(session);
  res.status(201).json(publicSessionView(session));
});

app.get('/api/sessions/by-code/:code', (req, res) => {
  const session = Array.from(sessions.values()).find(s => s.code === req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(publicSessionView(session));
});

app.get('/api/sessions/:sessionId', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.json(publicSessionView(session));
});

app.post('/api/sessions/:sessionId/tables/:tableId/truth-pack', (req, res) => {
  const found = requireTable(req, res);
  if (!found) return;
  const { session, table } = found;
  const truthPackId = req.body?.truthPackId || 'version_a';
  if (!listTruthPackIds().includes(truthPackId)) {
    return res.status(400).json({ error: 'Invalid truthPackId' });
  }
  table.truthPackId = truthPackId;

  persistAndBroadcast(session, { type: 'table_updated', table: publicTableView(table) });
  res.json(publicTableView(table));
});

app.post('/api/sessions/:sessionId/tables/:tableId/join', (req, res) => {
  const found = requireTable(req, res);
  if (!found) return;
  const { session, table } = found;

  const playerName = String(req.body?.playerName || '').trim();
  const instagramTag = String(req.body?.instagramTag || '').trim();
  const roleId = req.body?.roleId;

  if (!playerName) return res.status(400).json({ error: 'playerName is required' });
  if (!ROLE_IDS.includes(roleId)) return res.status(400).json({ error: 'Invalid roleId' });
  if (table.claims[roleId]) return res.status(409).json({ error: 'Role already claimed' });

  const player = {
    id: randomUUID(),
    playerName,
    instagramTag,
    roleId,
    joinedAt: nowMs(),
    accusation: null,
    submittedAt: null,
    solvedTier: null,
  };

  table.players[player.id] = player;
  table.claims[roleId] = {
    playerId: player.id,
    playerName: player.playerName,
    joinedAt: player.joinedAt,
  };

  persistAndBroadcast(session, { type: 'table_updated', table: publicTableView(table) });
  res.status(201).json(privatePlayerView(session, table, player));
});

app.get('/api/sessions/:sessionId/tables/:tableId/players/:playerId', (req, res) => {
  const found = requireTable(req, res);
  if (!found) return;
  const { session, table } = found;
  const player = table.players[req.params.playerId];
  if (!player) return res.status(404).json({ error: 'Player not found' });

  res.json(privatePlayerView(session, table, player));
});

app.post('/api/sessions/:sessionId/tables/:tableId/start', (req, res) => {
  const found = requireTable(req, res);
  if (!found) return;
  const { session, table } = found;
  if (!table.startedAt) table.startedAt = nowMs();
  table.revealedAt = null;

  persistAndBroadcast(session, { type: 'table_started', table: publicTableView(table) });
  res.json(publicTableView(table));
});

app.post('/api/sessions/:sessionId/tables/:tableId/players/:playerId/accuse', (req, res) => {
  const found = requireTable(req, res);
  if (!found) return;
  const { session, table } = found;
  const player = table.players[req.params.playerId];
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const phase = getPhase(table);
  if (!['accusation', 'accusation_locked'].includes(phase)) {
    return res.status(409).json({ error: 'Accusation phase is not open' });
  }
  if (player.submittedAt) {
    return res.status(409).json({ error: 'Player already submitted' });
  }

  const accusation = {
    killer: req.body?.killer || null,
    motive: req.body?.motive || null,
    method: req.body?.method || null,
    evidence: req.body?.evidence || null,
  };

  player.accusation = accusation;
  player.submittedAt = nowMs();

  const result = evaluateAccusation(table.truthPackId, accusation);
  player.solvedTier = result.tier;

  persistAndBroadcast(session, {
    type: 'player_submitted',
    tableId: table.id,
    playerId: player.id,
    solvedTier: player.solvedTier
  });

  res.json({
    playerId: player.id,
    submittedAt: player.submittedAt,
    accusation,
    result,
  });
});

app.post('/api/sessions/:sessionId/tables/:tableId/reveal', (req, res) => {
  const found = requireTable(req, res);
  if (!found) return;
  const { session, table } = found;
  table.revealedAt = nowMs();

  const reveal = getRevealPayload(table.truthPackId);
  persistAndBroadcast(session, { type: 'table_revealed', tableId: table.id, reveal });
  res.json(reveal);
});

app.post('/api/sessions/:sessionId/tables/:tableId/reset', (req, res) => {
  const found = requireTable(req, res);
  if (!found) return;
  const { session, table } = found;

  table.startedAt = null;
  table.revealedAt = null;
  table.claims = {};
  table.players = {};

  persistAndBroadcast(session, { type: 'table_reset', table: publicTableView(table) });
  res.json(publicTableView(table));
});

app.delete('/api/sessions/:sessionId', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  removeSession(session.id);
  broadcastSession(session.id, { type: 'session_deleted', sessionId: session.id });
  res.json({ ok: true, deletedSessionId: session.id });
});

app.get('/api/sessions/:sessionId/tables/:tableId/host-summary', (req, res) => {
  const found = requireTable(req, res);
  if (!found) return;
  const { table } = found;

  const winners = Object.values(table.players).filter(p => ['solved', 'perfect_solve'].includes(p.solvedTier)).length;
  const submitted = Object.values(table.players).filter(p => p.submittedAt).length;

  res.json({
    table: publicTableView(table),
    hostSummary: {
      joinedCount: Object.keys(table.players).length,
      submittedCount: submitted,
      winnerCount: winners,
      phase: getPhase(table),
      elapsedSec: getElapsedSec(table),
    }
  });
});

const server = app.listen(PORT, () => {
  console.log(`Last Call backend with truth-pack support listening on http://localhost:${PORT}`);
  console.log(`SQLite DB: ${DB_PATH}`);
  console.log(`Content: ${CONTENT_PATH}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId || !sessions.has(sessionId)) {
    ws.close();
    return;
  }

  if (!socketsBySession.has(sessionId)) socketsBySession.set(sessionId, new Set());
  socketsBySession.get(sessionId).add(ws);

  ws.send(JSON.stringify({ type: 'connected', sessionId }));

  ws.on('close', () => {
    const bucket = socketsBySession.get(sessionId);
    if (!bucket) return;
    bucket.delete(ws);
    if (bucket.size === 0) socketsBySession.delete(sessionId);
  });
});

loadSessionsFromDb();

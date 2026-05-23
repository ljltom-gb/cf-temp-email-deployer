'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { deploy } = require('./lib/deployer');

const PORT = Number(process.env.PORT || 5180);
const WORK_DIR = path.resolve(__dirname, 'work');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function makeSession() {
  const id = `dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id,
    events: [],
    listeners: new Set(),
    state: 'pending',
    result: null,
    error: null,
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

function pushEvent(session, evt) {
  session.events.push(evt);
  try {
    const tag = evt.type === 'log' ? '[log]' : `[${evt.type}${evt.id ? ':' + evt.id : ''}${evt.status ? '/' + evt.status : ''}]`;
    const msg = evt.message || evt.line || (evt.result ? 'OK' : '');
    console.log(`[${session.id}] ${tag} ${msg}`.slice(0, 500));
  } catch {}
  for (const res of session.listeners) {
    try {
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      session.listeners.delete(res);
    }
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/deploy', async (req, res) => {
  const { email, apiKey, domains, workerName, pagesProjectName, d1Name, skipPages, skipEmailRouting } = req.body || {};

  if (!email || !apiKey || !Array.isArray(domains) || domains.length === 0) {
    return res.status(400).json({ error: 'email / apiKey / domains 必填' });
  }

  const session = makeSession();
  res.json({ sessionId: session.id });

  fs.mkdirSync(WORK_DIR, { recursive: true });

  setImmediate(async () => {
    session.state = 'running';
    pushEvent(session, { type: 'stage', id: 'init', status: 'running', message: '启动部署', ts: Date.now() });
    try {
      const result = await deploy(
        {
          email,
          apiKey,
          domains,
          workerName,
          pagesProjectName,
          d1Name,
          skipPages: !!skipPages,
          skipEmailRouting: !!skipEmailRouting,
          workDir: WORK_DIR,
        },
        (evt) => pushEvent(session, evt)
      );
      session.state = 'done';
      session.result = result;
      pushEvent(session, { type: 'done', result, ts: Date.now() });
    } catch (err) {
      session.state = 'error';
      session.error = err.message || String(err);
      pushEvent(session, {
        type: 'error',
        message: err.message || String(err),
        stack: err.stack || null,
        ts: Date.now(),
      });
    } finally {
      for (const r of session.listeners) {
        try { r.end(); } catch {}
      }
      session.listeners.clear();
    }
  });
});

app.get('/api/logs/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end('session not found');

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: 5000\n\n`);

  for (const evt of session.events) {
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  if (session.state === 'done' || session.state === 'error') {
    return res.end();
  }

  session.listeners.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`); }
    catch { clearInterval(heartbeat); }
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    session.listeners.delete(res);
  });
});

app.get('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({
    id: s.id,
    state: s.state,
    result: s.result,
    error: s.error,
    eventCount: s.events.length,
  });
});

app.get('/api/sessions/:id/events', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ id: s.id, state: s.state, events: s.events });
});

app.get('/api/sessions', (req, res) => {
  const list = [...sessions.values()].map((s) => ({
    id: s.id,
    state: s.state,
    eventCount: s.events.length,
    createdAt: s.createdAt,
  }));
  res.json(list);
});

app.listen(PORT, () => {
  console.log(`\n  CF Temp-Email 一键部署器已启动`);
  console.log(`  打开浏览器访问: http://localhost:${PORT}\n`);
});

const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const MODEL = process.env.MODEL || 'qwen2.5-coder:7b';
const MEMORY_PATH = process.env.SESSION_FILE || path.join(__dirname, 'data', 'memory.json');
const SYSTEM_PROMPT = `You are a helpful AI assistant. Answer clearly and briefly unless the user asks otherwise.`;
const MAX_HISTORY_TURNS = 8;
const MAX_MEMORY_ITEMS = 5;
const FETCH_TIMEOUT_MS = 60000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function ensureDataDir() {
  const dir = path.dirname(MEMORY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function migrateLegacyStore(parsed) {
  if (Array.isArray(parsed)) {
    return { session: parsed, memory: [] };
  }

  return {
    session: Array.isArray(parsed.session) ? parsed.session : [],
    memory: Array.isArray(parsed.memory) ? parsed.memory : []
  };
}

function loadStore() {
  try {
    if (!fs.existsSync(MEMORY_PATH)) {
      return { session: [], memory: [] };
    }

    const raw = fs.readFileSync(MEMORY_PATH, 'utf8');
    if (!raw) {
      return { session: [], memory: [] };
    }

    const parsed = JSON.parse(raw);
    return migrateLegacyStore(parsed);
  } catch (error) {
    console.error('Failed to load store:', error);
    return { session: [], memory: [] };
  }
}

function saveStore(store) {
  try {
    ensureDataDir();
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save store:', error);
  }
}

function getRecentSession(session) {
  return session.slice(-MAX_HISTORY_TURNS);
}

function normalizeText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getRelevantMemory(userText, memory) {
  if (!memory.length) {
    return [];
  }

  const query = normalizeText(userText);
  const terms = Array.from(new Set(query.match(/\b[a-z0-9']{3,}\b/g) || []));

  const scored = memory
    .map((item) => {
      const score = terms.reduce((sum, term) => {
        return sum + (normalizeText(item.text).includes(term) ? 1 : 0);
      }, 0);
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MEMORY_ITEMS)
    .map(({ item }) => item);

  return scored;
}

function buildPrompt(store, userText) {
  const lines = [SYSTEM_PROMPT, ''];
  const relevantMemory = getRelevantMemory(userText, store.memory);

  if (relevantMemory.length) {
    lines.push('Relevant memory for this conversation:');
    relevantMemory.forEach((item) => {
      lines.push(`- ${item.text}`);
    });
    lines.push('');
  }

  const recentSession = getRecentSession(store.session);
  recentSession.forEach((message) => {
    if (message.role === 'user') {
      lines.push(`User: ${message.text}`);
    } else if (message.role === 'assistant') {
      lines.push(`Assistant: ${message.text}`);
    }
  });

  lines.push(`User: ${userText}`);
  lines.push('Assistant:');
  return lines.join('\n');
}

function extractMemoryNote(text) {
  const normalized = normalizeText(text);

  const rememberMatch = text.match(/remember (?:that )?(.*)/i);
  if (rememberMatch && rememberMatch[1]) {
    return rememberMatch[1].trim();
  }

  const myNameMatch = text.match(/my name is ([^.,!]+)/i);
  if (myNameMatch) {
    return `User name is ${myNameMatch[1].trim()}`;
  }

  const iLikeMatch = text.match(/i (?:like|love|prefer) ([^.,!]+)/i);
  if (iLikeMatch) {
    return `User likes ${iLikeMatch[1].trim()}`;
  }

  return null;
}

function updatePersistentMemory(text, store) {
  const note = extractMemoryNote(text);
  if (!note) {
    return null;
  }

  const existing = store.memory.find((item) => normalizeText(item.text) === normalizeText(note));
  if (existing) {
    return null;
  }

  const memoryItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    text: note,
    createdAt: new Date().toISOString()
  };

  store.memory.push(memoryItem);
  return memoryItem;
}

function extractLocation(text) {
  const locationMatch = text.match(/\b(?:in|for)\s+([A-Za-z\s]{2,40})/i);
  if (locationMatch) {
    return locationMatch[1].trim();
  }

  const cityMatch = text.match(/\b(Bangalore|Delhi|Mumbai|Chennai|Kolkata|Hyderabad|Pune|Bengaluru)\b/i);
  if (cityMatch) {
    return cityMatch[1];
  }

  return null;
}

async function fetchWeather(location) {
  const target = location ? encodeURIComponent(location) : 'World';
  const url = `https://wttr.in/${target}?format=3&lang=en`;

  const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'local-ai-assistant/1.0' } });
  if (!response.ok) {
    throw new Error(`Weather fetch failed (${response.status})`);
  }

  return (await response.text()).trim();
}

function isWeatherRequest(text) {
  const lower = normalizeText(text);
  return /\b(weather|forecast|temperature|rain|sunny|cloudy|wind|humidity)\b/.test(lower);
}

async function tryHandleLiveWeather(text) {
  if (!isWeatherRequest(text)) {
    return null;
  }

  const location = extractLocation(text);
  if (!location) {
    return 'I can fetch live weather if you give me a location like "weather in Bangalore".';
  }

  return await fetchWeather(location);
}

app.get('/api/history', (req, res) => {
  const store = loadStore();
  res.json({ history: store.session });
});

app.get('/api/memory', (req, res) => {
  const store = loadStore();
  res.json({ memory: store.memory });
});

app.post('/api/clear', (req, res) => {
  const store = loadStore();
  store.session = [];
  saveStore(store);
  res.json({ status: 'ok' });
});

app.post('/api/chat', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text in request body.' });
  }

  const store = loadStore();
  const userMessage = { role: 'user', text, createdAt: new Date().toISOString() };
  store.session.push(userMessage);

  const memoryNote = updatePersistentMemory(text, store);
  if (memoryNote) {
    saveStore(store);
  }

  try {
    const liveWeather = await tryHandleLiveWeather(text);
    if (liveWeather) {
      const assistantMessage = { role: 'assistant', text: liveWeather, createdAt: new Date().toISOString() };
      store.session.push(assistantMessage);
      saveStore(store);
      return res.json({ text: liveWeather, history: store.session });
    }
  } catch (error) {
    console.error('Live weather fetch failed:', error);
  }

  const prompt = buildPrompt(store, text);
  const body = {
    model: MODEL,
    prompt,
    max_tokens: 256,
    temperature: 0.7,
    top_p: 0.9,
    stop: ['User:', 'Assistant:']
  };

  let assistantText = '';

  try {
    const response = await fetchWithTimeout(`${OLLAMA_URL}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Ollama API error:', response.status, errorText);
      return res.status(502).json({ error: 'Ollama API request failed.', details: errorText });
    }

    const data = await response.json();
    assistantText = data.choices?.[0]?.text?.trim() || '';
    if (!assistantText) {
      return res.status(502).json({ error: 'Ollama returned no assistant text.' });
    }
  } catch (error) {
    console.error('Chat request failed:', error);
    const details = error.name === 'AbortError'
      ? 'Ollama request timed out after 60 seconds. The model may still be loading.'
      : error.message;
    return res.status(502).json({ error: 'Failed to reach Ollama.', details });
  }

  const assistantMessage = { role: 'assistant', text: assistantText, createdAt: new Date().toISOString() };
  store.session.push(assistantMessage);
  saveStore(store);

  res.json({ text: assistantText, history: store.session });
});

app.listen(PORT, () => {
  console.log(`Assistant UI running on http://0.0.0.0:${PORT}`);
});

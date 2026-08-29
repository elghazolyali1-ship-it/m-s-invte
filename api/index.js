require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { getGuestsCollection } = require('../lib/db');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
// The envelope page, its CSS/JS and the admin panel
app.use(express.static(path.join(__dirname, '..', 'public')));
// The full invitation site (the Tilda export) that appears once the
// envelope opens
app.use('/invitation', express.static(path.join(__dirname, '..', 'invitation')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSlug() {
  return crypto.randomBytes(4).toString('hex'); // e.g. "a13f9c02"
}

function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u0600-\u06FF-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({ error: 'ADMIN_KEY is not configured on the server' });
  }
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// ---------------------------------------------------------------------------
// Public API — only ever returns a guest's display name, nothing sensitive
// ---------------------------------------------------------------------------
app.get('/api/guest/:slug', async (req, res) => {
  try {
    const guests = await getGuestsCollection();
    const guest = await guests.findOne({ slug: req.params.slug });
    if (!guest) return res.status(404).json({ error: 'not found' });
    res.json({ name: guest.name, slug: guest.slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// ---------------------------------------------------------------------------
// Admin API — protected with the x-admin-key header
// ---------------------------------------------------------------------------

// Add a single guest: { "name": "علي محمد حسن", "slug": "optional-custom-slug" }
app.post('/api/guests', requireAdmin, async (req, res) => {
  try {
    const { name, slug: requestedSlug } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const guests = await getGuestsCollection();

    let slug = requestedSlug ? slugify(requestedSlug) : makeSlug();
    if (!slug) slug = makeSlug();

    // avoid collisions, retry a few times with a fresh random slug if needed
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await guests.insertOne({ name: String(name).trim(), slug, createdAt: new Date() });
        return res.status(201).json({ name, slug, url: `${baseUrl(req)}/i/${slug}` });
      } catch (err) {
        if (err.code === 11000) {
          slug = makeSlug(); // slug taken, try another
          continue;
        }
        throw err;
      }
    }
    res.status(500).json({ error: 'could not generate a unique link, try again' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Add many guests at once: { "names": ["اسم 1", "اسم 2", ...] }
app.post('/api/guests/bulk', requireAdmin, async (req, res) => {
  try {
    const { names } = req.body || {};
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'names must be a non-empty array' });
    }
    const guests = await getGuestsCollection();
    const results = [];
    for (const rawName of names) {
      const name = String(rawName).trim();
      if (!name) continue;
      let slug = makeSlug();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await guests.insertOne({ name, slug, createdAt: new Date() });
          results.push({ name, slug, url: `${baseUrl(req)}/i/${slug}` });
          break;
        } catch (err) {
          if (err.code === 11000) {
            slug = makeSlug();
            continue;
          }
          throw err;
        }
      }
    }
    res.status(201).json({ created: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// List all guests + their links
app.get('/api/guests', requireAdmin, async (req, res) => {
  try {
    const guests = await getGuestsCollection();
    const all = await guests.find({}).sort({ createdAt: -1 }).toArray();
    res.json(
      all.map((g) => ({
        name: g.name,
        slug: g.slug,
        url: `${baseUrl(req)}/i/${g.slug}`,
        createdAt: g.createdAt,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Delete a guest
app.delete('/api/guests/:slug', requireAdmin, async (req, res) => {
  try {
    const guests = await getGuestsCollection();
    await guests.deleteOne({ slug: req.params.slug });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const invitationPath = path.join(__dirname, '..', 'invitation', 'index.html');
let invitationHtmlCache = null;

function getInvitationHtml() {
  // Cache in memory; re-read if the file changes (helps in local dev)
  const stat = fs.statSync(invitationPath);
  if (!invitationHtmlCache || invitationHtmlCache.mtimeMs !== stat.mtimeMs) {
    const raw = fs.readFileSync(invitationPath, 'utf8');
    invitationHtmlCache = { mtimeMs: stat.mtimeMs, raw };
  }
  return invitationHtmlCache.raw;
}

// When served at /i/<slug> the page's relative "images/..." paths would
// otherwise resolve against /i/ instead of /invitation/, so we inject a
// <base> tag only for this route. The file on disk stays untouched, so
// double-clicking invitation/index.html or visiting /invitation/index.html
// directly still works with plain relative paths.
function sendInvitationWithBase(res) {
  const html = getInvitationHtml().replace(
    '<meta charset="utf-8"/>',
    '<meta charset="utf-8"/>\n        <base href="/invitation/">'
  );
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// Personalized invitation link: /i/<slug>
// This serves the real invitation page itself. Its own script reads the
// slug from the URL and fills in the guest's name.
app.get('/i/:slug', (req, res) => {
  sendInvitationWithBase(res);
});

// Generic (non-personalized) invitation, useful for testing
app.get('/i', (req, res) => {
  sendInvitationWithBase(res);
});

// Root: the plain invitation (no personalization), useful as a fallback/preview
app.get('/', (req, res) => {
  sendInvitationWithBase(res);
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Run locally with `node api/index.js` / `npm run dev`
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

module.exports = app;

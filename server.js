const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const articles = require('./data/articles');

const app = express();
app.use(cors());
app.use(express.json());

let subscriptions = [];

webpush.setVapidDetails(
  'mailto:hello@gabsport.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme123';
console.log('ADMIN_SECRET is set to:', JSON.stringify(ADMIN_SECRET));

const DATA_FILE = path.join(__dirname, 'data', 'articles.js');

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const FOOTBALL_API_BASE = 'https://api.football-data.org/v4';
const COMPETITIONS = 'PL,PD,SA,BL1,FL1,CL';

async function fetchFootballData(path) {
  const res = await fetch(`${FOOTBALL_API_BASE}${path}`, {
    headers: { 'X-Auth-Token': FOOTBALL_API_KEY },
  });
  if (!res.ok) throw new Error(`Football API error: ${res.status}`);
  return res.json();
}

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  const exists = subscriptions.find((s) => s.endpoint === subscription.endpoint);
  if (!exists) subscriptions.push(subscription);
  res.status(201).json({ message: 'Subscribed' });
});

app.post('/api/notify', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { title, body, url } = req.body;
  const payload = JSON.stringify({ title, body, url: url || '/' });

  const results = await Promise.allSettled(
    subscriptions.map((sub) => webpush.sendNotification(sub, payload))
  );

  subscriptions = subscriptions.filter((_, i) => results[i].status === 'fulfilled');

  res.json({ sent: results.filter((r) => r.status === 'fulfilled').length });
});

app.get('/api/articles', (req, res) => {
  const { category, subcategory } = req.query;
  let result = articles;
  if (category) {
    result = result.filter((a) => a.category.toLowerCase() === category.toLowerCase());
  }
  if (subcategory) {
    result = result.filter(
      (a) => a.subcategory && a.subcategory.toLowerCase() === subcategory.toLowerCase()
    );
  }
  res.json(result);
});

app.get('/api/articles/:slug', (req, res) => {
  const article = articles.find((a) => a.slug === req.params.slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
});

app.post('/api/articles', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { title, excerpt, content, category, subcategory, image, author } = req.body;
  if (!title || !excerpt || !content || !category || !image || !author) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const newArticle = {
    slug,
    title,
    excerpt,
    content,
    category,
    subcategory: subcategory || null,
    image,
    author,
    date: new Date().toISOString().split('T')[0],
  };

  articles.unshift(newArticle);

  const fileContent = `const articles = ${JSON.stringify(articles, null, 2)};\n\nmodule.exports = articles;\n`;
  fs.writeFileSync(DATA_FILE, fileContent);

  const payload = JSON.stringify({
    title: 'New Article on gabsport',
    body: newArticle.title,
    url: `/article/${newArticle.slug}`,
  });
  Promise.allSettled(subscriptions.map((sub) => webpush.sendNotification(sub, payload)));

  res.status(201).json(newArticle);
});

app.get('/api/live-scores', async (req, res) => {
  try {
    const data = await fetchFootballData(`/matches?competitions=${COMPETITIONS}&status=LIVE`);
    res.json(data.matches || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/results', async (req, res) => {
  try {
    const data = await fetchFootballData(`/matches?competitions=${COMPETITIONS}&status=FINISHED`);
    const recent = (data.matches || []).slice(-20).reverse();
    res.json(recent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fixtures', async (req, res) => {
  try {
    const data = await fetchFootballData(`/matches?competitions=${COMPETITIONS}&status=SCHEDULED`);
    const upcoming = (data.matches || []).slice(0, 20);
    res.json(upcoming);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/standings', async (req, res) => {
  const { competition } = req.query;
  if (!competition) return res.status(400).json({ error: 'Missing competition code' });
  try {
    const data = await fetchFootballData(`/competitions/${competition}/standings`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

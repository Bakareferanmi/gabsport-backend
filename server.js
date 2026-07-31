const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const app = express();

const ALLOWED_ORIGINS = [
  'https://gabsport.vercel.app',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (e.g. curl, server-to-server, mobile app webviews)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
}));
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err.message));

const articleSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true },
  title: String,
  excerpt: String,
  content: String,
  category: String,
  subcategory: String,
  image: String,
  author: String,
  date: String,
  publishAt: { type: Date, default: Date.now },
  notified: { type: Boolean, default: false },
});

const Article = mongoose.model('Article', articleSchema);

const subscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: String,
    auth: String,
  },
});

const Subscription = mongoose.model('Subscription', subscriptionSchema);

const upload = multer({ storage: multer.memoryStorage() });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

webpush.setVapidDetails(
  'mailto:hello@gabsport.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const ADMIN_SECRETS = [
  process.env.ADMIN_SECRET,
  process.env.ADMIN_SECRET_2,
].filter(Boolean);

if (ADMIN_SECRETS.length === 0) {
  console.error('FATAL: No ADMIN_SECRET environment variable set. Refusing to start.');
  process.exit(1);
}
console.log('Number of admin passwords configured:', ADMIN_SECRETS.length);

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

function checkAdmin(req, res) {
  const secret = req.headers['x-admin-secret'];
  if (!ADMIN_SECRETS.includes(secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Limits admin-protected routes to 20 requests per minute per IP,
// so a script can't brute-force the admin password.
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests, please wait a minute and try again.' },
});

app.post('/api/subscribe', async (req, res) => {
  const subscription = req.body;
  try {
    const exists = await Subscription.findOne({ endpoint: subscription.endpoint });
    if (!exists) {
      await Subscription.create(subscription);
    }
    res.status(201).json({ message: 'Subscribed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notify', adminLimiter, async (req, res) => {
  if (!checkAdmin(req, res)) return;

  const { title, body, url } = req.body;
  const payload = JSON.stringify({ title, body, url: url || '/' });

  const subs = await Subscription.find();
  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, payload))
  );

  const failedIds = subs
    .filter((_, i) => results[i].status === 'rejected')
    .map((s) => s._id);
  if (failedIds.length) {
    await Subscription.deleteMany({ _id: { $in: failedIds } });
  }

  res.json({ sent: results.filter((r) => r.status === 'fulfilled').length });
});

app.get('/api/articles', async (req, res) => {
  const { category, subcategory, page, limit, q } = req.query;
  const filter = { publishAt: { $lte: new Date() } };
  if (category) filter.category = category;
  if (subcategory) filter.subcategory = subcategory;
  if (q && q.trim()) {
    // Escape regex special characters so user input can't break the query
    const safeQuery = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(safeQuery, 'i');
    filter.$or = [
      { title: searchRegex },
      { excerpt: searchRegex },
      { category: searchRegex },
      { subcategory: searchRegex },
    ];
  }

  try {
    // Paginated mode: only kicks in when ?page= is provided, so every
    // existing page that calls this route without ?page= keeps working
    // exactly as before, unpaginated.
    if (page) {
      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const pageSize = Math.min(Math.max(parseInt(limit, 10) || 7, 1), 50);
      const totalArticles = await Article.countDocuments(filter);
      const totalPages = Math.max(Math.ceil(totalArticles / pageSize), 1);

      const result = await Article.find(filter)
        .sort({ publishAt: -1 })
        .skip((pageNum - 1) * pageSize)
        .limit(pageSize);

      return res.json({
        articles: result,
        currentPage: pageNum,
        totalPages,
        totalArticles,
      });
    }

    const result = await Article.find(filter).sort({ publishAt: -1 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/articles/:slug', async (req, res) => {
  try {
    const article = await Article.findOne({
      slug: req.params.slug,
      publishAt: { $lte: new Date() },
    });
    if (!article) return res.status(404).json({ error: 'Article not found' });
    res.json(article);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/articles', adminLimiter, async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const result = await Article.find().sort({ publishAt: -1 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-image', adminLimiter, upload.single('image'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided' });
  }

  try {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'gabsport' },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(req.file.buffer);
    });
    res.json({ url: uploadResult.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/articles', adminLimiter, async (req, res) => {
  if (!checkAdmin(req, res)) return;

  const { title, excerpt, content, category, subcategory, image, author, publishAt } = req.body;
  if (!title || !excerpt || !content || !category || !image || !author) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const scheduledDate = publishAt ? new Date(publishAt) : new Date();
  const isLiveNow = scheduledDate <= new Date();

  try {
    const newArticle = await Article.create({
      slug,
      title,
      excerpt,
      content,
      category,
      subcategory: subcategory || null,
      image,
      author,
      date: new Date().toISOString().split('T')[0],
      publishAt: scheduledDate,
      notified: isLiveNow,
    });

    if (isLiveNow) {
      const payload = JSON.stringify({
        title: 'New Article on gabsport',
        body: newArticle.title,
        url: `/article/${newArticle.slug}`,
      });
      const subs = await Subscription.find();
      Promise.allSettled(subs.map((sub) => webpush.sendNotification(sub, payload)));
    }

    res.status(201).json(newArticle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/articles/:slug', adminLimiter, async (req, res) => {
  if (!checkAdmin(req, res)) return;

  try {
    const deleted = await Article.findOneAndDelete({ slug: req.params.slug });
    if (!deleted) return res.status(404).json({ error: 'Article not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

let lastKnownMatches = {};

async function checkForMatchUpdates() {
  try {
    const data = await fetchFootballData(`/matches?competitions=${COMPETITIONS}`);
    const matches = data.matches || [];

    for (const match of matches) {
      const prev = lastKnownMatches[match.id];
      const currentScore = `${match.score.fullTime.home}-${match.score.fullTime.away}`;

      if (!prev) {
        lastKnownMatches[match.id] = { status: match.status, score: currentScore };
        continue;
      }

      if (prev.status !== 'IN_PLAY' && match.status === 'IN_PLAY') {
        await broadcastNotification(
          'Match Started',
          `${match.homeTeam.name} vs ${match.awayTeam.name} is live now`,
          '/live-scores'
        );
      }

      if (prev.score !== currentScore && match.status === 'IN_PLAY') {
        await broadcastNotification(
          'Goal!',
          `${match.homeTeam.name} ${match.score.fullTime.home} - ${match.score.fullTime.away} ${match.awayTeam.name}`,
          '/live-scores'
        );
      }

      if (prev.status !== 'FINISHED' && match.status === 'FINISHED') {
        await broadcastNotification(
          'Full Time',
          `${match.homeTeam.name} ${match.score.fullTime.home} - ${match.score.fullTime.away} ${match.awayTeam.name}`,
          '/results'
        );
      }

      lastKnownMatches[match.id] = { status: match.status, score: currentScore };
    }
  } catch (err) {
    console.error('Match polling error:', err.message);
  }
}

async function checkScheduledArticles() {
  try {
    const dueArticles = await Article.find({
      publishAt: { $lte: new Date() },
      notified: false,
    });

    for (const article of dueArticles) {
      await broadcastNotification(
        'New Article on gabsport',
        article.title,
        `/article/${article.slug}`
      );
      article.notified = true;
      await article.save();
    }
  } catch (err) {
    console.error('Scheduled article check error:', err.message);
  }
}

async function broadcastNotification(title, body, url) {
  const payload = JSON.stringify({ title, body, url });
  const subs = await Subscription.find();
  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, payload))
  );
  const failedIds = subs
    .filter((_, i) => results[i].status === 'rejected')
    .map((s) => s._id);
  if (failedIds.length) {
    await Subscription.deleteMany({ _id: { $in: failedIds } });
  }
}

setInterval(checkForMatchUpdates, 60000);
setInterval(checkScheduledArticles, 60000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

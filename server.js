const express = require('express');
const cors = require('cors');
const articles = require('./data/articles');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/articles', (req, res) => {
  const { category } = req.query;
  const result = category
    ? articles.filter((a) => a.category.toLowerCase() === category.toLowerCase())
    : articles;
  res.json(result);
});

app.get('/api/articles/:slug', (req, res) => {
  const article = articles.find((a) => a.slug === req.params.slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));


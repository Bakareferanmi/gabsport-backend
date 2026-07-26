require('dotenv').config();
const mongoose = require('mongoose');
const articles = require('./data/articles');

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
});

const Article = mongoose.model('Article', articleSchema);

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  let inserted = 0;
  let skipped = 0;

  for (const article of articles) {
    const exists = await Article.findOne({ slug: article.slug });
    if (exists) {
      console.log(`Skipping (already exists): ${article.title}`);
      skipped++;
      continue;
    }

    await Article.create(article);
    console.log(`Inserted: ${article.title}`);
    inserted++;
  }

  console.log(`\nDone. Inserted: ${inserted}, Skipped: ${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

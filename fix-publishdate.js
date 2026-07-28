require('dotenv').config();
const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema({
  slug: String,
  title: String,
  date: String,
  publishAt: Date,
  notified: Boolean,
});

const Article = mongoose.model('Article', articleSchema);

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const articles = await Article.find().lean();
  let fixed = 0;

  for (const article of articles) {
    if (!article.publishAt) {
      await Article.updateOne(
        { _id: article._id },
        { $set: { publishAt: new Date(article.date || Date.now()), notified: true } }
      );
      console.log(`Fixed: ${article.title}`);
      fixed++;
    }
  }

  console.log(`\nDone. Fixed: ${fixed}`);
  await mongoose.disconnect();
  process.exit(0);
}

fix().catch((err) => {
  console.error('Fix failed:', err);
  process.exit(1);
});

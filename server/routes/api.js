import express from 'express';
import { readArticlesFromDirectory } from '../services/fileReader.js';
import { clusterStories } from '../services/storyClusterer.js';
import { checkDuplicates } from '../services/duplicateChecker.js';
import { generateArticle } from '../services/articleWriter.js';
import { processImages } from '../services/imageProcessor.js';
import { publishDraft, getCategories, getAuthors } from '../services/wordpressPublisher.js';

const router = express.Router();

// ─── Load JSON files from directory ───────────────────────────────
router.post('/load-directory', async (req, res) => {
    try {
        const { directoryPath } = req.body;
        if (!directoryPath) {
            return res.status(400).json({ error: 'directoryPath is required' });
        }

        const { articles, errors } = await readArticlesFromDirectory(directoryPath);
        console.log(`📂 Loaded ${articles.length} articles from ${directoryPath}`);
        if (errors.length > 0) {
            console.warn(`⚠️  ${errors.length} files had errors`);
        }

        res.json({ articles, errors, count: articles.length });
    } catch (err) {
        console.error('Load directory error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Cluster similar stories ──────────────────────────────────────
router.post('/cluster-stories', async (req, res) => {
    try {
        const { articles } = req.body;
        if (!articles || !Array.isArray(articles)) {
            return res.status(400).json({ error: 'articles array is required' });
        }

        console.log(`🧩 Clustering ${articles.length} articles...`);
        const clusters = await clusterStories(articles);
        console.log(`✅ Found ${clusters.length} unique story clusters`);

        res.json({ clusters });
    } catch (err) {
        console.error('Clustering error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Check for duplicates in CMS ─────────────────────────────────
router.post('/check-duplicates', async (req, res) => {
    try {
        const { clusters } = req.body;
        if (!clusters || !Array.isArray(clusters)) {
            return res.status(400).json({ error: 'clusters array is required' });
        }

        console.log(`🔍 Checking ${clusters.length} clusters for duplicates...`);
        const checked = await checkDuplicates(clusters);
        const dupCount = checked.filter(c => c.duplicate).length;
        console.log(`✅ Found ${dupCount} duplicate(s)`);

        res.json({ clusters: checked });
    } catch (err) {
        console.error('Duplicate check error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Generate article for a cluster ──────────────────────────────
router.post('/write-article', async (req, res) => {
    try {
        const { cluster } = req.body;
        if (!cluster) {
            return res.status(400).json({ error: 'cluster object is required' });
        }

        const article = await generateArticle(cluster);
        res.json({ article });
    } catch (err) {
        console.error('Article generation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Publish draft to WordPress ──────────────────────────────────
router.post('/publish-draft', async (req, res) => {
    try {
        const { article } = req.body;
        if (!article) {
            return res.status(400).json({ error: 'article object is required' });
        }

        // Process images
        let imageData = null;
        if (article.images && article.images.length > 0) {
            console.log(`🖼️  Processing ${article.images.length} images...`);
            imageData = await processImages(article.images);
        }

        // Publish
        const result = await publishDraft(article, imageData);
        res.json({ result });
    } catch (err) {
        console.error('Publish error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Get WordPress metadata ──────────────────────────────────────
router.get('/wp-meta', async (req, res) => {
    try {
        const [categories, authors] = await Promise.all([
            getCategories(),
            getAuthors(),
        ]);
        res.json({ categories, authors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

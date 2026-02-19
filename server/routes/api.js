import express from 'express';
import path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { readArticlesFromDirectory } from '../services/fileReader.js';
import { clusterStories, learnForceMerge } from '../services/storyClusterer.js';
import { checkDuplicates } from '../services/duplicateChecker.js';
import { generateArticle } from '../services/articleWriter.js';
import { processImages } from '../services/imageProcessor.js';
import { publishDraft, getCategories, getAuthors, backfillDraftSeoMeta, getRecentPostsForSocial } from '../services/wordpressPublisher.js';
import { generateWithFlash, getUsageSnapshot, diffUsageSnapshots } from '../services/llmClient.js';

const router = express.Router();

async function scoreImageRelevance(image, article) {
    const prompt = `Score how relevant this image is to the article. Return JSON only.

Article title: ${JSON.stringify(article?.title || '')}
Article summary: ${JSON.stringify(String(article?.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900))}
Image URL: ${JSON.stringify(image?.originalUrl || '')}
Image dimensions: ${image?.width || 0}x${image?.height || 0}

Schema:
{
  "relevance_score": 0.0,
  "reason": "string"
}`;

    try {
        const scored = await generateWithFlash(prompt, { jsonMode: true, stage: 'image_relevance' });
        const value = Number(scored?.relevance_score);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
    } catch {
        return null;
    }
}

async function generateArticleSafe(cluster) {
    const beforeUsage = getUsageSnapshot();
    const startedAt = Date.now();
    try {
        const article = await generateArticle(cluster);
        const afterUsage = getUsageSnapshot();
        return {
            ok: true,
            article,
            diagnostics: article?.diagnostics || {},
            usage: diffUsageSnapshots(beforeUsage, afterUsage),
            durationMs: Date.now() - startedAt,
            error: null,
        };
    } catch (err) {
        const afterUsage = getUsageSnapshot();
        return {
            ok: false,
            article: null,
            diagnostics: {},
            usage: diffUsageSnapshots(beforeUsage, afterUsage),
            durationMs: Date.now() - startedAt,
            error: {
                message: err?.message || 'Article generation failed',
                code: err?.code || 'write_article_failed',
            },
        };
    }
}

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

// ─── Learn + force merge selected clusters (admin) ─────────────────
router.post('/learn-force-merge', async (req, res) => {
    try {
        const { clusters } = req.body;
        if (!clusters || !Array.isArray(clusters) || clusters.length < 2) {
            return res.status(400).json({ error: 'clusters array with at least 2 items is required' });
        }

        const result = await learnForceMerge(clusters);
        res.json(result);
    } catch (err) {
        console.error('Learn force-merge error:', err);
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

        const safe = await generateArticleSafe(cluster);
        if (!safe.ok) {
            return res.status(500).json({
                error: safe.error?.message || 'Article generation failed',
                diagnostics: safe.diagnostics,
                usage: safe.usage,
            });
        }
        res.json({ article: safe.article, diagnostics: safe.diagnostics, usage: safe.usage });
    } catch (err) {
        console.error('Article generation error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/write-article-safe', async (req, res) => {
    try {
        const { cluster } = req.body;
        if (!cluster) {
            return res.status(400).json({ error: 'cluster object is required' });
        }

        const payload = await generateArticleSafe(cluster);
        const status = payload.ok ? 200 : 500;
        res.status(status).json(payload);
    } catch (err) {
        console.error('Article safe-generation error:', err);
        res.status(500).json({
            ok: false,
            article: null,
            diagnostics: {},
            usage: {},
            error: {
                message: err.message,
                code: 'write_article_safe_failed',
            },
        });
    }
});

// ─── Publish draft to WordPress ──────────────────────────────────
router.post('/publish-draft', async (req, res) => {
    try {
        const { article } = req.body;
        if (!article) {
            return res.status(400).json({ error: 'article object is required' });
        }

        const beforeUsage = getUsageSnapshot();

        // Process images
        let imageData = null;
        if (article.images && article.images.length > 0) {
            console.log(`🖼️  Processing ${article.images.length} images...`);
            imageData = await processImages(article.images, {
                scoreImage: (image) => scoreImageRelevance(image, article),
            });
        }

        // Publish
        const result = await publishDraft(article, imageData);
        const afterUsage = getUsageSnapshot();
        res.json({ result, usage: diffUsageSnapshots(beforeUsage, afterUsage) });
    } catch (err) {
        console.error('Publish error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Backfill Yoast meta for existing draft posts (admin) ─────────
router.post('/backfill-draft-seo', async (req, res) => {
    try {
        const parsedLimit = Number(req.body?.limit);
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : undefined;
        const result = await backfillDraftSeoMeta({ limit });
        res.json(result);
    } catch (err) {
        console.error('Draft SEO backfill error:', err);
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

router.get('/recent-posts', async (req, res) => {
    try {
        const parsedLimit = Number(req.query?.limit);
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 20;
        const posts = await getRecentPostsForSocial({ limit });
        res.json({ posts, count: posts.length });
    } catch (err) {
        console.error('Recent posts fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/save-social-html', async (req, res) => {
    try {
        const outputDir = String(req.body?.outputDir || '').trim();
        const files = Array.isArray(req.body?.files) ? req.body.files : [];
        if (!outputDir) {
            return res.status(400).json({ error: 'outputDir is required' });
        }
        if (!path.isAbsolute(outputDir)) {
            return res.status(400).json({ error: 'outputDir must be an absolute path' });
        }
        if (!files.length) {
            return res.status(400).json({ error: 'files array is required' });
        }

        await mkdir(outputDir, { recursive: true });
        const saved = [];
        for (const file of files) {
            const name = String(file?.name || '').trim();
            const content = String(file?.content || '');
            if (!name || !name.endsWith('.html')) continue;
            const safeName = path.basename(name);
            const target = path.join(outputDir, safeName);
            await writeFile(target, content, 'utf8');
            saved.push(target);
        }

        res.json({ outputDir, saved, count: saved.length });
    } catch (err) {
        console.error('Save social html error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/usage-summary', async (_req, res) => {
    try {
        res.json({ usage: getUsageSnapshot() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

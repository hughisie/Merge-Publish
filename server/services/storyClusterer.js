import { generateWithPro } from './llmClient.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEARNED_RULES_PATH = path.resolve(__dirname, '../data/cluster-learned-merges.json');

const TYPE_RULES = [
    { type: 'whats_on', terms: ['festival', 'concert', 'exhibition', 'event', 'agenda', 'weekend', 'tickets', 'show'] },
    { type: 'review', terms: ['review', 'rated', 'critic', 'verdict', 'assessment'] },
    { type: 'recommendation', terms: ['best', 'guide', 'top', 'where to', 'recommend', 'must visit', 'tips'] },
    { type: 'feature', terms: ['inside', 'feature', 'profile', 'explainer', 'deep dive'] },
    { type: 'opinion', terms: ['opinion', 'editorial', 'commentary', 'column', 'viewpoint'] },
    { type: 'interview', terms: ['interview', 'q&a', 'speaks', 'exclusive with'] },
    { type: 'history', terms: ['history', 'historic', 'archive', 'anniversary', 'heritage'] },
    { type: 'news', terms: ['announced', 'approval', 'confirmed', 'reports', 'launch', 'vote', 'policy', 'court'] },
];

function normalizeTokens(text = '') {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);
}

function tokenSet(text = '') {
    return new Set(normalizeTokens(text));
}

function overlapScore(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const token of a) {
        if (b.has(token)) shared += 1;
    }
    return shared / Math.max(a.size, b.size);
}

async function loadLearnedRules() {
    try {
        const raw = await fs.readFile(LEARNED_RULES_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function saveLearnedRules(rules) {
    await fs.mkdir(path.dirname(LEARNED_RULES_PATH), { recursive: true });
    await fs.writeFile(LEARNED_RULES_PATH, JSON.stringify(rules, null, 2), 'utf8');
}

function classifyStoryType(cluster) {
    const corpus = [cluster.headline, cluster.summary, ...(cluster.keywords || [])].join(' ').toLowerCase();
    let bestType = 'other';
    let bestScore = 0;

    for (const rule of TYPE_RULES) {
        const score = rule.terms.reduce((acc, term) => acc + (corpus.includes(term) ? 1 : 0), 0);
        if (score > bestScore) {
            bestScore = score;
            bestType = rule.type;
        }
    }

    if (bestScore < 1) {
        return { story_type: 'other', story_type_confidence: 0.35 };
    }
    return { story_type: bestType, story_type_confidence: Math.min(0.95, 0.5 + (bestScore * 0.1)) };
}

function mergeTwoClusters(base, incoming) {
    const allSources = [...(base.sources || []), ...(incoming.sources || [])];
    const sourceDedup = new Map();
    for (const source of allSources) {
        const key = `${source.url || ''}-${source.title || ''}`;
        sourceDedup.set(key, source);
    }

    const merged = {
        ...base,
        headline: base.headline.length >= incoming.headline.length ? base.headline : incoming.headline,
        summary: base.summary.length >= incoming.summary.length ? base.summary : incoming.summary,
        article_count: (base.article_count || 0) + (incoming.article_count || 0),
        articles: [...(base.articles || []), ...(incoming.articles || [])],
        sources: Array.from(sourceDedup.values()),
        images: [...new Set([...(base.images || []), ...(incoming.images || [])])],
        keywords: [...new Set([...(base.keywords || []), ...(incoming.keywords || [])])],
        merged_content: [base.merged_content, incoming.merged_content].filter(Boolean).join('\n\n---\n\n'),
        date: [base.date, incoming.date].filter(Boolean).sort()[0] || base.date || incoming.date,
        duplicate: base.duplicate || incoming.duplicate,
    };
    return merged;
}

function shouldMergeClusters(a, b, learnedRules = []) {
    const headlineTokensA = tokenSet(a.headline);
    const headlineTokensB = tokenSet(b.headline);
    const keywordTokensA = tokenSet((a.keywords || []).join(' '));
    const keywordTokensB = tokenSet((b.keywords || []).join(' '));

    const headOverlap = overlapScore(headlineTokensA, headlineTokensB);
    const keywordOverlap = overlapScore(keywordTokensA, keywordTokensB);
    const combined = (headOverlap * 0.65) + (keywordOverlap * 0.35);

    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    const withinWeek = dateA && dateB ? Math.abs(dateA - dateB) <= (7 * 24 * 60 * 60 * 1000) : true;

    const learnedMatch = learnedRules.some(rule => {
        const required = Array.isArray(rule.tokens) ? rule.tokens : [];
        if (required.length === 0) return false;
        const aCount = required.filter(t => headlineTokensA.has(t)).length;
        const bCount = required.filter(t => headlineTokensB.has(t)).length;
        return aCount >= Math.ceil(required.length / 2) && bCount >= Math.ceil(required.length / 2);
    });

    return (combined >= 0.42 && withinWeek) || learnedMatch;
}

function mergeSimilarClusters(clusters, learnedRules = []) {
    const result = [];

    for (const cluster of clusters) {
        let mergedIntoExisting = false;
        for (let i = 0; i < result.length; i += 1) {
            if (shouldMergeClusters(result[i], cluster, learnedRules)) {
                result[i] = mergeTwoClusters(result[i], cluster);
                mergedIntoExisting = true;
                break;
            }
        }
        if (!mergedIntoExisting) {
            result.push(cluster);
        }
    }

    return result.map((cluster, idx) => ({ ...cluster, cluster_id: idx + 1 }));
}

export async function learnForceMerge(selectedClusters) {
    if (!Array.isArray(selectedClusters) || selectedClusters.length < 2) {
        throw new Error('At least two clusters are required for force merge learning.');
    }

    const merged = selectedClusters.reduce((acc, cluster) => {
        if (!acc) return { ...cluster };
        return mergeTwoClusters(acc, cluster);
    }, null);

    const allHeadlineTokens = selectedClusters
        .flatMap(c => normalizeTokens(c.headline || ''));
    const tokenCounts = new Map();
    for (const token of allHeadlineTokens) {
        tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
    const learnedTokens = Array.from(tokenCounts.entries())
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([token]) => token);

    const learnedRules = await loadLearnedRules();
    if (learnedTokens.length > 0) {
        learnedRules.push({
            tokens: learnedTokens,
            headlines: selectedClusters.map(c => c.headline),
            createdAt: new Date().toISOString(),
        });
        await saveLearnedRules(learnedRules.slice(-200));
    }

    const typeInfo = classifyStoryType(merged);
    return {
        mergedCluster: {
            ...merged,
            cluster_id: Date.now(),
            ...typeInfo,
        },
        learnedRules: learnedRules.length,
    };
}

/**
 * Uses Gemini Pro to cluster similar stories together.
 * Sends all article titles + summaries in a single prompt.
 * Returns clusters with merged data.
 */
export async function clusterStories(articles) {
    // Prepare summaries for the LLM
    const summaries = articles.map((a, i) => ({
        index: i,
        title: a.title || a.original_title,
        original_title: a.original_title || '',
        source: a.source_name || '',
        snippet: (a.main_content_body || '').substring(0, 700),
        keywords: (a.keywords || []).slice(0, 12),
        normalized_title: normalizeTokens(a.title || a.original_title).slice(0, 12),
        date: a.date_time || '',
    }));

    const prompt = `You are a news editor. Analyze the following ${summaries.length} news articles and group them by topic/story.
Articles about the SAME event or subject (even from different sources, angles, or with slightly different details) should be in the same cluster.
Treat paraphrased headlines, language variations, and competition/event naming variants as likely the same story if details align.

Articles:
${JSON.stringify(summaries, null, 2)}

Return a JSON array of clusters. Each cluster should have:
- "cluster_id": unique integer starting from 1
- "merged_headline_en": a compelling English headline that covers the combined story
- "article_indices": array of article index numbers that belong to this cluster
- "story_summary_en": a 1-2 sentence English summary of what this story is about

Return ONLY the JSON array, no other text.`;

    const clusters = await generateWithPro(prompt, { jsonMode: true });
    const learnedRules = await loadLearnedRules();

    // Build merged cluster objects
    const baseClusters = clusters.map(cluster => {
        const clusterArticles = cluster.article_indices.map(i => articles[i]).filter(Boolean);

        // Merge all content, sources, images, keywords
        const allSources = clusterArticles.map(a => ({
            name: a.source_name,
            url: a.source_url,
            title: a.original_title || a.title,
        }));

        const allImages = [...new Set(clusterArticles.flatMap(a => a.image_urls || []))];
        const allKeywords = [...new Set(clusterArticles.flatMap(a => a.keywords || []))];
        const allContent = clusterArticles.map(a => a.main_content_body).join('\n\n---\n\n');
        const earliestDate = clusterArticles
            .map(a => a.date_time)
            .filter(Boolean)
            .sort()[0];

        const clusterOut = {
            cluster_id: cluster.cluster_id,
            headline: cluster.merged_headline_en,
            summary: cluster.story_summary_en,
            article_count: clusterArticles.length,
            articles: clusterArticles,
            sources: allSources,
            images: allImages,
            keywords: allKeywords,
            merged_content: allContent,
            date: earliestDate,
            original_language: clusterArticles[0]?.original_language || 'es',
            profile_name: clusterArticles[0]?.profile_name || 'barcelona_news',
            duplicate: false, // will be set by duplicateChecker
        };

        return {
            ...clusterOut,
            ...classifyStoryType(clusterOut),
        };
    });

    return mergeSimilarClusters(baseClusters, learnedRules).map(cluster => ({
        ...cluster,
        ...classifyStoryType(cluster),
    }));
}

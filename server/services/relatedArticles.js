import fetch from 'node-fetch';
import { generateWithFlash } from './llmClient.js';

const WP_URL = () => process.env.WP_URL || 'https://barna.news';
const RECENCY_DAYS = 90;

const STOP_WORDS = new Set([
    'barcelona', 'catalonia', 'news', 'city', 'new', 'gets', 'over', 'with', 'from', 'into', 'after',
    'that', 'this', 'have', 'will', 'been', 'were', 'their', 'about', 'during', 'under', 'amid',
    'approval', 'nod', 'center', 'arts', 'digital', 'barna', 'avui', 'ahir', 'amb', 'dels', 'deles',
    'sobre', 'entre', 'despres', 'també', 'sense', 'sota', 'dins', 'fora', 'generalitat', 'ajuntament'
]);

function normalizeTokens(text = '') {
    return String(text)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function tokenSet(text = '') {
    return new Set(normalizeTokens(text));
}

function overlapScore(referenceSet, candidateSet) {
    if (referenceSet.size === 0 || candidateSet.size === 0) return 0;
    let matches = 0;
    for (const token of candidateSet) {
        if (referenceSet.has(token)) matches += 1;
    }
    const precision = matches / candidateSet.size;
    const recall = matches / referenceSet.size;
    return (precision * 0.6) + (recall * 0.4);
}

function recencyBoost(dateStr) {
    const ageDays = (Date.now() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000);
    if (Number.isNaN(ageDays)) return 0;
    if (ageDays <= 7) return 0.18;
    if (ageDays <= 30) return 0.1;
    if (ageDays <= 60) return 0.05;
    return 0;
}

async function fetchPostsByTerm(term, seen, cutoff) {
    const out = [];
    const url = `${WP_URL()}/wp-json/wp/v2/posts?search=${encodeURIComponent(term)}&per_page=12&_fields=id,title,link,date,excerpt&orderby=date&order=desc`;
    const res = await fetch(url);
    if (!res.ok) return out;
    const posts = await res.json();

    for (const post of posts) {
        if (seen.has(post.id)) continue;
        const postDate = new Date(post.date);
        if (postDate < cutoff) continue;
        seen.add(post.id);
        out.push(post);
    }

    return out;
}

async function fetchRecentFallback(seen, cutoff) {
    const url = `${WP_URL()}/wp-json/wp/v2/posts?per_page=18&_fields=id,title,link,date,excerpt&orderby=date&order=desc`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const posts = await res.json();

    return posts.filter((post) => {
        if (!post?.id || seen.has(post.id)) return false;
        const postDate = new Date(post.date);
        if (postDate < cutoff) return false;
        seen.add(post.id);
        return true;
    });
}

async function rerankWithFlash({ headline, keywords, context, candidates }) {
    if (!candidates.length) return [];

    const prompt = `You are ranking internal related-article links for Barna.News.

Current story:
- Headline: ${JSON.stringify(headline || '')}
- Keywords: ${JSON.stringify(keywords || [])}
- Context: ${JSON.stringify(String(context || '').slice(0, 1200))}

Candidate posts:
${JSON.stringify(candidates.map(item => ({
        id: item.id,
        title: item.title,
        date: item.date,
        excerpt: String(item.excerpt || '').replace(/<[^>]+>/g, ' ').slice(0, 240),
    })), null, 2)}

Return JSON object only:
{
  "ranked": [
    {
      "id": 123,
      "relevance": 0.0,
      "off_topic": false,
      "reason": "short string"
    }
  ]
}

Rules:
- Prefer semantically aligned topics, policy links, event follow-ups, and direct subject overlap.
- Penalize broad city-news links that do not materially connect.
- Support Catalan and English topical matching.
- Set off_topic=true when candidate is unrelated.`;

    try {
        const ranked = await generateWithFlash(prompt, { jsonMode: true, stage: 'related_rerank' });
        return Array.isArray(ranked?.ranked) ? ranked.ranked : [];
    } catch {
        return [];
    }
}

/**
 * Search Barna.News for related recent articles.
 * Uses keywords and headline to find relevant existing coverage.
 */
export async function findRelatedArticles(headline, keywords = [], { context = '' } = {}) {
    const results = [];
    const seen = new Set();
    const cutoff = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000);

    const referenceTokens = tokenSet(`${headline} ${(keywords || []).join(' ')} ${String(context || '').slice(0, 500)}`);

    // Search by keywords and headline terms
    const headlineTerms = normalizeTokens(headline).slice(0, 6);
    const keywordTerms = normalizeTokens((keywords || []).join(' ')).slice(0, 6);
    const contextTerms = normalizeTokens(String(context || '')).slice(0, 6);
    const searchTerms = [...new Set([...keywordTerms, ...headlineTerms, ...contextTerms])].slice(0, 10);

    for (const term of searchTerms) {
        try {
            const posts = await fetchPostsByTerm(term, seen, cutoff);
            for (const post of posts) {
                const title = post.title?.rendered || '';
                const lexical = overlapScore(referenceTokens, tokenSet(title));
                const score = lexical + recencyBoost(post.date);
                if (score < 0.12) continue;

                results.push({
                    id: post.id,
                    title,
                    link: post.link,
                    date: post.date,
                    excerpt: post?.excerpt?.rendered || '',
                    _score: score,
                    _lexical: lexical,
                });
            }
        } catch (err) {
            console.warn(`Search failed for term "${term}":`, err.message);
        }
    }

    if (results.length < 4) {
        try {
            const fallbackPosts = await fetchRecentFallback(seen, cutoff);
            for (const post of fallbackPosts) {
                const title = post.title?.rendered || '';
                const lexical = overlapScore(referenceTokens, tokenSet(title));
                results.push({
                    id: post.id,
                    title,
                    link: post.link,
                    date: post.date,
                    excerpt: post?.excerpt?.rendered || '',
                    _score: lexical + recencyBoost(post.date),
                    _lexical: lexical,
                });
            }
        } catch (err) {
            console.warn('Fallback recent-post retrieval failed:', err.message);
        }
    }

    const candidates = results
        .sort((a, b) => (b._score - a._score) || (new Date(b.date) - new Date(a.date)))
        .slice(0, 16);

    const semanticRank = await rerankWithFlash({
        headline,
        keywords,
        context,
        candidates,
    });

    const rankMap = new Map(semanticRank.map((item) => [Number(item.id), item]));
    const rescored = candidates.map((candidate) => {
        const semantic = rankMap.get(candidate.id);
        const semanticRelevance = Number(semantic?.relevance);
        const offTopic = Boolean(semantic?.off_topic);
        const semanticScore = Number.isFinite(semanticRelevance) ? Math.max(0, Math.min(1, semanticRelevance)) : 0;
        const combined = (candidate._lexical * 0.35) + (recencyBoost(candidate.date) * 0.15) + (semanticScore * 0.5);
        return {
            ...candidate,
            _score: combined,
            _offTopic: offTopic,
            _semanticScore: semanticScore,
        };
    });

    const filtered = rescored.filter((item) => !item._offTopic && (item._semanticScore >= 0.35 || item._score >= 0.24));
    const finalList = (filtered.length >= 3 ? filtered : rescored)
        .sort((a, b) => (b._score - a._score) || (new Date(b.date) - new Date(a.date)))
        .slice(0, 5);

    // Sort by relevance score, then by date descending
    return finalList.map(({ _score, _lexical, _offTopic, _semanticScore, excerpt, ...rest }) => rest);
}

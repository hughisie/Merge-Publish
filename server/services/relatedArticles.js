import fetch from 'node-fetch';

const WP_URL = () => process.env.WP_URL || 'https://barna.news';
const RECENCY_DAYS = 90;

const STOP_WORDS = new Set([
    'barcelona', 'catalonia', 'news', 'city', 'new', 'gets', 'over', 'with', 'from', 'into', 'after',
    'that', 'this', 'have', 'will', 'been', 'were', 'their', 'about', 'during', 'under', 'amid',
    'approval', 'nod', 'center', 'arts', 'digital'
]);

function normalizeTokens(text = '') {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
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

/**
 * Search Barna.News for related recent articles.
 * Uses keywords and headline to find relevant existing coverage.
 */
export async function findRelatedArticles(headline, keywords = []) {
    const results = [];
    const seen = new Set();
    const cutoff = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000);

    const referenceTokens = tokenSet(`${headline} ${(keywords || []).join(' ')}`);

    // Search by keywords and headline terms
    const headlineTerms = normalizeTokens(headline).slice(0, 5);
    const keywordTerms = normalizeTokens((keywords || []).join(' ')).slice(0, 5);
    const searchTerms = [...new Set([...keywordTerms, ...headlineTerms])].slice(0, 8);

    for (const term of searchTerms) {
        try {
            const url = `${WP_URL()}/wp-json/wp/v2/posts?search=${encodeURIComponent(term)}&per_page=10&_fields=id,title,link,date&orderby=date&order=desc`;
            const res = await fetch(url);
            if (!res.ok) continue;
            const posts = await res.json();

            for (const post of posts) {
                if (seen.has(post.id)) continue;
                seen.add(post.id);

                // Only include posts from last 90 days
                const postDate = new Date(post.date);
                if (postDate < cutoff) continue;

                const title = post.title?.rendered || '';
                const score = overlapScore(referenceTokens, tokenSet(title)) + recencyBoost(post.date);
                if (score < 0.18) continue;

                results.push({
                    id: post.id,
                    title,
                    link: post.link,
                    date: post.date,
                    _score: score,
                });
            }
        } catch (err) {
            console.warn(`Search failed for term "${term}":`, err.message);
        }
    }

    // Sort by relevance score, then by date descending
    results.sort((a, b) => (b._score - a._score) || (new Date(b.date) - new Date(a.date)));
    return results.slice(0, 5).map(({ _score, ...rest }) => rest);
}

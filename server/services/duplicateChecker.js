import fetch from 'node-fetch';
import { generateWithPro } from './llmClient.js';

const WP_URL = () => process.env.WP_URL || 'https://barna.news';

/**
 * Fetch recent posts from WordPress (last 24 hours)
 */
async function getRecentPosts() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const url = `${WP_URL()}/wp-json/wp/v2/posts?after=${encodeURIComponent(since)}&per_page=100&status=publish,draft&_fields=id,title,link,date,excerpt`;

    try {
        const headers = {};
        if (process.env.WP_USER && process.env.WP_APP_PASSWORD) {
            const auth = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
            headers['Authorization'] = `Basic ${auth}`;
        }

        const res = await fetch(url, { headers });
        if (!res.ok) {
            console.warn(`WordPress API returned ${res.status}: ${res.statusText}`);
            return [];
        }
        const posts = await res.json();
        return posts.map(p => ({
            id: p.id,
            title: p.title?.rendered || '',
            link: p.link,
            date: p.date,
            excerpt: (p.excerpt?.rendered || '').replace(/<[^>]+>/g, '').trim(),
        }));
    } catch (err) {
        console.error('Error fetching WordPress posts:', err.message);
        return [];
    }
}

/**
 * Check clusters against recent WordPress posts.
 * Uses LLM to compare headlines and flag likely duplicates.
 */
export async function checkDuplicates(clusters) {
    const recentPosts = await getRecentPosts();

    if (recentPosts.length === 0) {
        console.log('No recent WordPress posts found (last 24h). No duplicates to check.');
        return clusters;
    }

    const postSummaries = recentPosts.map(p => ({
        title: p.title,
        excerpt: p.excerpt.substring(0, 150),
        link: p.link,
    }));

    const clusterSummaries = clusters.map(c => ({
        cluster_id: c.cluster_id,
        headline: c.headline,
        summary: c.summary,
    }));

    const prompt = `You are a news editor checking for duplicate coverage. 

Here are stories ALREADY PUBLISHED on our site in the last 24 hours:
${JSON.stringify(postSummaries, null, 2)}

Here are NEW story clusters we're considering publishing:
${JSON.stringify(clusterSummaries, null, 2)}

For each new cluster, determine if it's essentially the SAME story as any already-published post.
Only mark as duplicate if they cover the SAME specific event/announcement — not just the same broad topic.

Return a JSON array with one object per cluster:
[{"cluster_id": 1, "is_duplicate": true/false, "matching_post_title": "title if duplicate, empty string if not", "matching_post_link": "URL if duplicate, empty string if not"}]

Return ONLY the JSON array.`;

    const results = await generateWithPro(prompt, { jsonMode: true });

    // Apply duplicate flags
    for (const result of results) {
        const cluster = clusters.find(c => c.cluster_id === result.cluster_id);
        if (cluster && result.is_duplicate) {
            cluster.duplicate = true;
            cluster.duplicate_of = {
                title: result.matching_post_title,
                link: result.matching_post_link,
            };
        }
    }

    return clusters;
}

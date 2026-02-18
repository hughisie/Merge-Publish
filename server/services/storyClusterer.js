import { generateWithPro } from './llmClient.js';

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
        snippet: (a.main_content_body || '').substring(0, 300),
        date: a.date_time || '',
    }));

    const prompt = `You are a news editor. Analyze the following ${summaries.length} news articles and group them by topic/story.
Articles about the SAME event or subject (even from different sources, angles, or with slightly different details) should be in the same cluster.

Articles:
${JSON.stringify(summaries, null, 2)}

Return a JSON array of clusters. Each cluster should have:
- "cluster_id": unique integer starting from 1
- "merged_headline_en": a compelling English headline that covers the combined story
- "article_indices": array of article index numbers that belong to this cluster
- "story_summary_en": a 1-2 sentence English summary of what this story is about

Return ONLY the JSON array, no other text.`;

    const clusters = await generateWithPro(prompt, { jsonMode: true });

    // Build merged cluster objects
    return clusters.map(cluster => {
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

        return {
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
    });
}

import { researchWithGrounding, generateWithPro } from './llmClient.js';
import { findRelatedArticles } from './relatedArticles.js';

// WhatsApp broadcast channel banner to insert after first paragraph
const WHATSAPP_BANNER = `
<a class="bnn-amazon-deals" href="https://whatsapp.com/channel/0029VbBd3cR5PO18Qtyxp22I" target="_blank" rel="noopener" style="display:block;transform-origin:center;">
  <video autoplay muted loop playsinline width="100%" style="border-radius:8px;display:block;transition:all 0.3s ease;">
    <source src="https://barna.news/wp-content/uploads/2025/11/Amazon-Broadcast-Channel.webm" type="video/webm">
    Your browser does not support the video tag.
  </video>
</a>

<style>
a.bnn-amazon-deals:hover video {
  filter: brightness(1.1);
  transform: scale(1.02);
  transition: all 0.3s ease;
}
</style>`;

/**
 * Insert the WhatsApp banner after the first <p>...</p> tag.
 */
function insertBannerAfterFirstParagraph(html) {
    const firstPClose = html.indexOf('</p>');
    if (firstPClose === -1) return html + WHATSAPP_BANNER;
    const insertPos = firstPClose + 4; // after </p>
    return html.slice(0, insertPos) + '\n' + WHATSAPP_BANNER + '\n' + html.slice(insertPos);
}

/**
 * Step 1: Research the topic with Gemini Flash + Google Search grounding
 */
async function researchTopic(cluster) {
    const prompt = `You are a researcher for a Barcelona news website (Barna.News, barna.news). 
  
Research the following news story and find relevant, authoritative links to include in our article:

Story headline: ${cluster.headline}
Story summary: ${cluster.summary}
Keywords: ${cluster.keywords.join(', ')}
Original content (in ${cluster.original_language}):
${cluster.merged_content.substring(0, 3000)}

Find and return:
1. Relevant Wikipedia article URLs (English Wikipedia preferred)
2. Relevant official government or institutional website URLs (Barcelona City Council, Generalitat de Catalunya, EU institutions, etc.)
3. Google Maps links for any specific locations mentioned (streets, buildings, neighborhoods in Barcelona)
4. Any other authoritative reference URLs that would help readers understand the context

Format your response as a JSON object:
{
  "wikipedia_links": [{"title": "Article Title", "url": "https://..."}],
  "government_links": [{"title": "Official Source Name", "url": "https://..."}],
  "maps_links": [{"title": "Location Name", "url": "https://maps.google.com/..."}],
  "other_links": [{"title": "Resource Name", "url": "https://..."}],
  "key_facts": ["verified fact 1", "verified fact 2"]
}`;

    try {
        const { text, searchResults } = await researchWithGrounding(prompt);
        // Try to parse JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const research = JSON.parse(jsonMatch[0]);
            research._groundingSources = searchResults;
            return research;
        }
        return { wikipedia_links: [], government_links: [], maps_links: [], other_links: [], key_facts: [], _groundingSources: searchResults };
    } catch (err) {
        console.error('Research failed:', err.message);
        return { wikipedia_links: [], government_links: [], maps_links: [], other_links: [], key_facts: [] };
    }
}

/**
 * Step 2: Write the article with Gemini Pro Preview
 */
async function writeArticle(cluster, research, relatedArticles) {
    // Build the sources reference
    const sourcesSection = cluster.sources
        .map(s => `- ${s.name}: ${s.url}`)
        .join('\n');

    const researchLinksSection = [
        ...(research.wikipedia_links || []),
        ...(research.government_links || []),
        ...(research.maps_links || []),
        ...(research.other_links || []),
    ].map(l => `- [${l.title}](${l.url})`).join('\n');

    const relatedSection = relatedArticles
        .map(a => `- [${a.title}](${a.link})`)
        .join('\n');

    const prompt = `You are an expert English-language journalist writing for Barna.News (barna.news), a premium Barcelona news website. Write a world-class news article based on the source material below.

STORY HEADLINE: ${cluster.headline}
STORY SUMMARY: ${cluster.summary}

SOURCE MATERIAL (in ${cluster.original_language}, from ${cluster.article_count} source(s)):
${cluster.merged_content.substring(0, 8000)}

ORIGINAL SOURCES:
${sourcesSection}

RESEARCHED REFERENCE LINKS TO WEAVE INTO THE ARTICLE:
${researchLinksSection}

KEY VERIFIED FACTS:
${(research.key_facts || []).join('\n')}

RELATED BARNA.NEWS ARTICLES (link to relevant ones naturally within the text or in a "Related Reading" section):
${relatedSection || 'None found'}

WRITING GUIDELINES:
1. Write in fluent, natural, compelling English — it should read as if written by a native English-speaking journalist
2. The tone should be NEUTRAL and INFORMATIVE — not sensationalist, not robotic
3. Structure: Lead paragraph → context → details → reactions/quotes → analysis/outlook
4. Weave in the researched links naturally as inline hyperlinks where they add value (e.g. link neighborhood names to Google Maps, institutions to their websites, topics to Wikipedia)
5. Credit the original source(s) with links — e.g. "according to [El Periódico](url)"
6. Include a "Related Reading on Barna.News" section at the end with linked article titles (only if there are related articles)
7. Use HTML formatting (<p>, <h2>, <h3>, <blockquote>, <a>, <strong>, <em>) 
8. Make it comprehensive but not bloated — aim for 600-1000 words
9. All quotes should be translated to English but attributed to the original speaker
10. Do NOT include a main headline/title in the body — that goes separately

Return a JSON object with:
{
  "title": "SEO-optimized headline, max 60 characters",
  "meta_description": "Compelling meta description for search engines, max 155 characters",
  "slug": "url-friendly-slug-with-dashes",
  "body_html": "The full article HTML",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "focus_keyphrase": "2-4 word SEO focus keyphrase"
}`;

    return await generateWithPro(prompt, { jsonMode: true });
}

/**
 * Main function: Generate a complete article for a cluster
 */
export async function generateArticle(cluster) {
    console.log(`📝 Generating article: ${cluster.headline}`);

    // Step 1: Research
    console.log('  🔍 Researching topic with grounding...');
    const research = await researchTopic(cluster);

    // Step 2: Find related Barna.News articles
    console.log('  🔗 Finding related Barna.News articles...');
    const relatedArticles = await findRelatedArticles(cluster.headline, cluster.keywords);

    // Step 3: Write the article
    console.log('  ✍️  Writing article with Gemini Pro...');
    const article = await writeArticle(cluster, research, relatedArticles);

    // Step 4: Insert WhatsApp banner after first paragraph
    if (article.body_html) {
        article.body_html = insertBannerAfterFirstParagraph(article.body_html);
    }

    return {
        ...article,
        cluster_id: cluster.cluster_id,
        sources: cluster.sources,
        images: cluster.images,
        research,
        relatedArticles,
    };
}

import { researchWithGrounding, generateWithFlash, generateWithPro } from './llmClient.js';
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

const BRITISH_SPELLING_RULES = [
    [/\bcolor\b/gi, 'colour'],
    [/\bcolors\b/gi, 'colours'],
    [/\borganize\b/gi, 'organise'],
    [/\borganized\b/gi, 'organised'],
    [/\borganizing\b/gi, 'organising'],
    [/\borganizes\b/gi, 'organises'],
    [/\bcenter\b/gi, 'centre'],
    [/\bcenters\b/gi, 'centres'],
    [/\banalyze\b/gi, 'analyse'],
    [/\banalyzed\b/gi, 'analysed'],
    [/\banalyzing\b/gi, 'analysing'],
    [/\btraveler\b/gi, 'traveller'],
    [/\btravelers\b/gi, 'travellers'],
    [/\bdefense\b/gi, 'defence'],
    [/\blicense\b/gi, 'licence'],
    [/\bfavor\b/gi, 'favour'],
    [/\bfavorite\b/gi, 'favourite'],
    [/\bprogram\b/gi, 'programme'],
    [/\bprograms\b/gi, 'programmes'],
];

function enforceBritishEnglish(html = '') {
    let out = String(html);
    for (const [pattern, replacement] of BRITISH_SPELLING_RULES) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

/**
 * Insert the WhatsApp banner after the first <p>...</p> tag.
 */
function insertBannerAfterFirstParagraph(html) {
    const firstPClose = html.indexOf('</p>');
    if (firstPClose === -1) return html + WHATSAPP_BANNER;
    const insertPos = firstPClose + 4; // after </p>
    return html.slice(0, insertPos) + '\n' + WHATSAPP_BANNER + '\n' + html.slice(insertPos);
}

function slugify(text = '') {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 80);
}

function stripBarcelonaLead(html = '') {
    return html.replace(
        /<p>\s*(?:<strong>)?\s*barcelona\s*(?:-|\u2014)\s*(?:<\/strong>)?\s*/i,
        '<p>'
    );
}

function firstCompleteSentence(text = '', max = 155) {
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const sentences = clean.match(/[^.!?]+[.!?]/g) || [];
    const best = sentences.find(s => s.trim().length >= 70 && s.trim().length <= max);
    if (best) return best.trim();
    const cut = clean.slice(0, max + 1);
    const lastSpace = cut.lastIndexOf(' ');
    const short = (lastSpace > 90 ? cut.slice(0, lastSpace) : clean.slice(0, max)).trim().replace(/[,:;\-]$/, '');
    return `${short}.`;
}

const CLICKBAIT_PATTERN = /\b(breaking|shocking|you won't believe|must see|unbelievable|jaw-dropping|explosive)\b/gi;
const LOW_TRUST_HINTS = [/rumou?r/i, /unverified/i, /anonymous/i, /alleged/i];
const SPONSORED_HINTS = [/affiliate/i, /sponsored/i, /partner/i, /ref=/i, /aff[_=-]?id/i, /utm_medium=affiliate/i];
const UGC_DOMAINS = /(reddit\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|forums?\.|comment\.)/i;

function normalizeTitleForSeo(title = '') {
    let out = String(title || '').replace(/\u2014/g, '-').replace(CLICKBAIT_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
    out = out.replace(/[!?]{2,}/g, '!').replace(/\s+[|\-–—]{1}\s+[|\-–—]{1}\s+/g, ' | ');
    if (!out) return 'Barcelona News Update';
    return out.slice(0, 60).trim();
}

function sanitizeMetaDescriptionForSeo(meta = '', bodyText = '') {
    let out = String(meta || '').replace(/\u2014/g, '-').replace(CLICKBAIT_PATTERN, '').trim();
    out = out.replace(/["“”]/g, '').replace(/[!?]{2,}/g, '!');
    if (!out) {
        out = firstCompleteSentence(bodyText, 155);
    }
    if (out.length > 155) out = out.slice(0, 155).replace(/\s+\S*$/, '').trim();
    if (!/[.!?]$/.test(out)) {
        out = `${out.replace(/[,:;\-]$/, '').trim()}.`;
    }
    if (out.length < 120 && bodyText) {
        const fallback = firstCompleteSentence(bodyText, 155);
        if (fallback.length >= out.length) out = fallback;
    }
    return out;
}

function mergeRel(existingRel = '', required = []) {
    const relSet = new Set(
        String(existingRel || '')
            .split(/\s+/)
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
    );
    required.forEach((value) => relSet.add(value));
    return [...relSet].join(' ');
}

function enforceOutboundLinkPolicy(html = '') {
    const input = String(html || '');
    return input.replace(/<a\b([^>]*?)href=(['"])(https?:\/\/[^'"\s>]+)\2([^>]*)>/gi, (full, before, quote, href, after) => {
        const attrs = `${before}${after}`;
        const external = !/https?:\/\/(?:www\.)?barna\.news\b/i.test(href);
        if (!external) return full;

        let rel = '';
        const relMatch = attrs.match(/\brel=(['"])(.*?)\1/i);
        if (relMatch) rel = relMatch[2];

        const fullHint = `${href} ${attrs}`;
        const requiredRel = ['noopener', 'noreferrer'];
        if (SPONSORED_HINTS.some((pattern) => pattern.test(fullHint))) {
            requiredRel.push('sponsored', 'nofollow');
        } else if (UGC_DOMAINS.test(href)) {
            requiredRel.push('ugc', 'nofollow');
        } else if (LOW_TRUST_HINTS.some((pattern) => pattern.test(fullHint))) {
            requiredRel.push('nofollow');
        }

        const nextRel = mergeRel(rel, requiredRel);
        let rebuilt = full;
        if (/\brel=(['"]).*?\1/i.test(rebuilt)) {
            rebuilt = rebuilt.replace(/\brel=(['"]).*?\1/i, `rel=${quote}${nextRel}${quote}`);
        } else {
            rebuilt = rebuilt.replace('<a', `<a rel=${quote}${nextRel}${quote}`);
        }
        if (!/\btarget=(['"]).*?\1/i.test(rebuilt)) {
            rebuilt = rebuilt.replace('<a', `<a target=${quote}_blank${quote}`);
        }
        return rebuilt;
    });
}

function ensurePrimarySourceLink(html = '', cluster = {}) {
    const primarySource = selectPrimarySourceUrl(cluster);
    if (!primarySource) return html;
    if (html.includes(primarySource)) return html;

    const sourceName = cluster?.sources?.find((item) => item?.url === primarySource)?.name || 'primary source';
    return `${html}\n<p><em>According to the official source, see <a href="${primarySource}" target="_blank" rel="noopener noreferrer">${sourceName}</a>.</em></p>`;
}

function sanitizeJsonText(text = '') {
    return String(text || '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function extractLargestJsonObject(text = '') {
    const clean = sanitizeJsonText(text);
    const firstBrace = clean.indexOf('{');
    if (firstBrace === -1) return '';

    let depth = 0;
    let inString = false;
    let escape = false;
    let best = '';
    let start = -1;

    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];

        if (escape) {
            escape = false;
            continue;
        }
        if (ch === '\\') {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                const candidate = clean.slice(start, i + 1);
                if (candidate.length > best.length) best = candidate;
                start = -1;
            }
        }
    }

    return best;
}

function parseJsonLoose(text = '') {
    const objectText = extractLargestJsonObject(text);
    if (!objectText) {
        throw new Error('No JSON object detected in model response');
    }
    return JSON.parse(objectText);
}

function validateArticlePayload(article = {}) {
    const required = ['title', 'meta_description', 'slug', 'body_html', 'focus_keyphrase'];
    const missing = required.filter((field) => !String(article?.[field] || '').trim());
    if (missing.length) {
        throw new Error(`Missing required article fields: ${missing.join(', ')}`);
    }
    return article;
}

async function repairJsonWithFlash(rawPayload, schemaHint) {
    const prompt = `You repair malformed JSON. Return valid JSON only and preserve the original meaning.

Schema requirements:
${schemaHint}

Broken payload:
${String(rawPayload || '').slice(0, 24000)}`;

    const fixed = await generateWithFlash(prompt, { jsonMode: false, stage: 'json_repair' });
    return parseJsonLoose(fixed);
}

async function parseModelJsonWithRepair(rawText, schemaHint) {
    try {
        return parseJsonLoose(rawText);
    } catch (firstErr) {
        const repaired = await repairJsonWithFlash(rawText, schemaHint);
        return repaired;
    }
}

function countWords(text = '') {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function limitQuoteDensity(html = '', wordsPerQuote = 300) {
    const input = String(html || '');
    const quoteMatches = [...input.matchAll(/<blockquote[\s\S]*?<\/blockquote>/gi)];
    if (!quoteMatches.length) return input;

    const plainWords = countWords(input.replace(/<[^>]+>/g, ' '));
    const maxQuotes = Math.max(1, Math.floor(plainWords / wordsPerQuote) || 1);
    if (quoteMatches.length <= maxQuotes) return input;

    let out = input;
    quoteMatches.forEach((match, index) => {
        if (index < maxQuotes) return;
        const raw = match[0];
        const asParagraph = raw
            .replace(/^<blockquote[^>]*>/i, '<p>')
            .replace(/<\/blockquote>$/i, '</p>')
            .replace(/<p>\s*<\/p>/gi, '');
        out = out.replace(raw, asParagraph);
    });
    return out;
}

function selectPrimarySourceUrl(cluster = {}, research = {}) {
    const sourceCandidates = Array.isArray(cluster?.sources) ? cluster.sources.map((s) => s?.url).filter(Boolean) : [];
    const officialCandidates = [
        ...(Array.isArray(research?.event_links) ? research.event_links.map((l) => l?.url) : []),
        ...(Array.isArray(research?.government_links) ? research.government_links.map((l) => l?.url) : []),
        String(research?.primary_source?.url || ''),
        ...sourceCandidates,
    ].filter(Boolean);

    const preferred = officialCandidates.find((url) => /\.(gov|gob|eu|org)\b|ajuntament|gencat|barcelona\.cat|generalitat/i.test(url));
    return preferred || officialCandidates[0] || '';
}

function buildArticleDiagnostics({ article = {}, cluster = {}, relatedArticles = [], research = {} } = {}) {
    const body = String(article?.body_html || '');
    const quoteCount = (body.match(/<blockquote[\s>]/gi) || []).length;
    const longSentenceCount = (body.replace(/<[^>]+>/g, ' ').match(/[^.!?]{140,}[.!?]/g) || []).length;
    const primarySource = selectPrimarySourceUrl(cluster, research);
    return {
        quoteCount,
        longSentenceCount,
        relatedLinksCount: Array.isArray(relatedArticles) ? relatedArticles.length : 0,
        primarySourceDetected: Boolean(primarySource),
        primarySourceLinked: primarySource ? body.includes(primarySource) : false,
        sourceDomain: primarySource ? (() => {
            try {
                return new URL(primarySource).hostname;
            } catch {
                return '';
            }
        })() : '',
    };
}

function ensureSeoFields(article = {}, cluster = {}) {
    const fallbackKeyphrase = (cluster.keywords || []).slice(0, 3).join(' ') ||
        (cluster.headline || '').split(/\s+/).slice(0, 4).join(' ');
    const focusKeyphrase = (article.focus_keyphrase || fallbackKeyphrase || '').trim().slice(0, 70);
    const fallbackTitle = (cluster.headline || 'Barcelona News Update').trim();
    const title = (article.title || fallbackTitle).trim();
    const normalizedTitle = normalizeTitleForSeo(title);
    const slug = slugify(article.slug || focusKeyphrase || title);

    const bodyText = (article.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const metaDescription = sanitizeMetaDescriptionForSeo(article.meta_description || '', bodyText);

    return {
        ...article,
        title: normalizedTitle,
        focus_keyphrase: focusKeyphrase,
        slug,
        meta_description: metaDescription,
        body_html: article.body_html || '',
    };
}

function cleanupArticleBody(html = '') {
    let out = html;
    out = out.replace(/\u2014/g, '-');
    out = stripBarcelonaLead(out);
    out = out.replace(/^\s*<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>\s*/i, '');

    const plainTop = String(out).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const topWords = plainTop.split(/\s+/).slice(0, 12).join(' ').toLowerCase();

    out = out.replace(/^\s*<p>\s*<strong>([^<]{10,140})<\/strong>\s*<\/p>\s*/i, (_m, line) => {
        const candidate = line.toLowerCase().trim();
        if (topWords.includes(candidate) && candidate.split(/\s+/).length <= 16) {
            return '';
        }
        return `<p><strong>${line}</strong></p>`;
    });

    out = out.replace(/^\s*<p>([^<]{10,160})<\/p>\s*/i, (_m, first) => {
        const candidate = first.replace(/["“”]/g, '').trim().toLowerCase();
        if (topWords.includes(candidate) && candidate.split(/\s+/).length <= 16) {
            return '';
        }
        return `<p>${first}</p>`;
    });

    // remove standalone dek/subheading paragraph if the first paragraph is very short
    out = out.replace(/^\s*<p>([^<]{0,180})<\/p>\s*(<p>[\s\S]+)/i, (_m, first, rest) => {
        const words = first.trim().split(/\s+/).length;
        if ((/\.$/.test(first.trim()) || /:$/.test(first.trim())) && words < 20) {
            return rest;
        }
        return `<p>${first}</p>${rest}`;
    });

    out = out.replace(/\s*<p>([^<]{1,80})<\/p>\s*$/i, (match, tail) => {
        const cleanTail = tail.trim();
        if (cleanTail.split(/\s+/).length <= 5 && !/[.!?]$/.test(cleanTail)) {
            return '';
        }
        return match;
    });

    out = enforceBritishEnglish(out);
    out = out.replace(/\s{2,}/g, ' ').trim();
    return out;
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
5. Official event pages for events, protests, festivals, transport works, tenders, or council sessions mentioned
6. One best primary source URL (official organiser/government/institution first)

Format your response as a JSON object:
{
  "wikipedia_links": [{"title": "Article Title", "url": "https://..."}],
  "government_links": [{"title": "Official Source Name", "url": "https://..."}],
  "maps_links": [{"title": "Location Name", "url": "https://maps.google.com/..."}],
  "other_links": [{"title": "Resource Name", "url": "https://..."}],
  "event_links": [{"title": "Event or official page", "url": "https://..."}],
  "primary_source": {"title": "Most authoritative source", "url": "https://..."},
  "key_facts": ["verified fact 1", "verified fact 2"]
}`;

    try {
        const { text, searchResults } = await researchWithGrounding(prompt, { stage: 'research' });
        const schemaHint = `{
  "wikipedia_links": [{"title": "string", "url": "string"}],
  "government_links": [{"title": "string", "url": "string"}],
  "maps_links": [{"title": "string", "url": "string"}],
  "other_links": [{"title": "string", "url": "string"}],
  "event_links": [{"title": "string", "url": "string"}],
  "primary_source": {"title": "string", "url": "string"},
  "key_facts": ["string"]
}`;
        const research = await parseModelJsonWithRepair(text, schemaHint);
        research._groundingSources = searchResults;
        return research;
    } catch (err) {
        console.error('Research failed:', err.message);
        return {
            wikipedia_links: [],
            government_links: [],
            maps_links: [],
            other_links: [],
            event_links: [],
            primary_source: {},
            key_facts: [],
        };
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
1. Write in fluent, natural, compelling British English - it should read as if written by a native UK English journalist
2. The tone should be NEUTRAL and INFORMATIVE - not sensationalist, not robotic
3. Structure: Lead paragraph → context → details → reactions/quotes → analysis/outlook
4. Weave in researched links naturally as inline hyperlinks where they add value, and include context around links (e.g. "according to the court ruling", "in the official statement")
5. Credit the original source(s) with links - e.g. "according to [El Periódico](url)"
6. Prioritize primary source links where possible for reports/studies/statistics cited in the article, and avoid low-trust sources unless clearly marked as unverified
6. Include a "Related Reading on Barna.News" section at the end with linked article titles (only if there are related articles)
7. Use HTML formatting (<p>, <blockquote>, <a>, <strong>, <em>, <ul>, <ol>, <li>)
8. Make it comprehensive but not bloated - aim for 600-1000 words
9. All quotes should be translated to English but attributed to the original speaker
10. Do NOT include a main headline/title in the body - that goes separately
11. Do NOT start the first paragraph with "BARCELONA -" or variants
12. Do NOT output a sub-heading/dek paragraph directly beneath title
13. Use subheadings (<h2>) every 2-4 paragraphs for long articles; do not use <h1> in body
14. Do NOT use the em dash symbol; use standard punctuation only
15. Prefer active voice over passive voice wherever possible
16. Keep sentence rhythm varied and keep most sentences under 20 words
17. Use transition words naturally (e.g., however, meanwhile, therefore, in addition)

Return a JSON object with:
{
  "title": "SEO-optimized headline, max 60 characters, specific and non-clickbait",
  "meta_description": "Compelling meta description for search engines, 120-155 characters, complete sentence",
  "slug": "url-friendly-slug-with-dashes",
  "body_html": "The full article HTML",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "focus_keyphrase": "2-4 word SEO focus keyphrase"
}`;

    const rawText = await generateWithPro(prompt, { jsonMode: false, stage: 'write_article' });
    const schemaHint = `{
  "title": "string",
  "meta_description": "string",
  "slug": "string",
  "body_html": "string",
  "tags": ["string"],
  "focus_keyphrase": "string"
}`;
    const parsed = await parseModelJsonWithRepair(rawText, schemaHint);
    return validateArticlePayload(parsed);
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
    const relatedArticles = await findRelatedArticles(cluster.headline, cluster.keywords, {
        context: cluster.summary || cluster.merged_content || '',
    });

    // Step 3: Write the article
    console.log('  ✍️  Writing article with Gemini Pro...');
    let article = await writeArticle(cluster, research, relatedArticles);

    article = ensureSeoFields(article, cluster);
    article.body_html = cleanupArticleBody(article.body_html || '');
    article.body_html = enforceOutboundLinkPolicy(article.body_html || '');
    article.body_html = limitQuoteDensity(article.body_html || '', 300);
    const primarySourceCluster = {
        ...cluster,
        sources: [
            ...(research?.primary_source?.url ? [{
                name: research?.primary_source?.title || 'Primary source',
                url: research.primary_source.url,
            }] : []),
            ...(cluster.sources || []),
        ],
    };
    article.body_html = ensurePrimarySourceLink(article.body_html || '', primarySourceCluster);
    article.body_html = enforceOutboundLinkPolicy(article.body_html || '');

    // Step 4: Insert WhatsApp banner after first paragraph
    if (article.body_html) {
        article.body_html = insertBannerAfterFirstParagraph(article.body_html);
    }

    return {
        ...article,
        cluster_id: cluster.cluster_id,
        sources: cluster.sources,
        images: cluster.images,
        image_preview: {
            url: Array.isArray(cluster.images) ? (cluster.images[0] || '') : '',
            sourceUrl: Array.isArray(cluster.images) ? (cluster.images[0] || '') : '',
            width: null,
            height: null,
        },
        research,
        relatedArticles,
        diagnostics: buildArticleDiagnostics({
            article,
            cluster: primarySourceCluster,
            relatedArticles,
            research,
        }),
    };
}

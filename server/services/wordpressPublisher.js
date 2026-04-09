import fetch from 'node-fetch';
import FormData from 'form-data';
import { generateWithFlash } from './llmClient.js';
import { archiveSourceImages } from './imageArchive.js';

const WP_URL = () => process.env.WP_URL || 'https://barna.news';

function slugify(text = '') {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 80);
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
        const requiredRel = ['noopener', 'noreferrer', 'nofollow'];
        if (SPONSORED_HINTS.some((pattern) => pattern.test(fullHint))) {
            requiredRel.push('sponsored');
        } else if (UGC_DOMAINS.test(href)) {
            requiredRel.push('ugc');
        } else if (LOW_TRUST_HINTS.some((pattern) => pattern.test(fullHint))) {
            requiredRel.push('ugc');
        }

        const nextRel = mergeRel(rel, requiredRel);
        let rebuilt = full;
        if (/\brel=(['"]).*?\1/i.test(rebuilt)) {
            rebuilt = rebuilt.replace(/\brel=(['"]).*?\1/i, `rel=${quote}${nextRel}${quote}`);
        } else {
            rebuilt = rebuilt.replace('<a', `<a rel=${quote}${nextRel}${quote} `);
        }
        if (!/\btarget=(['"]).*?\1/i.test(rebuilt)) {
            rebuilt = rebuilt.replace('<a', `<a target=${quote}_blank${quote} `);
        }
        return rebuilt.replace(/ +>/g, '>');
    });
}

function stripAnchorTag(anchorHtml = '') {
    return String(anchorHtml || '').replace(/<\/?a\b[^>]*>/gi, '');
}

function enforceOneLinkPerParagraph(html = '') {
    return String(html || '').replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (paragraph) => {
        let seen = false;
        return paragraph.replace(/<a\b[\s\S]*?<\/a>/gi, (anchor) => {
            if (!seen) {
                seen = true;
                return anchor;
            }
            return stripAnchorTag(anchor);
        });
    });
}

function hardClampParagraphLinks(html = '') {
    return String(html || '').replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (paragraph) => {
        const openings = [...paragraph.matchAll(/<a\b[^>]*>/gi)];
        if (openings.length <= 1) return paragraph;

        const firstOpen = openings[0];
        const firstOpenIndex = Number(firstOpen?.index || 0);
        const firstOpenRaw = String(firstOpen?.[0] || '');
        const closeIndex = paragraph.indexOf('</a>', firstOpenIndex + firstOpenRaw.length);
        if (closeIndex === -1) {
            return paragraph.replace(/<\/?a\b[^>]*>/gi, '');
        }

        const preserved = paragraph.slice(0, closeIndex + 4);
        const tail = paragraph.slice(closeIndex + 4).replace(/<\/?a\b[^>]*>/gi, '');
        return `${preserved}${tail}`;
    });
}

function countAnchors(html = '') {
    const allMatches = html.match(/<a\b[^>]*href=(['"])(https?:\/\/[^'"\s>]+)\1[^>]*>[\s\S]*?<\/a>/gi) || [];
    return allMatches.filter(m => !m.includes('data-protected="true"') && !m.includes('bnn-amazon-deals')).length;
}

function trimAnchorsToMax(html = '', maxLinks = 4) {
    let out = String(html || '');
    const allMatches = [...out.matchAll(/<a\b[^>]*href=(['"])(https?:\/\/[^'"\s>]+)\1[^>]*>[\s\S]*?<\/a>/gi)];
    const unprotectedMatches = allMatches.filter(m => !m[0].includes('data-protected="true"') && !m[0].includes('bnn-amazon-deals'));

    if (unprotectedMatches.length <= maxLinks) return out;

    for (let i = unprotectedMatches.length - 1; i >= maxLinks; i -= 1) {
        const raw = unprotectedMatches[i]?.[0] || '';
        if (!raw) continue;
        out = out.replace(raw, stripAnchorTag(raw));
    }
    return out;
}

function escapeHtml(text = '') {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function normalizeRelatedReadingSections(html = '', relatedArticles = []) {
    const input = String(html || '');
    const sectionPattern = /<(h2|h3|p)[^>]*>\s*(?:<strong>)?\s*(Related Reading on Barna\.News|Further Resources(?: and Related Reading)?)\s*(?:<\/strong>)?\s*<\/\1>[\s\S]*?(?=<(h2|h3)\b|$)/gi;
    const stripped = input.replace(sectionPattern, '').replace(/<h2>\s*Related Reading on Barna\.News\s*<\/h2>\s*(?!<(ul|ol)\b)[\s\S]*?(?=<(h2|h3)\b|$)/gi, '');

    const safeRelated = (Array.isArray(relatedArticles) ? relatedArticles : [])
        .filter((item) => /^https?:\/\//i.test(String(item?.link || '')))
        .map((item) => ({
            title: decodeHtmlEntities(String(item?.title || '').replace(/<[^>]+>/g, '').trim()),
            link: String(item?.link || '').trim(),
        }))
        .filter((item) => item.title && item.link)
        .slice(0, 5);

    if (!safeRelated.length) return stripped.replace(/\n{3,}/g, '\n\n').trim();

    function decodeHtmlEntities(str) {
        if (!str) return '';
        return String(str)
            .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
            .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#8217;/g, "'")
            .replace(/&#8216;/g, "'")
            .replace(/&#8220;/g, '"')
            .replace(/&#8221;/g, '"');
    }

    const section = [
        '<h2>Related Reading on Barna.News</h2>',
        '<ul>',
        ...safeRelated.map((item) => `  <li><a href="${item.link}">${escapeHtml(decodeHtmlEntities(item.title))}</a></li>`),
        '</ul>',
    ].join('\n');

    return `${stripped.replace(/\n{3,}/g, '\n\n').trim()}\n\n${section}`.trim();
}

function collectPublishLinkCandidates(article = {}) {
    const seen = new Set();
    const items = [];
    const push = (title, url) => {
        const cleanTitle = String(title || '').replace(/<[^>]+>/g, '').trim();
        const cleanUrl = String(url || '').trim();
        if (!cleanTitle || !/^https?:\/\//i.test(cleanUrl)) return;
        if (seen.has(cleanUrl)) return;
        seen.add(cleanUrl);
        items.push({ title: cleanTitle, url: cleanUrl });
    };

    (article?.relatedArticles || []).forEach((item) => push(item?.title, item?.link));
    (article?.research?.event_links || []).forEach((item) => push(item?.title, item?.url));
    (article?.research?.government_links || []).forEach((item) => push(item?.title, item?.url));
    (article?.research?.wikipedia_links || []).forEach((item) => push(item?.title, item?.url));
    return items;
}

function ensureMinimumLinks(html = '', candidates = [], minimum = 3, maximum = 4) {
    let out = String(html || '');
    let count = countAnchors(out);
    if (count >= minimum) return trimAnchorsToMax(out, maximum);

    const existing = new Set((out.match(/https?:\/\/[^'"\s<]+/gi) || []).map((value) => String(value).trim()));
    const additions = [];
    for (const item of Array.isArray(candidates) ? candidates : []) {
        if (count >= minimum || count >= maximum) break;
        const safeUrl = String(item?.url || '').trim();
        const safeTitle = escapeHtml(item?.title || 'Related source');
        if (!safeUrl || existing.has(safeUrl)) continue;
        additions.push(`<p>Further context: <a href="${safeUrl}" target="_blank" rel="nofollow noopener noreferrer">${safeTitle}</a>.</p>`);
        existing.add(safeUrl);
        count += 1;
    }

    if (additions.length) {
        out = `${out}\n\n<h2>Further Resources</h2>\n${additions.join('\n')}`;
    }
    return trimAnchorsToMax(out, maximum);
}

async function aiRepairPublishBody(article = {}, publishValidation = {}) {
    const currentBody = String(article?.body_html || '').slice(0, 16000);
    const candidates = collectPublishLinkCandidates(article)
        .slice(0, 10)
        .map((item) => ({
            title: String(item?.title || '').slice(0, 180),
            url: String(item?.url || '').slice(0, 600),
        }));

    const prompt = `You repair WordPress article HTML for strict publish validation. Return JSON only.

Input:
- title: ${JSON.stringify(String(article?.title || '').slice(0, 240))}
- focus_keyphrase: ${JSON.stringify(String(article?.focus_keyphrase || '').slice(0, 120))}
- failed_validation: ${JSON.stringify(publishValidation || {})}
- link_candidates: ${JSON.stringify(candidates)}
- body_html: ${JSON.stringify(currentBody)}

Validation targets:
1) Body must contain 2-4 normal <a href="https://...">...</a> links (do not use data-protected).
2) At most 1 link per <p> paragraph.
3) No broken <blockquote>.
4) Keep "Related Reading on Barna.News" section as a valid <h2> followed by <ul> with linked <li> items when present.
5) Preserve meaning and facts; do not invent claims.
6) Output standard HTML tags only (<p>, <h2>, <h3>, <blockquote>, <ul>, <li>, <a>, <em>, <strong>, <hr>).
7) Never output Gutenberg comments.

Output schema:
{
  "body_html": "string",
  "changes": ["string"]
}`;

    try {
        const response = await generateWithFlash(prompt, { jsonMode: true, stage: 'publish_self_repair' });
        const repaired = String(response?.body_html || '').trim();
        if (!repaired) return null;
        return repaired;
    } catch (err) {
        console.warn(`  ⚠️  AI publish-body repair unavailable: ${err.message}`);
        return null;
    }
}

function enforcePublishBodyRules(html = '', article = {}) {
    let out = String(html || '');
    // Strip Related Reading so it doesn't count towards body link limits and isn't modified
    const sectionPattern = /<(h2|h3|p)[^>]*>\s*(?:<strong>)?\s*(Related Reading on Barna\.News|Further Resources(?: and Related Reading)?)\s*(?:<\/strong>)?\s*<\/\1>[\s\S]*?(?=<(h2|h3)\b|$)/gi;
    out = out.replace(sectionPattern, '').replace(/<h2>\s*Related Reading on Barna\.News\s*<\/h2>\s*(?!<(ul|ol)\b)[\s\S]*?(?=<(h2|h3)\b|$)/gi, '');

    // Force strip any hallucinated Gutenberg comments from the LLM QA pass
    out = out.replace(/<!--\s*\/?wp:[^\->]*-->/gi, '');

    out = enforceOneLinkPerParagraph(out);
    out = hardClampParagraphLinks(out);
    out = enforceOutboundLinkPolicy(out);
    out = trimAnchorsToMax(out, 4);
    out = ensureMinimumLinks(out, collectPublishLinkCandidates(article), 3, 4);
    out = enforceOneLinkPerParagraph(out);
    out = hardClampParagraphLinks(out);
    out = enforceOutboundLinkPolicy(out);

    out = normalizeRelatedReadingSections(out, article?.relatedArticles || []);
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

function validatePublishBodyRules(html = '') {
    const textOriginal = String(html || '');
    // Core body is the text without the related reading section
    const sectionPattern = /<(h2|h3|p)[^>]*>\s*(?:<strong>)?\s*(Related Reading on Barna\.News|Further Resources(?: and Related Reading)?)\s*(?:<\/strong>)?\s*<\/\1>[\s\S]*?(?=<(h2|h3)\b|$)/gi;
    const text = textOriginal.replace(sectionPattern, '').replace(/<h2>\s*Related Reading on Barna\.News\s*<\/h2>\s*(?!<(ul|ol)\b)[\s\S]*?(?=<(h2|h3)\b|$)/gi, '');

    const linkCount = countAnchors(text);

    // Check paragraphs individually to avoid cross-paragraph matching
    const paragraphs = text.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
    const paragraphViolations = paragraphs.filter(p => (p.match(/<a\b/gi) || []).length > 1).length;

    const brokenQuoteBlocks = (text.match(/<blockquote\b[^>]*>(?![\s\S]*?<\/blockquote>)/gi) || []).length;

    // Use (?!\s*<ul>) to prevent newline/whitespace from causing false positives
    const relatedPlaintextLeak = /<h2>\s*Related Reading on Barna\.News\s*<\/h2>(?!\s*<ul>)/i.test(textOriginal);

    return {
        linkCount,
        paragraphViolations,
        brokenQuoteBlocks,
        relatedPlaintextLeak,
        valid: linkCount >= 2 && linkCount <= 4 && paragraphViolations === 0 && brokenQuoteBlocks === 0 && !relatedPlaintextLeak,
    };
}

function buildImageAltText(article = {}) {
    const base = String(article?.focus_keyphrase || '').trim();
    const title = String(article?.title || '').trim();
    let alt = base ? `${base} - ${title}` : title;
    alt = alt.replace(/\s+/g, ' ').trim();
    if (alt.length > 120) alt = alt.slice(0, 120).replace(/\s+\S*$/, '').trim();
    if (alt.length < 70) {
        const extension = String(article?.meta_description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        alt = `${alt} ${extension}`.replace(/\s+/g, ' ').trim();
        if (alt.length > 120) alt = alt.slice(0, 120).replace(/\s+\S*$/, '').trim();
    }
    return alt || 'Barcelona news image';
}

function ensureSentence(text = '') {
    const cleaned = trimDanglingEndingWords(normalizeWhitespace(text));
    if (!cleaned) return '';
    if (/[.!?]$/.test(cleaned)) return cleaned;
    return `${cleaned}.`;
}

function injectFocusNaturally(meta = '', focus = '', title = '') {
    const cleanMeta = normalizeWhitespace(meta);
    const cleanFocus = normalizeWhitespace(focus);
    if (!cleanFocus || !cleanMeta) return ensureSentence(cleanMeta);
    if (cleanMeta.toLowerCase().includes(cleanFocus.toLowerCase())) {
        return ensureSentence(cleanMeta);
    }

    const titleLead = normalizeWhitespace(String(title || '').split(':')[0] || '');
    if (titleLead && titleLead.toLowerCase().includes(cleanFocus.toLowerCase())) {
        const withLead = `${titleLead}. ${cleanMeta}`;
        return ensureSentence(truncateAtWordBoundary(withLead, 155));
    }

    const prefixed = `${cleanFocus}: ${cleanMeta}`;
    if (prefixed.length <= 155) {
        return ensureSentence(prefixed);
    }

    const compact = truncateAtWordBoundary(cleanMeta, Math.max(70, 154 - cleanFocus.length - 12));
    const withSuffix = `${compact}. ${cleanFocus} update`;
    return ensureSentence(truncateAtWordBoundary(withSuffix, 155));
}

function stripHtml(html = '') {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const KEYPHRASE_STOP_WORDS = new Set([
    'a', 'an', 'and', 'or', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from',
    'is', 'are', 'was', 'were', 'be', 'as', 'it', 'its', 'that', 'this', 'these', 'those',
    'after', 'before', 'into', 'over', 'under', 'about', 'across', 'amid', 'during', 'than',
]);

const TITLE_SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'up', 'via']);
const CLICKBAIT_PATTERN = /\b(breaking|shocking|you won't believe|must see|unbelievable|jaw-dropping|explosive)\b/gi;
const LOW_TRUST_HINTS = [/rumou?r/i, /unverified/i, /anonymous/i, /alleged/i];
const SPONSORED_HINTS = [/affiliate/i, /sponsored/i, /partner/i, /ref=/i, /aff[_=-]?id/i, /utm_medium=affiliate/i];
const UGC_DOMAINS = /(reddit\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|forums?\.|comment\.)/i;

function normalizeWhitespace(text = '') {
    return String(text).replace(/\s+/g, ' ').trim();
}

function normalizePunctuation(text = '') {
    return normalizeWhitespace(String(text || '').replace(/\u2014/g, '-'));
}

function stripClickbait(text = '') {
    return normalizeWhitespace(String(text || '').replace(CLICKBAIT_PATTERN, '').replace(/[!?]{2,}/g, '!'));
}

function normalizeNewsTitle(title = '', { withBrandSuffix = false } = {}) {
    let out = normalizePunctuation(stripClickbait(title || ''));
    out = out.replace(/\s+[|\-–—]{1}\s+[|\-–—]{1}\s+/g, ' | ');
    out = out.replace(/\s+[|\-–—]\s*$/g, '').trim();
    if (!out) out = 'Barcelona News Update';

    const plain = out.replace(/\s+\|\s+Barna News$/i, '').trim();
    const limited = plain.slice(0, 60).trim();
    if (!withBrandSuffix) return limited;

    const withBrand = `${limited} | Barna News`;
    return withBrand.length <= 72 ? withBrand : `${limited.slice(0, 48).trim()} | Barna News`;
}

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

function enforceBritishEnglish(text = '') {
    let out = String(text || '');
    for (const [pattern, replacement] of BRITISH_SPELLING_RULES) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

function sanitizeQuoteBlock(raw = '') {
    const quoteInner = String(raw)
        .replace(/^<blockquote[^>]*>/i, '')
        .replace(/<\/blockquote>$/i, '')
        .trim();
    if (!quoteInner) return '';

    const withParagraphs = /<p[\s>]/i.test(quoteInner)
        ? quoteInner
        : `<p>${quoteInner.replace(/<br\s*\/?>/gi, '</p><p>')}</p>`;
    const cleaned = withParagraphs
        .replace(/<blockquote[^>]*>/gi, '')
        .replace(/<\/blockquote>/gi, '')
        .replace(/<p>\s*<\/p>/gi, '')
        .trim();
    return `<blockquote class="wp-block-quote">${cleaned}</blockquote>`;
}

function htmlToPlainText(html = '') {
    return normalizeWhitespace(String(html || '').replace(/<[^>]+>/g, ' '));
}

function buildSubheadingFromParagraph(paragraphHtml = '', focus = '') {
    const paragraphText = htmlToPlainText(paragraphHtml);
    if (!paragraphText) return '';

    const headingStopWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'for', 'nor', 'yet', 'so',
        'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'about', 'over',
        'after', 'before', 'between', 'during', 'without', 'under', 'within', 'across',
        'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that', 'this', 'these', 'those',
    ]);

    const focusWords = tokenizeForKeyphrase(focus)
        .map(word => word.toLowerCase())
        .filter(word => word.length > 2 && !headingStopWords.has(word));
    const paragraphWords = tokenizeForKeyphrase(paragraphText)
        .map(word => word.toLowerCase())
        .filter(word => word.length > 2 && !headingStopWords.has(word));

    const picked = uniqueTerms([...focusWords, ...paragraphWords]).slice(0, 6);
    if (picked.length < 2) return '';
    return toTitleCaseWords(picked).slice(0, 70);
}

function isSubheadingRelevant(heading = '', context = '') {
    const headingTokens = tokenizeForKeyphrase(heading)
        .map(token => token.toLowerCase())
        .filter(token => token.length > 2);
    if (!headingTokens.length) return false;

    const contextTokens = new Set(
        tokenizeForKeyphrase(context)
            .map(token => token.toLowerCase())
            .filter(token => token.length > 2)
    );
    if (!contextTokens.size) return false;

    const overlap = headingTokens.filter(token => contextTokens.has(token)).length;
    return overlap / headingTokens.length >= 0.45;
}

function ensureSubheadingDistribution(html = '', focus = '') {
    const input = String(html || '');
    if (!input || /<h2[\s>]/i.test(input)) return input;
    const paragraphs = input.match(/<p[\s\S]*?<\/p>/gi) || [];
    if (paragraphs.length < 6) return input;

    const contextText = `${normalizeWhitespace(String(focus || ''))} ${htmlToPlainText(input)}`.trim();
    let insertedCount = 0;
    let cursor = 0;
    let rebuilt = '';

    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        const idx = input.indexOf(p, cursor);
        if (idx === -1) continue;
        const between = input.slice(cursor, idx);
        rebuilt += between;

        if (i > 0 && i % 3 === 0 && insertedCount < 3) {
            const candidate = buildSubheadingFromParagraph(p, focus);
            if (candidate && isSubheadingRelevant(candidate, contextText)) {
                rebuilt += `<h2>${escapeHtml(candidate)}</h2>`;
                insertedCount += 1;
            }
        }

        rebuilt += p;
        cursor = idx + p.length;
    }

    rebuilt += input.slice(cursor);
    return rebuilt || input;
}

function improveBodyHtmlForPublish(html = '', focus = '') {
    const normalized = normalizePunctuation(html || '');
    const limitedQuotes = limitQuoteDensity(normalized, 300);
    const quoted = limitedQuotes.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, (raw) => sanitizeQuoteBlock(raw));
    const british = enforceBritishEnglish(quoted);
    const withHeadings = ensureSubheadingDistribution(british, focus);
    return withHeadings
        .replace(/\s*<p>([^<]{1,80})<\/p>\s*$/i, (match, tail) => {
            const cleanTail = normalizeWhitespace(tail);
            if (cleanTail.split(/\s+/).length <= 5 && !/[.!?]$/.test(cleanTail)) return '';
            return match;
        })
        .trim();
}

function normalizeTitleCase(title = '') {
    const cleaned = normalizePunctuation(title);
    if (!cleaned) return 'Barcelona News Update';

    const words = cleaned.split(' ');
    return words.map((word, index) => {
        if (!word) return '';
        if (/^[A-Z0-9]{2,}$/.test(word)) return word;

        const lower = word.toLowerCase();
        if (index > 0 && index < words.length - 1 && TITLE_SMALL_WORDS.has(lower)) {
            return lower;
        }

        return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    }).join(' ').slice(0, 90);
}

function tokenizeForKeyphrase(text = '') {
    return normalizeWhitespace(text)
        .split(/[^\p{L}\p{N}]+/u)
        .map(t => t.trim())
        .filter(Boolean);
}

function toTitleCaseWords(words = []) {
    return words
        .map(word => word ? `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}` : '')
        .join(' ')
        .trim();
}

function uniqueTerms(words = []) {
    const seen = new Set();
    const out = [];
    for (const word of words) {
        const key = word.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(word);
    }
    return out;
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanMetaSource(text = '', { focus = '', title = '' } = {}) {
    let out = normalizeWhitespace(text);
    if (!out) return '';

    const titleLead = String(title || '').split(':')[0].trim();
    const candidates = [title, titleLead, focus].filter(Boolean).map(v => String(v).trim()).sort((a, b) => b.length - a.length);

    for (const phrase of candidates) {
        const escaped = escapeRegExp(phrase);
        out = out.replace(new RegExp(`^${escaped}\\s*[:\\-–—]?\\s*`, 'i'), '');
    }

    out = collapseRepeatedLeadPhrases(out);
    out = out.replace(/\s+[,:;\-–—]\s*$/g, '').trim();
    return out;
}

function trimDanglingEndingWords(text = '') {
    let out = String(text).trim();
    out = out.replace(/\b(?:and|or|the|a|an|to|for|of|in|on|with|from|by|at)\s*$/i, '').trim();
    out = out.replace(/[,:;\-–—]\s*$/g, '').trim();
    return out;
}

function buildFocusKeyphrase({ preferred = '', title = '', tags = [] } = {}) {
    const titleLead = String(title || '').split(':')[0] || '';
    const candidateSources = [preferred, title, Array.isArray(tags) ? tags.join(' ') : ''];
    if (titleLead.trim()) {
        candidateSources.splice(1, 0, titleLead);
    }

    for (const source of candidateSources) {
        const words = tokenizeForKeyphrase(source).filter(w => w.length > 2);
        const filtered = words.filter(w => !KEYPHRASE_STOP_WORDS.has(w.toLowerCase()));
        const picked = uniqueTerms(filtered.length >= 2 ? filtered : words).slice(0, 4);
        if (picked.length >= 2) {
            return toTitleCaseWords(picked).slice(0, 60);
        }
    }

    const fallbackWords = uniqueTerms(tokenizeForKeyphrase(title)).slice(0, 4);
    if (fallbackWords.length) {
        return toTitleCaseWords(fallbackWords).slice(0, 60);
    }
    return 'Barcelona News Update';
}

function collapseRepeatedLeadPhrases(text = '') {
    let out = normalizeWhitespace(text);
    out = out.replace(/^([^:]{8,90}):\s*\1:\s*/i, '$1: ');
    out = out.replace(/^([\p{L}\p{N}\s'’&\-]{8,110})\s+\1\b/iu, '$1');
    out = out.replace(/^(?:([^:]{8,90}):\s*){2,}/i, '$1: ');
    return out;
}

function truncateAtWordBoundary(text = '', max = 155) {
    const clean = normalizeWhitespace(text);
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max + 1);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > 90) {
        return cut.slice(0, lastSpace).trim().replace(/[,:;\-]$/, '');
    }
    return clean.slice(0, max).trim().replace(/[,:;\-]$/, '');
}

function firstNCharsEndingSentence(text = '', max = 155, min = 120) {
    const clean = normalizeWhitespace(text);
    if (!clean) return '';

    const sentences = clean.match(/[^.!?]+[.!?]/g) || [];
    let selected = '';
    for (const sentence of sentences) {
        const next = normalizeWhitespace(`${selected} ${sentence}`);
        if (next.length > max) break;
        selected = next;
        if (selected.length >= min) break;
    }
    if (selected.length >= 90) {
        return selected;
    }
    return truncateAtWordBoundary(clean, max);
}

function pickCompleteSentenceMeta(text = '', max = 155, min = 110) {
    const clean = normalizeWhitespace(text);
    if (!clean) return '';

    const sentences = (clean.match(/[^.!?]+[.!?]/g) || [])
        .map(s => normalizeWhitespace(s))
        .filter(Boolean);

    let selected = '';
    for (const sentence of sentences) {
        const next = normalizeWhitespace(selected ? `${selected} ${sentence}` : sentence);
        if (next.length > max) break;
        selected = next;
        if (selected.length >= min) break;
    }

    if (selected.length >= 70 && /[.!?]$/.test(selected)) {
        return selected;
    }

    const fallbackSentence = sentences.find(s => s.length >= 60 && s.length <= max);
    if (fallbackSentence) {
        return fallbackSentence;
    }

    return '';
}

function containsSuspiciousMetaArtifacts(text = '') {
    const value = String(text || '').toLowerCase();
    return (
        /<\/?(style|script|svg|path|video|source)\b/.test(value) ||
        /\b(?:transition|animation|transform|filter)\s*:\s*[^.]{1,60};/.test(value) ||
        /\b\d+(?:\.\d+)?s\s+ease\b/.test(value) ||
        /\{\s*[^}]*\}/.test(value)
    );
}

function sanitizeMetaCandidate(text = '') {
    let out = String(text || '');
    out = out
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\b(?:transition|animation|transform|filter)\s*:[^.;]{1,80};?/gi, ' ')
        .replace(/\b\d+(?:\.\d+)?s\s+ease\b/gi, ' ')
        .replace(/[{}]/g, ' ');

    out = collapseRepeatedLeadPhrases(stripClickbait(normalizeWhitespace(out)));
    out = out.replace(/["“”]/g, '');
    out = out.replace(/\s+[,:;\-–—]\s*$/g, '').trim();
    return out;
}

function buildMetaFallbackSentence({ focus = '', title = '' } = {}) {
    const topic = normalizeTitleCase(title || focus || 'Barcelona news');
    let meta = `${topic}. Key developments, verified context, and what happens next.`;
    if (meta.length > 155) {
        const compactTopic = truncateAtWordBoundary(topic, 75);
        meta = `${compactTopic}: key developments and verified context.`;
    }
    if (meta.length > 155) {
        meta = `${focus || 'Barcelona update'}: key developments and verified context.`;
    }
    return meta;
}

function buildMetaDescription({ existing = '', excerpt = '', content = '', focus = '', title = '' } = {}) {
    const contentCandidate = pickCompleteSentenceMeta(cleanMetaSource(sanitizeMetaCandidate(content), { focus, title }), 155, 110);
    const excerptCandidate = pickCompleteSentenceMeta(cleanMetaSource(sanitizeMetaCandidate(excerpt), { focus, title }), 155, 110);
    const existingCandidate = pickCompleteSentenceMeta(cleanMetaSource(sanitizeMetaCandidate(existing), { focus, title }), 155, 110);
    let meta = contentCandidate || excerptCandidate || existingCandidate;
    meta = collapseRepeatedLeadPhrases(meta);

    if (!meta) {
        meta = buildMetaFallbackSentence({ focus, title });
    }

    meta = injectFocusNaturally(meta, focus, title);
    meta = collapseRepeatedLeadPhrases(meta);
    if (meta.length > 155) {
        meta = truncateAtWordBoundary(meta, 150);
    }
    if (meta.length < 120) {
        const fallback = pickCompleteSentenceMeta(cleanMetaSource(sanitizeMetaCandidate(content || excerpt || existing), { focus, title }), 155, 120);
        if (fallback) meta = fallback;
    }
    return ensureSentence(meta);
}

function countWords(text = '') {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function limitQuoteDensity(html = '', wordsPerQuote = 350) {
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

async function optimizeMetaDescriptionWithFlash({ existing = '', bodyText = '', focus = '', title = '' } = {}) {
    const fallback = buildMetaDescription({
        existing,
        excerpt: '',
        content: bodyText,
        focus,
        title,
    });

    const prompt = `You are a world-leading SEO editor. Return JSON only.

Write one meta description for a news article with these strict rules:
- 120 to 155 characters.
- Complete sentence.
- Active voice.
- Specific and concise.
- Include who/what/where and key impact where possible.
- Use 1-2 natural secondary terms if relevant (no keyword stuffing).
- Include focus phrase naturally when possible.
- No CSS/style/script/code fragments.
- No quotes, ALL CAPS, or excessive punctuation.
- No repeated lead phrases.

Input:
- title: ${JSON.stringify(title || '')}
- focus_keyphrase: ${JSON.stringify(focus || '')}
- existing_meta: ${JSON.stringify(sanitizeMetaCandidate(existing || ''))}
- article_excerpt: ${JSON.stringify(sanitizeMetaCandidate(String(bodyText || '').slice(0, 1200)))}

Schema:
{
  "meta_description": "string"
}`;

    try {
        const response = await generateWithFlash(prompt, { jsonMode: true, stage: 'meta_optimize' });
        const candidateRaw = response?.meta_description || '';
        const candidate = sanitizeMetaCandidate(candidateRaw);
        if (!candidate || containsSuspiciousMetaArtifacts(candidateRaw)) {
            return fallback;
        }
        let finalMeta = injectFocusNaturally(candidate, focus, title);
        finalMeta = collapseRepeatedLeadPhrases(finalMeta);
        finalMeta = finalMeta.replace(/["“”]/g, '');
        if (finalMeta.length > 155) finalMeta = truncateAtWordBoundary(finalMeta, 155);
        if (finalMeta.length < 120) {
            const secondPass = buildMetaDescription({ existing: finalMeta, excerpt: '', content: bodyText, focus, title });
            finalMeta = secondPass || fallback;
        }
        return ensureSentence(finalMeta);
    } catch {
        return fallback;
    }
}

function normalizeYoastFromPost(post = {}) {
    const title = normalizeTitleCase(post?.title?.raw || post?.title?.rendered || '');
    const rawMeta = post?.meta || {};
    const existingFocus = (rawMeta._yoast_wpseo_focuskw || rawMeta.yoast_wpseo_focuskw || '').trim();
    const existingMetaDesc = (rawMeta._yoast_wpseo_metadesc || rawMeta.yoast_wpseo_metadesc || '').trim();

    const focus = buildFocusKeyphrase({
        preferred: existingFocus,
        title,
        tags: post?.tags || [],
    });

    const excerptText = stripHtml(post?.excerpt?.raw || post?.excerpt?.rendered || '');
    const contentText = stripHtml(post?.content?.raw || post?.content?.rendered || '');

    const metaDescription = buildMetaDescription({
        existing: existingMetaDesc,
        excerpt: excerptText,
        content: contentText,
        focus,
        title,
    });

    const seoTitle = focus && title && !title.toLowerCase().startsWith(focus.toLowerCase())
        ? `${focus}: ${title}`.slice(0, 90)
        : title;

    return {
        title: seoTitle || title || 'Barcelona News Update',
        focusKeyphrase: focus,
        metaDescription,
    };
}

function ensureYoastReady(article = {}) {
    const focus = buildFocusKeyphrase({
        preferred: article.focus_keyphrase || '',
        title: article.title || '',
        tags: article.tags || [],
    });
    const baseTitle = normalizeNewsTitle(normalizeTitleCase(article.title || 'Barcelona News Update'));
    const seoTitle = normalizeNewsTitle(
        focus && !baseTitle.toLowerCase().startsWith(focus.toLowerCase())
            ? `${focus}: ${baseTitle}`
            : baseTitle,
        { withBrandSuffix: true }
    );
    const slug = slugify(article.slug || focus || baseTitle);

    const bodyText = stripHtml(article.body_html || '');
    const meta = buildMetaDescription({
        existing: article.meta_description || '',
        excerpt: '',
        content: bodyText,
        focus,
        title: baseTitle,
    });

    let bodyHtml = improveBodyHtmlForPublish(
        String(article.body_html || '').replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, ''),
        focus,
    );
    bodyHtml = enforcePublishBodyRules(bodyHtml, article);

    return {
        ...article,
        title: baseTitle,
        seo_title: seoTitle,
        focus_keyphrase: focus,
        slug,
        meta_description: meta,
        body_html: bodyHtml,
    };
}

function sanitizeHtmlForGutenberg(html = '') {
    let out = String(html || '');
    if (!out.trim()) return '';

    out = out
        .replace(/\r\n?/g, '\n')
        .replace(/<hr\b([^>]*)>/gi, '<hr$1/>')
        .replace(/<p>\s*<hr\b[^>]*\/?>(?:\s|&nbsp;)*<\/p>/gi, '<hr/>')
        .replace(/<p>([\s\S]*?)<(blockquote|ul|ol|h2|h3)\b([^>]*)>([\s\S]*?)<\/\2>([\s\S]*?)<\/p>/gi,
            (_, pre, tag, attrs, inner, post) =>
                `<p>${pre.trim()}</p>\n<${tag}${attrs}>${inner}</${tag}>\n<p>${post.trim()}</p>`)
        .replace(/<p>\s*<\/p>/gi, '')
        .replace(/(<p>\s*)+<p>/gi, '<p>')
        .replace(/<\/p>(\s*<\/p>)+/gi, '</p>')
        .replace(/<blockquote[^>]*>\s*<\/blockquote>/gi, '')
        .replace(/<blockquote\b[^>]*>(?![\s\S]*?<\/blockquote>)/gi, '')
        .replace(/<(ul|ol)\b[^>]*>(?![\s\S]*?<\/\1>)/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return out;
}

function buildSeparatorBlock() {
    return '<!-- wp:separator --><hr class="wp-block-separator"/><!-- /wp:separator -->';
}

function appendFragmentBlocks(parts = [], fragment = '') {
    const raw = String(fragment || '').trim();
    if (!raw) return;

    const cleaned = raw
        .replace(/(?:^|\s)<\/(?:p|blockquote|ul|ol|li|h2|h3)>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return;

    if (/^<(?:blockquote|ul|ol|li|p|h2|h3)\b[^>]*>$/i.test(cleaned)) return;
    if (/^<li\b[^>]*>.*$/i.test(cleaned) && !/<\/li>/i.test(cleaned)) {
        const listText = cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!listText) return;
        parts.push(`<!-- wp:paragraph --><p>${listText}</p><!-- /wp:paragraph -->`);
        return;
    }
    if (/^<(?:ul|ol)\b/i.test(cleaned) && !/<\/(?:ul|ol)>/i.test(cleaned)) {
        const listText = cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!listText) return;
        parts.push(`<!-- wp:paragraph --><p>${listText}</p><!-- /wp:paragraph -->`);
        return;
    }

    const chunks = cleaned.split(/(<hr\b[^>]*\/?>)/gi).filter(Boolean);
    chunks.forEach((chunk) => {
        const value = String(chunk || '').trim();
        if (!value) return;
        if (/^<hr\b[^>]*\/?>$/i.test(value)) {
            parts.push(buildSeparatorBlock());
            return;
        }
        if (/^(?:<\/(?:p|blockquote|ul|ol|li|h2|h3)>\s*)+$/i.test(value)) return;
        if (/^<[^>]+>/.test(value)) {
            parts.push(`<!-- wp:html -->${value}<!-- /wp:html -->`);
            return;
        }
        parts.push(`<!-- wp:paragraph --><p>${value}</p><!-- /wp:paragraph -->`);
    });
}

function repairGutenbergHtmlBlocks(content = '') {
    return String(content || '').replace(/<!-- wp:html -->([\s\S]*?)<!-- \/wp:html -->/gi, (_full, inner) => {
        const html = String(inner || '').trim();
        if (!html) return '';
        if (/^(?:<\/(?:p|blockquote|ul|ol|li|h2|h3)>\s*)+$/i.test(html)) return '';
        if (/^<hr\b[^>]*\/?>$/i.test(html)) return buildSeparatorBlock();
        return `<!-- wp:html -->${html}<!-- /wp:html -->`;
    });
}

function hasBalancedGutenbergComments(content = '') {
    const stack = [];
    const pattern = /<!--\s*(\/?)wp:([a-z0-9-]+)(?:\s+[^>]*)?\s*-->/gi;
    let match;
    while ((match = pattern.exec(String(content || ''))) !== null) {
        const closing = match[1] === '/';
        const name = String(match[2] || '').toLowerCase();
        if (!name) continue;
        if (!closing) {
            stack.push(name);
            continue;
        }
        const prev = stack.pop();
        if (prev !== name) return false;
    }
    return stack.length === 0;
}

function ensureValidGutenbergContent(content = '') {
    const repaired = repairGutenbergHtmlBlocks(content)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!hasBalancedGutenbergComments(repaired)) {
        const err = new Error('Generated Gutenberg content has unbalanced block comments after repair');
        err.code = 'invalid_gutenberg_blocks';
        throw err;
    }
    return repaired;
}

export function toGutenbergBlocks(html = '') {
    if (!html) return '';
    if (html.includes('<!-- wp:')) return ensureValidGutenbergContent(html);

    const sanitized = sanitizeHtmlForGutenberg(html);
    if (!sanitized) return '';

    const pattern = /<(p|blockquote|ul|ol|h2|h3)([^>]*)>[\s\S]*?<\/\1>/gi;
    const parts = [];
    let cursor = 0;
    let match;

    while ((match = pattern.exec(sanitized)) !== null) {
        const before = sanitized.slice(cursor, match.index).trim();
        if (before) {
            appendFragmentBlocks(parts, before);
        }

        const raw = match[0];
        const tag = (match[1] || '').toLowerCase();
        if (tag === 'p') {
            parts.push(`<!-- wp:paragraph -->${raw}<!-- /wp:paragraph -->`);
        } else if (tag === 'blockquote') {
            const safeQuote = sanitizeQuoteBlock(raw);
            parts.push(`<!-- wp:quote -->${safeQuote}<!-- /wp:quote -->`);
        } else if (tag === 'ul' || tag === 'ol') {
            const listInner = raw.replace(/^<(?:ul|ol)\b[^>]*>/i, '').replace(/<\/(?:ul|ol)>$/i, '');
            const items = [];
            const liPattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
            let liMatch;
            while ((liMatch = liPattern.exec(listInner)) !== null) {
                items.push(`<!-- wp:list-item -->\n<li>${liMatch[1].trim()}</li>\n<!-- /wp:list-item -->`);
            }
            const innerHtml = items.join('\n');
            if (tag === 'ol') {
                parts.push(`<!-- wp:list {"ordered":true} -->\n<ol class="wp-block-list">${innerHtml}</ol>\n<!-- /wp:list -->`);
            } else {
                parts.push(`<!-- wp:list -->\n<ul class="wp-block-list">${innerHtml}</ul>\n<!-- /wp:list -->`);
            }
        } else if (tag === 'h2') {
            parts.push(`<!-- wp:heading {"level":2} -->${raw}<!-- /wp:heading -->`);
        } else if (tag === 'h3') {
            parts.push(`<!-- wp:heading {"level":3} -->${raw}<!-- /wp:heading -->`);
        } else {
            parts.push(`<!-- wp:html -->${raw}<!-- /wp:html -->`);
        }
        cursor = pattern.lastIndex;
    }

    const tail = sanitized.slice(cursor).trim();
    if (tail) {
        appendFragmentBlocks(parts, tail);
    }

    return ensureValidGutenbergContent(parts.join('\n'));
}

async function prePublishQualityCheck(article = {}) {
    // Strip the Related Reading section before handing to the LLM so it cannot
    // mangle the linked <li> items — we will re-attach it with proper links after.
    const relatedSectionPattern = /<h2>\s*Related Reading on Barna\.News\s*<\/h2>[\s\S]*?(?=<h2\b|<h3\b|$)/gi;
    const bodyForLlm = String(article.body_html || '').replace(relatedSectionPattern, '').replace(/\n{3,}/g, '\n\n').trim();

    const prompt = `You are a senior SEO editor and WordPress QA specialist. Return JSON only.

Input:
- title: ${JSON.stringify(article.title || '')}
- seo_title: ${JSON.stringify(article.seo_title || article.title || '')}
- focus_keyphrase: ${JSON.stringify(article.focus_keyphrase || '')}
- meta_description: ${JSON.stringify(article.meta_description || '')}
- body_excerpt: ${JSON.stringify(stripHtml(bodyForLlm).slice(0, 1200))}
- body_html: ${JSON.stringify(bodyForLlm.slice(0, 12000))}

Rules:
1) Keep title and seo_title distinct when useful, but both high-quality and readable.
2) meta_description must be a complete sentence, <=155 chars, no generic filler, no em dash.
3) focus_keyphrase must be 2-4 words.
4) No duplicate heading/dek language.
5) No trailing junk phrase at the end.
6) Body must use British English spellings.
7) Add <h2> subheadings if the article is long and has none.
8) Reduce passive voice, shorten long sentences, and add natural transition words.
9) YOU MUST preserve or add inline hyperlinks for any referenced related articles. DO NOT un-link them.
10) STRICT RULE: Format paragraphs using standard HTML (<p>, <h2>, <blockquote>, <ul>). NEVER output WordPress block comments (e.g. <!-- wp:paragraph -->).

Output schema:
{
  "title": "string",
  "seo_title": "string",
  "focus_keyphrase": "string",
  "meta_description": "string",
  "body_html": "string",
  "issues": ["string"]
}`;

    try {
        const qa = await generateWithFlash(prompt, { jsonMode: true, stage: 'prepublish_qa' });
        // Improve body but do NOT re-attach related section here — publishDraft owns that
        const bodyHtmlCandidate = improveBodyHtmlForPublish(qa?.body_html || bodyForLlm, qa?.focus_keyphrase || article.focus_keyphrase || '');
        const optimizedMeta = await optimizeMetaDescriptionWithFlash({
            existing: qa?.meta_description || article.meta_description || '',
            bodyText: stripHtml(bodyHtmlCandidate || bodyForLlm),
            focus: qa?.focus_keyphrase || article.focus_keyphrase || '',
            title: qa?.title || article.title || '',
        });
        return {
            title: normalizeNewsTitle(normalizeTitleCase(qa?.title || article.title || '')),
            seo_title: normalizeNewsTitle(qa?.seo_title || article.seo_title || article.title || '', { withBrandSuffix: true }),
            focus_keyphrase: normalizePunctuation(qa?.focus_keyphrase || article.focus_keyphrase || '').slice(0, 60),
            meta_description: optimizedMeta,
            body_html: enforceOutboundLinkPolicy(bodyHtmlCandidate),
            issues: Array.isArray(qa?.issues) ? qa.issues : [],
        };
    } catch (err) {
        console.warn(`  ⚠️  Pre-publish QA unavailable, continuing with local normalization: ${err.message}`);
        const fallbackBody = improveBodyHtmlForPublish(article.body_html || '', article.focus_keyphrase || '');
        const optimizedMeta = await optimizeMetaDescriptionWithFlash({
            existing: article.meta_description,
            bodyText: stripHtml(fallbackBody || article.body_html || ''),
            focus: article.focus_keyphrase || '',
            title: article.title || '',
        });
        return {
            title: normalizeNewsTitle(normalizeTitleCase(article.title || '')),
            seo_title: normalizeNewsTitle(article.seo_title || article.title || '', { withBrandSuffix: true }),
            focus_keyphrase: normalizePunctuation(article.focus_keyphrase || '').slice(0, 60),
            meta_description: optimizedMeta,
            body_html: enforceOutboundLinkPolicy(fallbackBody),
            issues: ['qa-fallback-used'],
        };
    }
}

async function createCategory(name) {
    const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
    const response = await fetch(`${WP_URL()}/wp-json/wp/v2/categories`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: normalizeTitleCase(name).slice(0, 80) }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Category create failed (${response.status}): ${errorText}`);
    }
    return response.json();
}

async function pickCategoryId(article, existingCategories = []) {
    if (!existingCategories.length) return null;
    const fallbackNews = existingCategories.find(c => String(c.slug).toLowerCase() === 'news') || existingCategories[0];

    const prompt = `You assign WordPress categories for Barcelona news. Return JSON only.

Article:
- title: ${JSON.stringify(article.title || '')}
- summary: ${JSON.stringify(stripHtml(article.body_html || '').slice(0, 900))}
- tags: ${JSON.stringify(article.tags || [])}

Existing categories:
${existingCategories.map(c => `- ${c.slug}: ${c.name}`).join('\n')}

If no strong match exists, propose a short new category name.

Schema:
{
  "chosen_category_slug": "string",
  "proposed_new_category": "string",
  "confidence": 0.0,
  "reason": "string"
}`;

    try {
        const result = await generateWithFlash(prompt, { jsonMode: true, stage: 'category_pick' });
        const chosenSlug = String(result?.chosen_category_slug || '').trim().toLowerCase();
        const chosen = existingCategories.find(c => String(c.slug).toLowerCase() === chosenSlug);
        const confidence = Number(result?.confidence);

        if (chosen && Number.isFinite(confidence) && confidence >= 0.55) {
            return chosen.id;
        }

        const proposed = String(result?.proposed_new_category || '').trim();
        if (proposed && Number.isFinite(confidence) && confidence >= 0.75) {
            try {
                const created = await createCategory(proposed);
                return created?.id || fallbackNews?.id || null;
            } catch (err) {
                console.warn(`  ⚠️  Category auto-create failed (${proposed}): ${err.message}`);
            }
        }
    } catch (err) {
        console.warn(`  ⚠️  Category AI selection failed, falling back: ${err.message}`);
    }

    return fallbackNews?.id || null;
}

function getAuthHeaders() {
    if (!process.env.WP_USER || !process.env.WP_APP_PASSWORD) {
        throw new Error('WordPress credentials missing. Set WP_USER and WP_APP_PASSWORD in your environment.');
    }
    const auth = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
    return { 'Authorization': `Basic ${auth}` };
}

function isTransportError(err) {
    const message = String(err?.message || '').toLowerCase();
    const causeCode = String(err?.cause?.code || '').toLowerCase();
    return (
        message.includes('fetch failed') ||
        message.includes('network') ||
        message.includes('socket hang up') ||
        causeCode.includes('econnreset') ||
        causeCode.includes('enotfound') ||
        causeCode.includes('etimedout')
    );
}

function isRetryableWordPressError(err) {
    const status = Number(err?.status || 0);
    if (isTransportError(err)) return true;
    if (status === 408 || status === 429) return true;
    if (status >= 500) return true;
    return false;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetries(label, task, {
    attempts = 3,
    baseDelayMs = 900,
} = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await task();
        } catch (err) {
            lastError = err;
            if (!isRetryableWordPressError(err) || attempt >= attempts) break;
            const waitMs = baseDelayMs * attempt;
            console.warn(`  ⚠️  ${label} failed (attempt ${attempt}/${attempts}): ${err.message}. Retrying in ${waitMs}ms...`);
            await delay(waitMs);
        }
    }

    if (lastError) {
        lastError.retryable = isRetryableWordPressError(lastError);
        throw lastError;
    }
    throw new Error(`${label} failed`);
}

async function syncYoastMeta(postId, { focuskw, title, metadesc }) {
    const payload = {
        post_id: Number(postId),
        focuskw: focuskw || '',
        title: title || '',
        metadesc: metadesc || '',
    };

    const res = await fetch(`${WP_URL()}/wp-json/barna/v1/yoast-sync`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Yoast sync failed (${res.status}): ${errorText}`);
    }

    return await res.json();
}

async function getYoastStatus(postId) {
    const res = await fetch(`${WP_URL()}/wp-json/barna/v1/yoast-status?post_id=${Number(postId)}`, {
        headers: getAuthHeaders(),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Yoast status check failed (${res.status}): ${errorText}`);
    }

    return await res.json();
}

/**
 * Get available authors from WordPress
 */
export async function getAuthors() {
    try {
        const res = await fetch(`${WP_URL()}/wp-json/wp/v2/users?per_page=100&_fields=id,name,slug`, {
            headers: getAuthHeaders(),
        });
        if (!res.ok) return [];
        return await res.json();
    } catch (err) {
        console.error('Failed to fetch authors:', err.message);
        return [];
    }
}

/**
 * Get available categories from WordPress
 */
export async function getCategories() {
    try {
        const res = await fetch(`${WP_URL()}/wp-json/wp/v2/categories?per_page=100&_fields=id,name,slug`, {
            headers: getAuthHeaders(),
        });
        if (!res.ok) return [];
        return await res.json();
    } catch (err) {
        console.error('Failed to fetch categories:', err.message);
        return [];
    }
}

// Maps WordPress category names to Reddit flair names for r/BCNEnglishSpeakers.
// Category name comparison is case-insensitive; add entries here as needed.
const CATEGORY_TO_REDDIT_FLAIR = {
    'crime': 'Crime',
    'culture': 'Culture',
    'catalan': 'Catalan / Catalonia',
    'catalonia': 'Catalan / Catalonia',
    'catalan / catalonia': 'Catalan / Catalonia',
    'transport': 'Transport',
    'politics': 'Politics',
    'economy': 'Economy & Finance',
    'economy & finance': 'Economy & Finance',
    'finance': 'Economy & Finance',
    'housing': 'Housing',
    'urban development': 'Urban Development',
    'urban': 'Urban Development',
    'environment': 'Environment',
    'tourism': 'Tourism',
    'health': 'Health',
    'education': 'Education',
    'sport': 'Sport',
    'sports': 'Sport',
    'technology': 'Technology',
    'food & drink': 'Food & Drink',
    'food': 'Food & Drink',
};

function mapCategoryToFlair(categoryNames = []) {
    for (const name of categoryNames) {
        const key = String(name || '').trim().toLowerCase();
        if (CATEGORY_TO_REDDIT_FLAIR[key]) return CATEGORY_TO_REDDIT_FLAIR[key];
    }
    return '';
}

export async function getRecentPostsForSocial({ limit = 20 } = {}) {
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(100, Math.floor(Number(limit)))) : 20;
    const headers = getAuthHeaders();
    const postFields = 'id,title,link,date,status,excerpt,content,featured_media,categories,_embedded.wp:featuredmedia,_embedded.wp:term';

    const [publishedRes, draftRes] = await Promise.all([
        fetch(`${WP_URL()}/wp-json/wp/v2/posts?status=publish&per_page=${safeLimit}&_embed=wp:featuredmedia,wp:term&_fields=${encodeURIComponent(postFields)}`, { headers }),
        fetch(`${WP_URL()}/wp-json/wp/v2/posts?status=draft&context=edit&per_page=${safeLimit}&_embed=wp:featuredmedia,wp:term&_fields=${encodeURIComponent(postFields)}`, { headers }),
    ]);

    const parsePosts = async (res) => {
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Failed to load posts (${res.status}): ${errorText}`);
        }
        return res.json();
    };

    const [published, drafts] = await Promise.all([parsePosts(publishedRes), parsePosts(draftRes)]);
    const merged = [...published, ...drafts];
    const deduped = [];
    const seen = new Set();

    for (const post of merged) {
        if (!post?.id || seen.has(post.id)) continue;
        seen.add(post.id);
        const featured = post?._embedded?.['wp:featuredmedia']?.[0] || null;
        const featuredSizes = featured?.media_details?.sizes || {};
        const featuredImageUrl = featured?.source_url || '';
        const featuredThumb = featuredSizes?.medium_large?.source_url || featuredSizes?.medium?.source_url || featuredSizes?.thumbnail?.source_url || featuredImageUrl;

        // Extract category names from embedded wp:term (index 0 = categories, index 1 = tags)
        const embeddedTerms = post?._embedded?.['wp:term'] || [];
        const categoryTerms = Array.isArray(embeddedTerms[0]) ? embeddedTerms[0] : [];
        const categoryNames = categoryTerms.map(t => t?.name || '').filter(Boolean);
        const predicted_flair = mapCategoryToFlair(categoryNames);

        deduped.push({
            id: post.id,
            title: post?.title?.rendered || post?.title?.raw || '',
            link: post?.link || '',
            date: post?.date || '',
            status: post?.status || '',
            excerpt: post?.excerpt?.rendered || post?.excerpt?.raw || '',
            content: post?.content?.rendered || post?.content?.raw || '',
            summary: stripHtml(post?.excerpt?.rendered || post?.excerpt?.raw || post?.content?.rendered || post?.content?.raw || '').slice(0, 600),
            featured_image_url: featuredImageUrl,
            featured_image_thumb_url: featuredThumb,
            featured_image_alt: featured?.alt_text || '',
            predicted_flair,
        });
    }

    deduped.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return deduped.slice(0, safeLimit);
}

/**
 * Find or create tags in WordPress
 */
async function getOrCreateTags(tagNames) {
    const tagIds = [];
    const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };

    for (const name of tagNames) {
        try {
            // Search for existing tag
            const searchRes = await fetch(
                `${WP_URL()}/wp-json/wp/v2/tags?search=${encodeURIComponent(name)}&_fields=id,name`,
                { headers: getAuthHeaders() }
            );
            if (searchRes.ok) {
                const existing = await searchRes.json();
                const match = existing.find(t => t.name.toLowerCase() === name.toLowerCase());
                if (match) {
                    tagIds.push(match.id);
                    continue;
                }
            }

            // Create new tag
            const createRes = await fetch(`${WP_URL()}/wp-json/wp/v2/tags`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ name }),
            });
            if (createRes.ok) {
                const newTag = await createRes.json();
                tagIds.push(newTag.id);
            }
        } catch (err) {
            console.warn(`Failed to process tag "${name}": ${err.message}`);
        }
    }

    return tagIds;
}

/**
 * Upload a featured image to WordPress media library
 */
async function uploadFeaturedImage(imageData, title) {
    const filename = title.replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 50) + '.jpg';

    const media = await withRetries('WordPress media upload', async () => {
        const form = new FormData();
        form.append('file', imageData.buffer, {
            filename,
            contentType: imageData.mimeType,
            knownLength: imageData.buffer.length,
        });
        form.append('title', title);
        form.append('alt_text', imageData.altText || title);
        const res = await fetch(`${WP_URL()}/wp-json/wp/v2/media`, {
            method: 'POST',
            headers: {
                ...getAuthHeaders(),
                ...form.getHeaders(),
            },
            body: form,
        });
        if (!res.ok) {
            const errorText = await res.text();
            const err = new Error(`Media upload failed (${res.status}): ${errorText}`);
            err.status = res.status;
            err.retryable = isRetryableWordPressError(err);
            throw err;
        }
        return await res.json();
    });

    return media.id;
}

/**
 * Select a random author from the configured list.
 * Matches against WordPress user names.
 */
async function selectRandomAuthor() {
    const configuredAuthors = (process.env.AUTHORS || 'Laia Serra,Barbara Town,Brandon Watea')
        .split(',')
        .map(a => a.trim());

    const wpAuthors = await getAuthors();

    const normalize = (value = '') => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

    // Match configured names to WordPress user IDs
    const matchedAuthors = configuredAuthors
        .map(name => {
            const desired = normalize(name);
            const wp = wpAuthors.find(a =>
                normalize(a.name).includes(desired) ||
                desired.includes(normalize(a.name)) ||
                normalize(a.slug).includes(desired) ||
                desired.includes(normalize(a.slug))
            );
            return wp ? { name, id: wp.id } : null;
        })
        .filter(Boolean);

    if (matchedAuthors.length === 0) {
        console.warn('No matching authors found in WordPress. Using default.');
        return wpAuthors[0]?.id || 1;
    }

    const random = matchedAuthors[Math.floor(Math.random() * matchedAuthors.length)];
    console.log(`  👤 Assigned author: ${random.name}`);
    return random.id;
}

/**
 * Publish a draft post to WordPress with all SEO fields
 */
export async function publishDraft(article, imageData) {
    const normalized = ensureYoastReady(article);
    const qaRefined = await prePublishQualityCheck(normalized);
    const finalArticle = {
        ...normalized,
        ...qaRefined,
        body_html: qaRefined.body_html || normalized.body_html,
        // Always preserve original relatedArticles so the linked section is correct
        relatedArticles: normalized.relatedArticles || article.relatedArticles || [],
        research: normalized.research || article.research || {},
    };
    // Re-attach the Related Reading section with proper hyperlinks after the LLM QA pass
    // (the LLM strips <a> tags from list items; this restores them authoritatively)
    finalArticle.body_html = normalizeRelatedReadingSections(
        finalArticle.body_html || '',
        finalArticle.relatedArticles,
    );
    finalArticle.body_html = enforcePublishBodyRules(finalArticle.body_html || '', finalArticle);
    let publishValidation = validatePublishBodyRules(finalArticle.body_html || '');
    if (!publishValidation.valid) {
        finalArticle.body_html = enforcePublishBodyRules(finalArticle.body_html || '', {
            ...finalArticle,
            relatedArticles: finalArticle.relatedArticles || article.relatedArticles || [],
            research: finalArticle.research || article.research || {},
        });
        publishValidation = validatePublishBodyRules(finalArticle.body_html || '');
    }
    if (!publishValidation.valid) {
        const aiRepairedBody = await aiRepairPublishBody(finalArticle, publishValidation);
        if (aiRepairedBody) {
            finalArticle.body_html = enforcePublishBodyRules(aiRepairedBody, {
                ...finalArticle,
                relatedArticles: finalArticle.relatedArticles || article.relatedArticles || [],
                research: finalArticle.research || article.research || {},
            });
            publishValidation = validatePublishBodyRules(finalArticle.body_html || '');
            if (publishValidation.valid) {
                console.log('  🤖 Publish self-repair recovered validation');
            }
        }
    }
    if (!publishValidation.valid) {
        const err = new Error(`Article failed publish validation: ${JSON.stringify(publishValidation)}`);
        err.code = 'article_validation_failed';
        err.details = publishValidation;
        throw err;
    }
    const gutenbergContent = toGutenbergBlocks(finalArticle.body_html);
    console.log(`📤 Publishing draft: ${finalArticle.title}`);
    const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };

    // Upload featured image
    let featuredMediaId = 0;
    if (imageData) {
        try {
            console.log('  🖼️  Uploading featured image...');
            imageData.altText = buildImageAltText(finalArticle);
            featuredMediaId = await uploadFeaturedImage(imageData, article.title);
        } catch (err) {
            console.error('  ⚠️  Image upload failed:', err.message);
        }
    }

    // Get or create tags
    const tagIds = await getOrCreateTags(article.tags || []);

    // Select random author
    const authorId = await selectRandomAuthor();
    const categories = await getCategories();
    const selectedCategoryId = await pickCategoryId(finalArticle, categories);

    // Build post data
    const buildPostData = (includeAuthor = true) => ({
        title: finalArticle.title,
        content: gutenbergContent,
        excerpt: finalArticle.meta_description,
        status: 'draft',
        slug: finalArticle.slug,
        ...(includeAuthor ? { author: authorId } : {}),
        tags: tagIds.length ? tagIds : undefined,
        categories: selectedCategoryId ? [selectedCategoryId] : undefined,
        featured_media: featuredMediaId,
        // Yoast SEO meta fields
        meta: {
            _yoast_wpseo_title: finalArticle.seo_title || finalArticle.title,
            _yoast_wpseo_metadesc: finalArticle.meta_description,
            _yoast_wpseo_focuskw: finalArticle.focus_keyphrase || '',
        },
    });

    async function createPost(includeAuthor = true) {
        return await withRetries('WordPress post creation', async () => {
            const res = await fetch(`${WP_URL()}/wp-json/wp/v2/posts`, {
                method: 'POST',
                headers,
                body: JSON.stringify(buildPostData(includeAuthor)),
            });
            if (res.ok) {
                return await res.json();
            }

            const errorText = await res.text();
            let errorCode = '';
            try {
                const parsed = JSON.parse(errorText);
                errorCode = parsed?.code || '';
            } catch {
                // non-JSON WP error body
            }
            const err = new Error(`Post creation failed (${res.status}): ${errorText}`);
            err.status = res.status;
            err.code = errorCode;
            err.retryable = isRetryableWordPressError(err);
            throw err;
        });
    }

    let post;
    try {
        post = await createPost(true);
    } catch (err) {
        if (err.status === 403 && err.code === 'rest_cannot_edit_others') {
            console.warn('  ⚠️  Cannot publish as selected author. Retrying as authenticated user...');
            post = await createPost(false);
        } else {
            err.retryable = isRetryableWordPressError(err);
            throw err;
        }
    }

    console.log(`  ✅ Draft created: ${post.link}`);

    try {
        await syncYoastMeta(post.id, {
            focuskw: finalArticle.focus_keyphrase || '',
            title: finalArticle.seo_title || finalArticle.title,
            metadesc: finalArticle.meta_description,
        });
    } catch (err) {
        console.warn(`  ⚠️  Yoast sync endpoint failed for post ${post.id}: ${err.message}`);
    }

    let archive = null;
    try {
        archive = await archiveSourceImages({
            articleTitle: finalArticle.title,
            sourceImageUrls: Array.isArray(article.images) ? article.images : [],
            metadata: Array.isArray(imageData?.candidates) ? imageData.candidates : [],
        });
    } catch (err) {
        console.warn(`  ⚠️  Image archival failed for post ${post.id}: ${err.message}`);
    }

    return {
        id: post.id,
        title: post.title?.rendered || article.title,
        link: post.link,
        editLink: `${WP_URL()}/wp-admin/post.php?post=${post.id}&action=edit`,
        status: post.status,
        categoryId: selectedCategoryId,
        qaIssues: finalArticle.issues || [],
        archive,
    };
}

export async function backfillDraftSeoMeta({ limit } = {}) {
    const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };
    const perPage = 100;
    let page = 1;
    let totalPages = 1;
    const drafts = [];

    while (page <= totalPages) {
        const listRes = await fetch(
            `${WP_URL()}/wp-json/wp/v2/posts?status=draft&context=edit&per_page=${perPage}&page=${page}&_fields=id,title,excerpt,content,meta,status`,
            { headers: getAuthHeaders() }
        );

        if (!listRes.ok) {
            const errorText = await listRes.text();
            throw new Error(`Failed to load drafts (${listRes.status}): ${errorText}`);
        }

        totalPages = Number(listRes.headers.get('x-wp-totalpages') || '1');
        const pagePosts = await listRes.json();
        drafts.push(...pagePosts);
        page += 1;
    }

    const targetDrafts = typeof limit === 'number' && limit > 0 ? drafts.slice(0, limit) : drafts;
    const results = [];

    for (const post of targetDrafts) {
        const before = {
            keyphrase: post?.meta?._yoast_wpseo_focuskw || post?.meta?.yoast_wpseo_focuskw || '',
            metaDescription: post?.meta?._yoast_wpseo_metadesc || post?.meta?.yoast_wpseo_metadesc || '',
        };

        const normalized = normalizeYoastFromPost(post);
        try {
            await syncYoastMeta(post.id, {
                focuskw: normalized.focusKeyphrase,
                title: normalized.title,
                metadesc: normalized.metaDescription,
            });

            const updateRes = await fetch(`${WP_URL()}/wp-json/wp/v2/posts/${post.id}?context=edit`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ excerpt: normalized.metaDescription }),
            });
            if (!updateRes.ok) {
                const errorText = await updateRes.text();
                throw new Error(`Excerpt update failed (${updateRes.status}): ${errorText}`);
            }

            const status = await getYoastStatus(post.id);
            const after = {
                keyphrase: status?.stored_meta?.focuskw || normalized.focusKeyphrase,
                metaDescription: status?.stored_meta?.metadesc || normalized.metaDescription,
            };

            results.push({
                id: post.id,
                title: post?.title?.raw || post?.title?.rendered || '',
                status: 'updated',
                before,
                after,
                verification: {
                    focuskw_ok: Boolean(status?.focuskw_ok),
                    metadesc_ok: Boolean(status?.metadesc_ok),
                    yoast_indexable_seen: Boolean(status?.yoast_indexable_seen),
                },
                editLink: `${WP_URL()}/wp-admin/post.php?post=${post.id}&action=edit`,
            });
        } catch (err) {
            results.push({
                id: post.id,
                title: post?.title?.raw || post?.title?.rendered || '',
                status: 'failed',
                error: err.message,
            });
        }
    }

    const updatedCount = results.filter(r => r.status === 'updated').length;
    const failedCount = results.filter(r => r.status === 'failed').length;

    return {
        totalDraftsFound: drafts.length,
        processed: targetDrafts.length,
        updatedCount,
        failedCount,
        results,
    };
}

import fetch from 'node-fetch';
import FormData from 'form-data';

const WP_URL = () => process.env.WP_URL || 'https://barna.news';

function getAuthHeaders() {
    if (!process.env.WP_USER || !process.env.WP_APP_PASSWORD) {
        throw new Error('WordPress credentials missing. Set WP_USER and WP_APP_PASSWORD in your environment.');
    }
    const auth = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
    return { 'Authorization': `Basic ${auth}` };
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
    const form = new FormData();
    const filename = title.replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 50) + '.jpg';

    form.append('file', imageData.buffer, {
        filename,
        contentType: imageData.mimeType,
        knownLength: imageData.buffer.length,
    });
    form.append('title', title);
    form.append('alt_text', title);

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
        throw new Error(`Media upload failed (${res.status}): ${errorText}`);
    }

    const media = await res.json();
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
    console.log(`📤 Publishing draft: ${article.title}`);
    const headers = { ...getAuthHeaders(), 'Content-Type': 'application/json' };

    // Upload featured image
    let featuredMediaId = 0;
    if (imageData) {
        try {
            console.log('  🖼️  Uploading featured image...');
            featuredMediaId = await uploadFeaturedImage(imageData, article.title);
        } catch (err) {
            console.error('  ⚠️  Image upload failed:', err.message);
        }
    }

    // Get or create tags
    const tagIds = await getOrCreateTags(article.tags || []);

    // Select random author
    const authorId = await selectRandomAuthor();

    // Build post data
    const buildPostData = (includeAuthor = true) => ({
        title: article.title,
        content: article.body_html,
        excerpt: article.meta_description,
        status: 'draft',
        slug: article.slug,
        ...(includeAuthor ? { author: authorId } : {}),
        tags: tagIds,
        featured_media: featuredMediaId,
        // Yoast SEO meta fields
        meta: {
            _yoast_wpseo_title: article.title,
            _yoast_wpseo_metadesc: article.meta_description,
            _yoast_wpseo_focuskw: article.focus_keyphrase || '',
        },
    });

    async function createPost(includeAuthor = true) {
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
        throw err;
    }

    let post;
    try {
        post = await createPost(true);
    } catch (err) {
        if (err.status === 403 && err.code === 'rest_cannot_edit_others') {
            console.warn('  ⚠️  Cannot publish as selected author. Retrying as authenticated user...');
            post = await createPost(false);
        } else {
            throw err;
        }
    }

    console.log(`  ✅ Draft created: ${post.link}`);

    return {
        id: post.id,
        title: post.title?.rendered || article.title,
        link: post.link,
        editLink: `${WP_URL()}/wp-admin/post.php?post=${post.id}&action=edit`,
        status: post.status,
    };
}

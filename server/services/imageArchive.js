import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

const ARCHIVE_ROOT = process.env.SOURCE_IMAGE_ARCHIVE_ROOT
    || path.resolve(process.cwd(), 'data/source-image-archive');

function sanitizePathSegment(value = '', fallback = 'untitled') {
    const clean = String(value)
        .replace(/\u2014/g, '-')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean || fallback;
}

function toDateParts(date = new Date()) {
    const d = new Date(date);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return { yyyy, mm, dd };
}

function guessExtension(url = '', contentType = '') {
    const fromUrl = String(url).match(/\.([a-zA-Z0-9]{2,5})(?:$|\?)/)?.[1]?.toLowerCase();
    if (fromUrl) return fromUrl;
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif')) return 'gif';
    return 'jpg';
}

async function downloadBinary(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'image/*',
        },
        timeout: 15000,
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
}

export async function archiveSourceImages({ articleTitle = '', sourceImageUrls = [], date = new Date(), metadata = [] } = {}) {
    const urls = Array.from(new Set((sourceImageUrls || []).filter(Boolean)));
    if (urls.length === 0) {
        return { archivedCount: 0, archiveDir: null, manifestPath: null, files: [] };
    }

    const { yyyy, mm, dd } = toDateParts(date);
    const articleDir = sanitizePathSegment(articleTitle, 'untitled-article');
    const archiveDir = path.join(ARCHIVE_ROOT, yyyy, mm, dd, articleDir, 'IMAGES');
    await fs.mkdir(archiveDir, { recursive: true });

    const files = [];
    for (let i = 0; i < urls.length; i += 1) {
        const url = urls[i];
        try {
            const { buffer, contentType } = await downloadBinary(url);
            const extension = guessExtension(url, contentType);
            const fileName = `${String(i + 1).padStart(2, '0')}.${extension}`;
            const absolutePath = path.join(archiveDir, fileName);
            await fs.writeFile(absolutePath, buffer);

            const metaMatch = metadata.find(item => item?.originalUrl === url) || {};
            files.push({
                url,
                fileName,
                absolutePath,
                relevanceScore: Number.isFinite(metaMatch?.relevanceScore) ? metaMatch.relevanceScore : null,
                selected: Boolean(metaMatch?.selected),
            });
        } catch (err) {
            files.push({ url, error: err.message });
        }
    }

    const manifestPath = path.join(archiveDir, 'images.json');
    await fs.writeFile(manifestPath, JSON.stringify({
        articleTitle,
        archiveDir,
        createdAt: new Date().toISOString(),
        files,
    }, null, 2));

    return {
        archivedCount: files.filter(file => !file.error).length,
        archiveDir,
        manifestPath,
        files,
    };
}

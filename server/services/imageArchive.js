import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ARCHIVE_ROOT = process.env.GDRIVE_IMAGE_ARCHIVE_ROOT
    || '/Users/m4owen/Library/CloudStorage/GoogleDrive-gunn0r@gmail.com/Shared drives/01.Player Clothing Team Drive/02. RetroShell/13. Articles and Data/10. Post Content';

const ARCHIVE_PROFILE = process.env.GDRIVE_ARCHIVE_PROFILE || 'Default';

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
    const monthName = MONTH_NAMES[d.getMonth()];
    const monthDir = `${mm}. ${monthName}`;
    return { yyyy, mm, dd, monthDir };
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
        return { archivedCount: 0, archiveDir: null, files: [] };
    }

    const { yyyy, dd, monthDir } = toDateParts(date);
    const headline = sanitizePathSegment(articleTitle, 'untitled-article');
    const archiveDir = path.join(ARCHIVE_ROOT, ARCHIVE_PROFILE, yyyy, monthDir, dd, headline);

    try {
        await fs.mkdir(archiveDir, { recursive: true });
    } catch (err) {
        console.warn(`  ⚠️  Could not create archive directory ${archiveDir}: ${err.message}`);
        return { archivedCount: 0, archiveDir, files: [] };
    }

    const files = [];
    for (let i = 0; i < urls.length; i += 1) {
        const url = urls[i];
        try {
            const { buffer, contentType } = await downloadBinary(url);
            const extension = guessExtension(url, contentType);
            const fileName = `Image${i + 1}.${extension}`;
            const absolutePath = path.join(archiveDir, fileName);
            await fs.writeFile(absolutePath, buffer);

            files.push({ url, fileName, absolutePath });
        } catch (err) {
            files.push({ url, error: err.message });
        }
    }

    const archivedCount = files.filter(f => !f.error).length;
    if (archivedCount > 0) {
        console.log(`  📁 Archived ${archivedCount} image(s) → ${archiveDir}`);
    }

    return { archivedCount, archiveDir, files };
}

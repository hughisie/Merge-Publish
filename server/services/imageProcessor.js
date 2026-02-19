import fetch from 'node-fetch';
import sharp from 'sharp';

/**
 * Download an image from a URL and return the buffer.
 */
async function downloadImage(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'image/*',
        },
        timeout: 15000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Detect if an image has banner-like strips at top or bottom.
 * A banner is detected if a strip is:
 * - Less than 15% of total height
 * - Has very low color variance (solid or near-solid color)
 */
async function detectBanners(imageBuffer) {
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    if (!width || !height) return { top: 0, bottom: 0 };

    const stripHeight = Math.floor(height * 0.12);
    if (stripHeight < 10) return { top: 0, bottom: 0 };

    let topCrop = 0;
    let bottomCrop = 0;

    // Check top strip
    try {
        const topStrip = await sharp(imageBuffer)
            .extract({ left: 0, top: 0, width, height: stripHeight })
            .stats();
        // If all channels have very low standard deviation, it's likely a banner
        const avgStdDev = topStrip.channels.reduce((sum, ch) => sum + ch.stdev, 0) / topStrip.channels.length;
        if (avgStdDev < 15) {
            topCrop = stripHeight;
        }
    } catch (e) { /* ignore */ }

    // Check bottom strip
    try {
        const bottomStrip = await sharp(imageBuffer)
            .extract({ left: 0, top: height - stripHeight, width, height: stripHeight })
            .stats();
        const avgStdDev = bottomStrip.channels.reduce((sum, ch) => sum + ch.stdev, 0) / bottomStrip.channels.length;
        if (avgStdDev < 15) {
            bottomCrop = stripHeight;
        }
    } catch (e) { /* ignore */ }

    return { top: topCrop, bottom: bottomCrop };
}

/**
 * Process a list of image URLs:
 * - Download each image
 * - Detect and crop banners
 * - Convert to optimized JPEG
 * - Return the best image (largest, best aspect ratio)
 */
export async function processImages(imageUrls, { scoreImage } = {}) {
    if (!imageUrls || imageUrls.length === 0) return null;

    const processed = [];

    for (const url of imageUrls) {
        try {
            const buffer = await downloadImage(url);
            const metadata = await sharp(buffer).metadata();

            // Skip tiny images or icons
            if (metadata.width < 400 || metadata.height < 200) continue;

            // Detect banners
            const banners = await detectBanners(buffer);

            // Crop if banners detected
            let processedBuffer;
            const cropTop = banners.top;
            const cropBottom = banners.bottom;
            const newHeight = metadata.height - cropTop - cropBottom;

            if (newHeight < 200) {
                // Banner detection was too aggressive, use original
                processedBuffer = buffer;
            } else if (cropTop > 0 || cropBottom > 0) {
                processedBuffer = await sharp(buffer)
                    .extract({
                        left: 0,
                        top: cropTop,
                        width: metadata.width,
                        height: newHeight,
                    })
                    .jpeg({ quality: 85 })
                    .toBuffer();
                console.log(`  ✂️  Cropped banners: top=${cropTop}px, bottom=${cropBottom}px`);
            } else {
                processedBuffer = await sharp(buffer)
                    .jpeg({ quality: 85 })
                    .toBuffer();
            }

            const finalMeta = await sharp(processedBuffer).metadata();
            const aspectRatio = finalMeta.width / finalMeta.height;

            processed.push({
                buffer: processedBuffer,
                width: finalMeta.width,
                height: finalMeta.height,
                aspectRatio,
                originalUrl: url,
                mimeType: 'image/jpeg',
            });
        } catch (err) {
            console.warn(`  ⚠️  Failed to process image ${url}: ${err.message}`);
        }
    }

    if (processed.length === 0) return null;

    // Prefer landscape images with good resolution
    const technicalRank = (image) => {
        const idealRatio = 16 / 9;
        const ratioPenalty = Math.abs(image.aspectRatio - idealRatio);
        const area = image.width * image.height;
        return area - (ratioPenalty * 100000);
    };

    processed.forEach(image => {
        image.technicalScore = technicalRank(image);
        image.relevanceScore = null;
    });

    if (typeof scoreImage === 'function') {
        for (const image of processed) {
            try {
                const score = await scoreImage(image);
                image.relevanceScore = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
            } catch (err) {
                console.warn(`  ⚠️  Failed to score image relevance ${image.originalUrl}: ${err.message}`);
            }
        }
    }

    processed.sort((a, b) => {
        const aScore = Number.isFinite(a.relevanceScore) ? a.relevanceScore : -1;
        const bScore = Number.isFinite(b.relevanceScore) ? b.relevanceScore : -1;
        if (aScore !== bScore) return bScore - aScore;
        return b.technicalScore - a.technicalScore;
    });

    const selected = processed[0];
    selected.candidates = processed.map(candidate => ({
        originalUrl: candidate.originalUrl,
        width: candidate.width,
        height: candidate.height,
        aspectRatio: candidate.aspectRatio,
        technicalScore: candidate.technicalScore,
        relevanceScore: candidate.relevanceScore,
        selected: candidate.originalUrl === selected.originalUrl,
    }));

    return selected;
}

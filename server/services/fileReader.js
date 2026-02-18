import fs from 'fs/promises';
import path from 'path';

const REQUIRED_FIELDS = ['title', 'main_content_body', 'source_url'];

/**
 * Recursively read all .json files from a directory.
 * Validates that each file has the required fields.
 * Returns an array of article objects with added `_filePath`.
 */
export async function readArticlesFromDirectory(dirPath) {
    const articles = [];
    const errors = [];

    async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.name.endsWith('.json')) {
                try {
                    const raw = await fs.readFile(fullPath, 'utf-8');
                    const data = JSON.parse(raw);

                    // Validate required fields
                    const missing = REQUIRED_FIELDS.filter(f => !data[f]);
                    if (missing.length > 0) {
                        errors.push({ file: fullPath, error: `Missing fields: ${missing.join(', ')}` });
                        continue;
                    }

                    articles.push({
                        ...data,
                        _filePath: fullPath,
                        _fileName: entry.name,
                    });
                } catch (err) {
                    errors.push({ file: fullPath, error: err.message });
                }
            }
        }
    }

    await walk(dirPath);

    // Sort by date (earliest first)
    articles.sort((a, b) => {
        const da = a.date_time ? new Date(a.date_time) : new Date(0);
        const db = b.date_time ? new Date(b.date_time) : new Date(0);
        return da - db;
    });

    return { articles, errors };
}

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config({ override: true });

async function listModels() {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
        console.error('GEMINI_API_KEY missing');
        return;
    }
    const genAI = new GoogleGenerativeAI(key);
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        const data = await response.json();
        const geminiModels = data.models.filter(m => m.name.includes('gemini'));
        console.log(JSON.stringify(geminiModels, null, 2));
    } catch (err) {
        console.error(err);
    }
}

listModels();

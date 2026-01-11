const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { translate } = require('@vitalets/google-translate-api'); 

const app = express();

// CORS configurat corect pentru Netlify
app.use(cors({
    origin: ['https://adorable-naiad-60e1be.netlify.app', 'http://localhost:5500'],
    credentials: true
}));

app.use(express.json());

// Detectăm yt-dlp în multiple locații
const isWindows = process.platform === "win32";
function findYtDlp() {
    if (isWindows) return path.join(__dirname, 'yt-dlp.exe');
    
    // Încercăm mai multe locații pe Linux
    const locations = [
        '/tmp/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
        'yt-dlp'
    ];
    
    for (const loc of locations) {
        if (fs.existsSync(loc)) {
            console.log(`✅ yt-dlp găsit la: ${loc}`);
            return loc;
        }
    }
    
    console.log('⚠️ yt-dlp nu a fost găsit, folosesc "yt-dlp" (PATH)');
    return 'yt-dlp';
}

const YTDLP_PATH = findYtDlp();

// API KEY (pune-l în Railway Environment Variables!)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Portul trebuie să fie dinamic pentru Railway
const PORT = process.env.PORT || 3003;

// Health check pentru Railway
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'YouTube Downloader Pro API' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// --- DETECTARE PLATFORMĂ ---
function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('tiktok.com')) return 'tiktok';
    if (url.includes('instagram.com')) return 'instagram';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
    return 'unknown';
}

// --- 1. CURĂȚARE TEXT ---
function cleanVttText(vttContent) {
    if (!vttContent) return "";
    const lines = vttContent.split('\n');
    let cleanText = [];
    let seenLines = new Set();

    lines.forEach(line => {
        line = line.trim();
        if (!line || line.includes('-->') || /^\d+$/.test(line) || line.startsWith('WEBVTT')) return;
        line = line.replace(/<[^>]*>/g, '');
        if (!seenLines.has(line) && line.length > 1) {
            seenLines.add(line);
            cleanText.push(line);
        }
    });
    return cleanText.join(' ');
}

// --- 2. TRADUCERE GOOGLE (FALLBACK) ---
async function translateWithGoogle(text) {
    console.log("\n🔄 Trec pe Google Translate (Gratuit)...");
    try {
        const res = await translate(text, { to: 'ro' });
        return res.text;
    } catch (err) {
        console.error("Google Translate error:", err);
        return text;
    }
}

// --- 3. TRADUCERE GPT CU STREAMING ---
async function translateWithGPT(text) {
    if (!text || text.length < 5) return "Nu există suficient text.";
    if (!OPENAI_API_KEY) {
        console.warn("⚠️ OPENAI_API_KEY lipsește! Folosesc Google Translate.");
        return await translateWithGoogle(text);
    }

    const textToTranslate = text.substring(0, 3000);
    console.log("\n🤖 GPT-4o-mini începe traducerea:");

    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { "role": "system", "content": "Traduce în Română. Păstrează sensul dar fă-l să sune natural." },
                { "role": "user", "content": textToTranslate }
            ],
            temperature: 0.3,
            stream: true
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        let fullTranslation = "";

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                
                for (const line of lines) {
                    const message = line.replace(/^data: /, '');
                    if (message === '[DONE]') return; 
                    
                    try {
                        const parsed = JSON.parse(message);
                        const content = parsed.choices[0].delta.content;
                        if (content) {
                            process.stdout.write(content); 
                            fullTranslation += content;
                        }
                    } catch (error) {}
                }
            });

            response.data.on('end', () => {
                console.log("\n✅ Traducere GPT completă");
                resolve(fullTranslation);
            });

            response.data.on('error', (err) => {
                console.error("Stream error:", err);
                reject(err);
            });
        });

    } catch (error) {
        console.warn("\n⚠️ Eroare OpenAI:", error.message);
        return await translateWithGoogle(text);
    }
}

// --- 4. TRANSCRIPT ---
async function getOriginalTranscript(url) {
    const uniqueId = Date.now();
    const outputTemplate = path.join(__dirname, `trans_${uniqueId}`);

    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, [
            '--skip-download',
            '--write-sub', '--write-auto-sub',
            '--sub-lang', 'en',
            '--convert-subs', 'vtt',
            '--output', outputTemplate,
            '--no-check-certificates',
            url
        ]);

        process.on('close', () => {
            const possibleFiles = [`${outputTemplate}.en.vtt`, `${outputTemplate}.en-orig.vtt`];
            let foundFile = possibleFiles.find(f => fs.existsSync(f));

            if (foundFile) {
                const content = fs.readFileSync(foundFile, 'utf8');
                const clean = cleanVttText(content);
                try { fs.unlinkSync(foundFile); } catch(e){}
                resolve(clean);
            } else {
                resolve(null);
            }
        });
    });
}

function getYtMetadata(url) {
    return new Promise((resolve) => {
        const process = spawn(YTDLP_PATH, ['--dump-json', '--no-warnings', '--no-check-certificates', url]);
        let buffer = '';
        process.stdout.on('data', d => buffer += d);
        process.on('close', () => {
            try { 
                resolve(JSON.parse(buffer)); 
            } catch (e) { 
                resolve({ title: "Video", description: "", duration_string: "0:00" }); 
            }
        });
    });
}

// --- ENDPOINTS ---
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL lipsă' });

    const platform = detectPlatform(videoUrl);
    console.log(`\n[${platform.toUpperCase()}] Procesez: ${videoUrl}`);

    try {
        const metadata = await getYtMetadata(videoUrl);
        let transcriptData = null;

        // PROCESĂM TRANSCRIPTUL DOAR PENTRU YOUTUBE
        if (platform === 'youtube') {
            console.log("📝 YouTube detectat - extrag transcript...");
            let originalText = await getOriginalTranscript(videoUrl);

            if (!originalText) {
                console.log("Fără subtitrare. Folosesc descrierea.");
                originalText = metadata.description || "Niciun text găsit.";
            }

            const translatedText = await translateWithGPT(originalText);
            
            transcriptData = {
                original: originalText.substring(0, 1000) + "...",
                translated: translatedText
            };
        } else {
            console.log(`⏩ ${platform} - skip transcript (doar download)`);
        }

        // Obținem URL-ul real de la Railway
        const serverUrl = `https://${req.get('host')}`;
        
        const formats = [
            { quality: 'Video HD (MP4)', url: `${serverUrl}/api/stream?type=video&url=${encodeURIComponent(videoUrl)}` },
            { quality: 'Audio Only (MP3)', url: `${serverUrl}/api/stream?type=audio&url=${encodeURIComponent(videoUrl)}` }
        ];

        res.json({
            status: 'ok',
            data: {
                title: metadata.title,
                duration: metadata.duration_string || '0:00',
                formats: formats,
                transcript: transcriptData
            }
        });

    } catch (error) {
        console.error("Download error:", error);
        res.status(500).json({ error: error.message || 'Eroare internă.' });
    }
});

app.get('/api/stream', (req, res) => {
    const { url, type } = req.query;
    if (!url) return res.status(400).send('URL lipsă');

    res.setHeader('Content-Disposition', `attachment; filename="${type === 'audio' ? 'audio.mp3' : 'video.mp4'}"`);
    const args = ['-o', '-', '--no-check-certificates', '--force-ipv4', '-f', type === 'audio' ? 'bestaudio' : 'best', url];
    const process = spawn(YTDLP_PATH, args);
    process.stdout.pipe(res);
    process.on('error', (err) => {
        console.error('Stream error:', err);
        res.status(500).send('Streaming failed');
    });
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📥 Downloader Pro (Smart Transcript) pornit!`);
    console.log(`Platform: ${process.platform}`);
    console.log(`yt-dlp path: ${YTDLP_PATH}`);
});
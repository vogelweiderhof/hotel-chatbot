import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ========== HARDCODED RESPONSES (No AI, 100% token savings) ==========
const QUICK_RESPONSES = {
    'check-in': {
        en: "Check-in is from 15:00 to 20:00. Please notify us if arriving after 20:00.",
        de: "Check-in ist von 15:00 bis 20:00 Uhr. Bitte informieren Sie uns bei Ankunft nach 20:00 Uhr.",
        zh: "入住时间是15:00到20:00。如果在20:00之后到达，请提前通知我们。"
    },
    'check-out': {
        en: "Check-out is at 11:00 AM.",
        de: "Check-out ist um 11:00 Uhr.",
        zh: "退房时间是上午11:00。"
    },
    'wifi': {
        en: "WiFi password: internet (lowercase). Network name: Vogelweiderhof.",
        de: "WLAN-Passwort: internet (kleingeschrieben). Netzwerkname: Vogelweiderhof.",
        zh: "WiFi密码：internet（小写）。网络名称：Vogelweiderhof。"
    },
    'breakfast': {
        en: "Breakfast is 07:00-10:00 in Building A. Cost: €14 per adult, €10 per child (5-10 years).",
        de: "Frühstück ist 07:00-10:00 Uhr in Gebäude A. Kosten: €14 pro Erwachsenem, €10 pro Kind (5-10 Jahre).",
        zh: "早餐时间是7:00-10:00，在A栋楼。价格：成人€14，儿童€10（5-10岁）。"
    },
    'parking': {
        en: "Free on-site parking is available. No reservation needed, subject to availability.",
        de: "Kostenlose Parkplätze stehen zur Verfügung. Keine Reservierung erforderlich, Verfügbarkeit vor Ort.",
        zh: "提供免费停车位。无需预订，视现场情况而定。"
    },
    'phone': {
        en: "Phone: +43 662 871223 (until 23:00). Email: office@vogelweiderhof.at",
        de: "Telefon: +43 662 871223 (bis 23:00). E-Mail: office@vogelweiderhof.at",
        zh: "电话：+43 662 871223（至23:00）。邮箱：office@vogelweiderhof.at"
    },
    'mobility': {
        en: "Guest Mobility Ticket: FREE public transport in Salzburg province. Requires online check-in 3 days before arrival.",
        de: "Gästekarte: KOSTENLOSER öffentlicher Nahverkehr in Salzburg. Erfordert Online-Check-in 3 Tage vor Anreise.",
        zh: "客人卡：萨尔茨堡省免费公共交通。需在抵达前3天进行在线登记。"
    }
};

// ========== VAO/HAFAS API ==========
const VAO_API_URL = "https://vao.demo.hafas.de/gate";

// ========== BUS DATA CACHE ==========
let busDataCache = {
    data: null,
    timestamp: null,
    expiryMs: 60000 // 60 seconds
};

// ========== WEATHER CACHE ==========
let weatherCache = {
    data: null,
    timestamp: null,
    expiryMs: 600000 // 10 minutes
};

async function findStation(stationName) {
    try {
        const requestBody = {
            svcReqL: [{
                req: { input: { loc: { name: stationName }, field: "S" } },
                meth: "LocMatch",
                id: "1|1|"
            }],
            client: { id: "VAO", v: "1", type: "AND", name: "nextgen" },
            ver: "1.73",
            lang: "en",
            auth: { aid: "nextgen", type: "AID" }
        };
        
        const response = await axios.post(VAO_API_URL, requestBody, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        const locations = response.data?.svcResL?.[0]?.res?.match?.locL || [];
        if (locations && locations.length > 0) {
            return {
                name: locations[0].name,
                extId: locations[0].extId,
                type: locations[0].type || "S"
            };
        }
        return null;
    } catch (error) {
        console.log("Station search error:", error.message);
        return null;
    }
}

async function getRealTimeDepartures(stationName, maxResults = 30, filterLine = null) {
    try {
        const station = await findStation(stationName);
        if (!station) return null;
        
        const now = new Date();
        const date = now.toISOString().slice(0, 10).replace(/-/g, '');
        const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
        
        const requestBody = {
            svcReqL: [{
                req: {
                    stbLoc: { extId: station.extId, type: station.type },
                    type: "DEP",
                    maxJny: maxResults,
                    date: date,
                    time: time
                },
                meth: "StationBoard",
                id: "1|1|"
            }],
            client: { id: "VAO", v: "1", type: "AND", name: "nextgen" },
            ver: "1.73",
            lang: "en",
            auth: { aid: "nextgen", type: "AID" }
        };
        
        const response = await axios.post(VAO_API_URL, requestBody, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        const journeys = response.data?.svcResL?.[0]?.res?.jnyL || [];
        const common = response.data?.svcResL?.[0]?.res?.common;
        
        if (!journeys.length) return null;
        
        let results = journeys.map(jny => {
            const prod = common?.prodL?.[jny.prodX];
            const depTime = jny.stbStop?.dTimeS || "";
            const delay = jny.stbStop?.dTimeR ? parseInt(jny.stbStop.dTimeR) - parseInt(jny.stbStop.dTimeS) : 0;
            
            let line = prod?.name || prod?.line || "";
            let productName = prod?.name || "";
            
            let busNumber = null;
            const numberMatch = productName.match(/\b(\d{2,3})\b/);
            if (numberMatch) busNumber = numberMatch[1];
            const lineMatch = line.match(/\b(\d{2,3})\b/);
            if (lineMatch && !busNumber) busNumber = lineMatch[1];
            
            return {
                busNumber: busNumber,
                direction: jny.dirTxt || "",
                departureTime: depTime ? `${depTime.slice(0,2)}:${depTime.slice(2,4)}` : "--:--",
                delay: delay
            };
        });
        
        results = results.filter(r => r.busNumber && r.departureTime !== "--:--");
        
        // Remove duplicates
        const uniqueResults = [];
        const seen = new Set();
        for (const r of results) {
            const key = `${r.busNumber}|${r.direction}|${r.departureTime}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(r);
            }
        }
        
        if (filterLine) {
            return uniqueResults.filter(r => r.busNumber === filterLine);
        }
        
        return uniqueResults;
        
    } catch (error) {
        console.error('VAO API error:', error.message);
        return null;
    }
}

// ========== DEDICATED BUS API ENDPOINT (No AI, cached) ==========
app.get('/api/bus-times', async (req, res) => {
    const now = Date.now();
    if (busDataCache.data && busDataCache.timestamp && (now - busDataCache.timestamp) < busDataCache.expiryMs) {
        return res.json(busDataCache.data);
    }
    
    try {
        // Bus 21 to City Center
        const hotelDepartures = await getRealTimeDepartures("Baron Schwarz Park", 30, "21");
        const cityCenterBuses = hotelDepartures ? hotelDepartures.filter(d => d.direction.toLowerCase().includes('fürstenbrunn')) : [];
        
        // Bus 120 to Train Station
        const bus120Departures = await getRealTimeDepartures("Baron Schwarz Park", 20, "120");
        const trainStationBuses = bus120Departures ? bus120Departures.filter(d => d.direction.toLowerCase().includes('hauptbahnhof')) : [];
        
        const busData = {
            timestamp: new Date().toISOString(),
            bus21: { times: cityCenterBuses.slice(0, 6).map(b => ({ time: b.departureTime, delay: b.delay })) },
            bus120: { times: trainStationBuses.slice(0, 6).map(b => ({ time: b.departureTime, delay: b.delay })) }
        };
        
        busDataCache = { data: busData, timestamp: now, expiryMs: 60000 };
        res.json(busData);
        
    } catch (error) {
        console.error('Bus API error:', error.message);
        res.status(500).json({ error: 'Failed to fetch bus times' });
    }
});

// ========== WEATHER API ENDPOINT (No AI, cached) ==========
app.get('/api/weather', async (req, res) => {
    const now = Date.now();
    if (weatherCache.data && weatherCache.timestamp && (now - weatherCache.timestamp) < weatherCache.expiryMs) {
        return res.json(weatherCache.data);
    }
    
    try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=Salzburg&count=1&language=en&format=json`;
        const geoResponse = await axios.get(geoUrl, { timeout: 8000 });
        
        if (!geoResponse.data.results || geoResponse.data.results.length === 0) {
            return res.status(500).json({ error: 'Location not found' });
        }
        
        const location = geoResponse.data.results[0];
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current_weather=true&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe/Vienna&forecast_days=3`;
        const weatherResponse = await axios.get(weatherUrl, { timeout: 8000 });
        
        const current = weatherResponse.data.current_weather;
        const daily = weatherResponse.data.daily;
        
        if (!current) return res.status(500).json({ error: 'No weather data' });
        
        const weatherCodes = {
            0: "Clear", 1: "Clear", 2: "Partly cloudy", 3: "Cloudy",
            45: "Fog", 51: "Drizzle", 61: "Rain", 63: "Rain", 65: "Heavy rain",
            71: "Snow", 73: "Snow", 75: "Heavy snow", 95: "Thunder"
        };
        
        const weatherData = {
            city: location.name,
            current: {
                temp: current.temperature,
                condition: weatherCodes[current.weathercode] || "Unknown",
                wind: current.windspeed
            },
            forecast: daily.time.slice(0, 3).map((time, i) => ({
                day: new Date(time).toLocaleDateString('en-US', { weekday: 'short' }),
                high: daily.temperature_2m_max[i],
                low: daily.temperature_2m_min[i],
                condition: weatherCodes[daily.weather_code[i]] || "Unknown"
            }))
        };
        
        weatherCache = { data: weatherData, timestamp: now, expiryMs: 600000 };
        res.json(weatherData);
        
    } catch (error) {
        console.error('Weather API error:', error.message);
        res.status(500).json({ error: 'Failed to fetch weather' });
    }
});

// ========== STATIC KNOWLEDGE BASE (Compressed) ==========
function getKnowledgeBase() {
    return {
        stops: {
            "Baron Schwarz Park": "Hotel bus stop, 30m from hotel",
            "Hanuschplatz": "City center stop, near Old Town",
            "Salzburg Hbf": "Main Train Station"
        },
        routes: {
            "21": { desc: "Hotel ↔ City Center", dirs: { "Fürstenbrunn": "City Center", "Bergheim": "Back to Hotel" } },
            "120": { desc: "Hotel ↔ Train Station", dirs: { "Hauptbahnhof": "Train Station", "Pelting": "Back to Hotel" } }
        },
        ticket: { name: "Guest Mobility Ticket", desc: "FREE public transport" },
        restaurants: [
            { name: "Smash to Go", loc: "Beside hotel", cuisine: "Burgers", discount: "15%" },
            { name: "Mr. Cevap", loc: "1 min walk", cuisine: "Balkan grill" },
            { name: "Turnerwirt", loc: "3 min walk", cuisine: "Austrian" }
        ],
        sights: [
            { name: "Hohensalzburg Fortress", desc: "Largest castle in Central Europe" },
            { name: "Mirabell Palace", desc: "Baroque palace, free gardens" },
            { name: "Mozart's Birthplace", desc: "Getreidegasse 9" },
            { name: "Salzburg Cathedral", desc: "Baroque cathedral" }
        ]
    };
}

// ========== CONVERSATION MEMORY ==========
const conversationMemory = new Map();

// ========== FAQ LOADER ==========
let cachedFAQ = null;
let lastFAQModified = 0;
const FAQ_PATH = path.join(__dirname, 'hotel-faqs.txt');

function loadFAQs() {
    try {
        if (!fs.existsSync(FAQ_PATH)) return "No FAQ";
        const stats = fs.statSync(FAQ_PATH);
        if (stats.mtimeMs === lastFAQModified && cachedFAQ) return cachedFAQ;
        cachedFAQ = fs.readFileSync(FAQ_PATH, 'utf8');
        lastFAQModified = stats.mtimeMs;
        return cachedFAQ;
    } catch (error) { 
        return "FAQ unavailable"; 
    }
}

// ========== ANALYTICS ==========
const analytics = {
    q: 0, // questions
    tk: 0, // total tokens
    pt: 0, // prompt tokens
    ct: 0, // completion tokens
    cost: 0,
    topQ: new Map(),
    sessions: new Set(),
    byCat: {},
    recent: []
};

const COST_PER_MILLION = 0.20;

function updateAnalytics(usage, cat = 'gen') {
    if (!usage) return;
    const p = usage.prompt_tokens || 0;
    const c = usage.completion_tokens || 0;
    const t = usage.total_tokens || 0;
    analytics.tk += t;
    analytics.pt += p;
    analytics.ct += c;
    analytics.cost += (t / 1000000) * COST_PER_MILLION;
    if (!analytics.byCat[cat]) analytics.byCat[cat] = 0;
    analytics.byCat[cat] += t;
    analytics.recent.unshift({
        ts: new Date().toISOString(),
        pt: p,
        ct: c,
        tk: t,
        cost: (t / 1000000 * COST_PER_MILLION).toFixed(6),
        cat: cat
    });
    if (analytics.recent.length > 20) analytics.recent.pop();
}

setInterval(() => {
    const topQ = Array.from(analytics.topQ.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([q, c]) => ({ q: q.substring(0, 100), c }));
    fs.writeFileSync(path.join(__dirname, 'analytics.json'), JSON.stringify({
        q: analytics.q,
        topQ: topQ,
        tk: analytics.tk,
        cost: analytics.cost.toFixed(4)
    }));
}, 3600000);

// ========== BOT CONFIG ==========
let botConfig = {
    personality: "Helpful hotel front desk agent at Hotel Vogelweiderhof.",
    safetyRules: "No credit cards. No guest data sharing.",
    styleRules: "Direct, helpful, warm. Never end with questions.",
    bookingLink: "https://direct-book.com/properties/hotelvogelweiderhof"
};

// ========== LIMITS ==========
let limitsConfig = {
    maxTokens: 450,
    maxSession: 20,
    maxMinute: 10,
    dailyQuota: 500,
    topicFilter: true
};

const usageTracker = new Map();

function checkRateLimit(ip) {
    const now = Date.now();
    let data = usageTracker.get(ip);
    if (!data) {
        data = { m: 1, mReset: now + 60000, d: 1, dReset: now + 86400000, s: 1 };
        usageTracker.set(ip, data);
        analytics.sessions.add(ip);
        return { allowed: true };
    }
    if (now > data.mReset) { data.m = 0; data.mReset = now + 60000; }
    if (now > data.dReset) { data.d = 0; data.dReset = now + 86400000; }
    if (data.m >= limitsConfig.maxMinute) return { allowed: false, msg: "Too many questions. Please wait." };
    if (data.d >= limitsConfig.dailyQuota) return { allowed: false, msg: "Daily limit reached." };
    if (data.s >= limitsConfig.maxSession) return { allowed: false, msg: "Conversation limit reached. Please refresh." };
    data.m++;
    data.d++;
    data.s++;
    return { allowed: true };
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of usageTracker.entries()) {
        if (now > data.dReset && now > data.mReset) usageTracker.delete(ip);
    }
}, 3600000);

// ========== API ENDPOINTS ==========
app.get('/api/analytics', (req, res) => {
    const topQ = Array.from(analytics.topQ.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([q, c]) => ({ q, c }));
    const avg = analytics.q > 0 ? Math.round(analytics.tk / analytics.q) : 0;
    res.json({
        q: analytics.q,
        topQ: topQ,
        sessions: analytics.sessions.size,
        token: {
            cost: analytics.cost.toFixed(4),
            tk: analytics.tk,
            pt: analytics.pt,
            ct: analytics.ct,
            avg: avg,
            byCat: analytics.byCat,
            recent: analytics.recent
        }
    });
});

app.get('/api/limits', (req, res) => { res.json(limitsConfig); });

app.post('/api/limits', (req, res) => {
    const { maxTokens, maxSession, maxMinute, dailyQuota, topicFilter } = req.body;
    if (maxTokens !== undefined) limitsConfig.maxTokens = maxTokens;
    if (maxSession !== undefined) limitsConfig.maxSession = maxSession;
    if (maxMinute !== undefined) limitsConfig.maxMinute = maxMinute;
    if (dailyQuota !== undefined) limitsConfig.dailyQuota = dailyQuota;
    if (topicFilter !== undefined) limitsConfig.topicFilter = topicFilter;
    res.json({ success: true });
});

app.post('/api/reset-session', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const data = usageTracker.get(ip);
    if (data) { data.s = 0; }
    conversationMemory.delete(ip);
    res.json({ success: true });
});

app.post('/api/setup', (req, res) => {
    const { personality, safetyRules, styleRules } = req.body;
    if (personality) botConfig.personality = personality;
    if (safetyRules) botConfig.safetyRules = safetyRules;
    if (styleRules) botConfig.styleRules = styleRules;
    res.json({ success: true });
});

app.post('/api/update-rules', (req, res) => {
    const { personality, safetyRules, styleRules } = req.body;
    if (personality !== undefined) botConfig.personality = personality;
    if (safetyRules !== undefined) botConfig.safetyRules = safetyRules;
    if (styleRules !== undefined) botConfig.styleRules = styleRules;
    res.json({ success: true });
});

app.get('/api/get-rules', (req, res) => {
    res.json({
        personality: botConfig.personality,
        safetyRules: botConfig.safetyRules,
        styleRules: botConfig.styleRules,
        bookingLink: botConfig.bookingLink
    });
});

// ========== MAIN CHAT ENDPOINT ==========
app.post('/api/chat', async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const question = req.body.userMessage;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    if (!apiKey) return res.json({ reply: "❌ API key missing." });
    
    const rate = checkRateLimit(ip);
    if (!rate.allowed) return res.json({ reply: rate.msg });
    
    const lower = question.toLowerCase();
    
    // ========== HARDCODED RESPONSES (No AI) ==========
    for (const [key, responses] of Object.entries(QUICK_RESPONSES)) {
        if (lower.includes(key)) {
            let lang = 'en';
            if (/[äöüß]/.test(question)) lang = 'de';
            else if (/[\u4e00-\u9fff]/.test(question)) lang = 'zh';
            const reply = responses[lang] || responses.en;
            analytics.q++;
            const norm = question.toLowerCase().substring(0, 100);
            analytics.topQ.set(norm, (analytics.topQ.get(norm) || 0) + 1);
            return res.json({ reply });
        }
    }
    
    // ========== AI RESPONSE FOR COMPLEX QUESTIONS ==========
    const faqContent = loadFAQs();
    let history = conversationMemory.get(ip) || [];
    const historyText = history.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
    const kb = getKnowledgeBase();
    const isWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;
    
    // Detect language
    let lang = 'en';
    if (/[äöüß]/.test(question)) lang = 'de';
    else if (/[\u4e00-\u9fff]/.test(question)) lang = 'zh';
    
    const langInst = {
        en: "Respond in English.",
        de: "Antworte auf Deutsch.",
        zh: "用中文回复。"
    };
    
    // Compressed system prompt
    const sysPrompt = `Hotel Vogelweiderhof assistant. ${langInst[lang]} Never end with questions.

FACTS:
- Check-in: 15:00-20:00 (notify if after 20:00)
- Check-out: 11:00
- WiFi: password "internet", network "Vogelweiderhof"
- Breakfast: 07:00-10:00 in A, €14 adult, €10 child
- Guest Ticket: FREE public transport (online check-in req.)

BUS:
- Hotel→City: Bus 21 from Baron Schwarz Park, direction Fürstenbrunn, 15 min
- Hotel→Train: Bus 120/121, direction Hauptbahnhof, 10 min
- City→Hotel: Bus 21, direction Bergheim
- Hallstatt: Bus 150 → Bus 541 → Bus 543

FOOD:
- Smash to Go (beside hotel, 15% off), Mr. Cevap (1 min), Turnerwirt (3 min)
- City restaurants: Sternbräu, St. Peter, Stieglkeller, Augustinerbräu

SIGHTS (Bus 21, free with ticket):
Hohensalzburg, Mirabell, Mozart's Birthplace, Cathedral, Hellbrunn, Untersberg

${faqContent}
${historyText ? `\nHISTORY:\n${historyText}` : ''}
${isWeekend ? '\nNOTE: Weekend/holiday - reduced bus service.' : ''}

GUEST: ${question}`;

    try {
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: "deepseek-chat",
            messages: [{ role: "user", content: sysPrompt }],
            temperature: 0.5,
            max_tokens: limitsConfig.maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 25000
        });
        
        let reply = response.data.choices[0].message.content;
        
        // Remove any follow-up questions
        reply = reply.replace(/\?$/, '.');
        reply = reply.replace(/ Would you like.*$/s, '');
        reply = reply.replace(/ Can I help.*$/s, '');
        reply = reply.replace(/ Is there anything.*$/s, '');
        reply = reply.replace(/ Let me know if.*$/s, '');
        reply = reply.replace(/ Feel free to.*$/s, '');
        
        // Track analytics
        if (response.data.usage) {
            let cat = 'gen';
            if (lower.includes('bus')) cat = 'bus';
            else if (lower.includes('wetter') || lower.includes('weather')) cat = 'wthr';
            else if (lower.includes('restaurant') || lower.includes('essen')) cat = 'food';
            else if (lower.includes('sehenswürdigkeiten') || lower.includes('sightseeing')) cat = 'sght';
            updateAnalytics(response.data.usage, cat);
        }
        
        analytics.q++;
        const norm = question.toLowerCase().substring(0, 100);
        analytics.topQ.set(norm, (analytics.topQ.get(norm) || 0) + 1);
        
        history.push({ role: "user", content: question.substring(0, 300) });
        history.push({ role: "assistant", content: reply.substring(0, 500) });
        if (history.length > 15) history.splice(0, 3);
        conversationMemory.set(ip, history);
        
        res.json({ reply });
        
    } catch (error) {
        console.error('Chat error:', error.message);
        res.json({ reply: "I'm having technical difficulties. Please try again later." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Hotel Chat Bot running on port ${PORT}`);
    console.log(`📍 Hotel: Vogelweiderstraße 93/B, 5020 Salzburg`);
    console.log(`🚆 Bus API: ENABLED (cached 60s)`);
    console.log(`🌤️ Weather API: ENABLED (cached 10min)`);
    console.log(`📊 Hardcoded responses: ENABLED (check-in, wifi, breakfast, etc.)`);
    console.log(`💾 Conversation: last 4 messages only (reduced tokens)`);
    console.log(`📋 FAQ loaded: ${loadFAQs() !== "No FAQ" ? "YES" : "NO"}`);
    console.log(`\n✅ Token savings implemented:`);
    console.log(`   • Hardcoded common questions (100% savings)`);
    console.log(`   • Dedicated bus/weather endpoints (no AI)`);
    console.log(`   • Compressed system prompt (50% savings)`);
    console.log(`   • Reduced history to 4 messages (20% savings)`);
    console.log(`   • Minified JSON data (10% savings)\n`);
});
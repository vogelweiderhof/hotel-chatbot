require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ========== HOTEL LOCATION ==========
const HOTEL_ADDRESS = "Hotel Vogelweiderhof, Vogelweiderstraße 93/B, 5020 Salzburg";
const NEAREST_BUS_STOP = "Baron Schwarz Park";

// ========== CORRECT ÖBB API (WORKS FOR ALL BUSES & TRAINS) ==========
const OEBB_API_URL = "https://vao.demo.hafas.de/gate";

function getCurrentDateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return {
        date: `${year}${month}${day}`,
        time: `${hours}${minutes}${seconds}`
    };
}

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
        
        const response = await axios.post(OEBB_API_URL, requestBody, {
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

async function getDepartures(stationName, maxDepartures = 5) {
    try {
        const station = await findStation(stationName);
        if (!station) {
            console.log(`Station "${stationName}" not found`);
            return null;
        }
        
        const { date, time } = getCurrentDateTime();
        
        const requestBody = {
            svcReqL: [{
                req: {
                    stbLoc: { extId: station.extId, type: station.type },
                    type: "DEP",
                    maxJny: maxDepartures,
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
        
        const response = await axios.post(OEBB_API_URL, requestBody, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        const journeys = response.data?.svcResL?.[0]?.res?.jnyL || [];
        const common = response.data?.svcResL?.[0]?.res?.common;
        
        if (!journeys.length) return null;
        
        return journeys.slice(0, maxDepartures).map(jny => {
            const prod = common?.prodL?.[jny.prodX];
            const depTime = jny.stbStop?.dTimeS || "";
            return {
                line: prod?.name || prod?.line || "Bus/Train",
                direction: jny.dirTxt || "",
                departureTime: depTime ? `${depTime.slice(0,2)}:${depTime.slice(2,4)}` : "--:--",
                delay: jny.stbStop?.dTimeR ? parseInt(jny.stbStop.dTimeR) - parseInt(jny.stbStop.dTimeS) : 0,
                platform: jny.stbStop?.dPltfS?.txt || ""
            };
        });
    } catch (error) {
        console.log("ÖBB API error:", error.message);
        return null;
    }
}

// ========== CONVERSATION MEMORY ==========
const conversationMemory = new Map();
const userLanguagePreference = new Map();
const userSessionStart = new Map();

// ========== FAQ CACHING ==========
let cachedFAQ = null;
let lastFAQModified = 0;
const FAQ_PATH = path.join(__dirname, 'hotel-faqs.txt');

// ========== ANALYTICS ==========
const analytics = {
    totalQuestions: 0,
    totalTokensUsed: 0,
    estimatedCostUSD: 0,
    mostAskedQuestions: new Map(),
    dailyActiveSessions: new Set(),
    startTime: Date.now()
};

const COST_PER_MILLION_TOKENS = 0.20;

function updateTokenAnalytics(usage) {
    if (!usage) return;
    const totalTokens = usage.total_tokens || 0;
    analytics.totalTokensUsed += totalTokens;
    analytics.estimatedCostUSD += (totalTokens / 1000000) * COST_PER_MILLION_TOKENS;
}

setInterval(() => {
    const topQuestions = Array.from(analytics.mostAskedQuestions.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([q, c]) => ({ question: q.substring(0, 100), count: c }));
    fs.writeFileSync(path.join(__dirname, 'analytics.json'), JSON.stringify({
        totalQuestions: analytics.totalQuestions,
        topQuestions: topQuestions,
        totalTokensUsed: analytics.totalTokensUsed,
        estimatedCostUSD: analytics.estimatedCostUSD.toFixed(4)
    }, null, 2));
}, 3600000);

// ========== BOT CONFIGURATION ==========
let botConfig = {
    personality: `You are a helpful hotel front desk agent. You understand what the guest really wants. For example, if they ask for a route, you provide the best option based on their preference (scenic vs fast).`,
    
    safetyRules: `Never ask for credit card numbers. Never share other guests' data.`,
    
    styleRules: `Use sentence case. Be direct, helpful, and warm. Never start with "Great question!". Never end responses with questions.`,
    
    websiteContent: "",
    customRules: [],
    bookingLink: "https://direct-book.com/properties/hotelvogelweiderhof",
    webSearchEnabled: true
};

// ========== LIMITS ==========
let limitsConfig = {
    maxTokensPerResponse: 450,
    maxMessagesPerSession: 20,
    maxQuestionsPerMinute: 10,
    dailyQuota: 500,
    topicFilterEnabled: true
};

const usageTracker = new Map();

function isQuestionAllowed(question) {
    if (!limitsConfig.topicFilterEnabled) return { allowed: true, reason: null };
    const lowerQuestion = question.toLowerCase();
    if (question.length < 30) return { allowed: true, reason: null };
    const blockedPatterns = /politics|election|war|sex|violence|kill|murder|weapon/i;
    if (blockedPatterns.test(lowerQuestion)) {
        return { allowed: false, reason: "I can only help with hotel and travel questions." };
    }
    return { allowed: true, reason: null };
}

function checkRateLimit(ip) {
    const now = Date.now();
    let userData = usageTracker.get(ip);
    if (!userData) {
        userData = { minuteCount: 1, minuteReset: now + 60000, dailyCount: 1, dailyReset: now + 86400000, sessionCount: 1 };
        usageTracker.set(ip, userData);
        analytics.dailyActiveSessions.add(ip);
        return { allowed: true, message: null };
    }
    if (now > userData.minuteReset) { userData.minuteCount = 0; userData.minuteReset = now + 60000; }
    if (now > userData.dailyReset) { userData.dailyCount = 0; userData.dailyReset = now + 86400000; }
    if (userData.minuteCount >= limitsConfig.maxQuestionsPerMinute) {
        return { allowed: false, message: "Too many questions. Please wait." };
    }
    if (userData.dailyCount >= limitsConfig.dailyQuota) {
        return { allowed: false, message: "Daily limit reached. Come back tomorrow." };
    }
    if (userData.sessionCount >= limitsConfig.maxMessagesPerSession) {
        return { allowed: false, message: "Conversation limit reached. Please refresh." };
    }
    userData.minuteCount++;
    userData.dailyCount++;
    userData.sessionCount++;
    usageTracker.set(ip, userData);
    return { allowed: true, message: null };
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of usageTracker.entries()) {
        if (now > data.dailyReset && now > data.minuteReset) usageTracker.delete(ip);
    }
}, 3600000);

// ========== FAQ LOADER ==========
function loadFAQs() {
    try {
        if (!fs.existsSync(FAQ_PATH)) return "No FAQ loaded";
        const stats = fs.statSync(FAQ_PATH);
        if (stats.mtimeMs === lastFAQModified && cachedFAQ) return cachedFAQ;
        cachedFAQ = fs.readFileSync(FAQ_PATH, 'utf8');
        lastFAQModified = stats.mtimeMs;
        console.log(`✅ FAQ loaded`);
        return cachedFAQ;
    } catch (error) { return "FAQ unavailable"; }
}

// ========== DETECT GUEST INTENT ==========
function detectIntent(question) {
    const lower = question.toLowerCase();
    
    if (lower.includes('hallstatt')) {
        return 'hallstatt';
    }
    if (lower.includes('königssee') || lower.includes('koenigssee')) {
        return 'koenigssee';
    }
    if (lower.includes('vienna') || lower.includes('wien')) {
        return 'vienna';
    }
    if (lower.includes('salzburg') && (lower.includes('city center') || lower.includes('altstadt'))) {
        return 'salzburg_city';
    }
    if (lower.includes('train station') || lower.includes('hauptbahnhof') || lower.includes('hbf')) {
        return 'train_station';
    }
    if (/(next|when|what time).*(bus|train|departure)/i.test(question)) {
        return 'schedule';
    }
    if (lower.includes('bus') || lower.includes('train')) {
        return 'transport';
    }
    return 'general';
}

function needsRealTimeData(question) {
    return detectIntent(question) === 'schedule';
}

// ========== LANGUAGE DETECTION ==========
function detectLanguage(text) {
    analytics.totalQuestions++;
    const normalizedQuestion = text.toLowerCase().replace(/[^\w\s]/g, '').substring(0, 100);
    analytics.mostAskedQuestions.set(normalizedQuestion, (analytics.mostAskedQuestions.get(normalizedQuestion) || 0) + 1);
    if (/[äöüß]/i.test(text)) return 'german';
    if (/[\u4e00-\u9fff]/.test(text)) return 'chinese';
    return 'english';
}

// ========== API ENDPOINTS ==========
app.get('/api/analytics', (req, res) => {
    const topQuestions = Array.from(analytics.mostAskedQuestions.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([q, c]) => ({ question: q, count: c }));
    res.json({
        totalQuestions: analytics.totalQuestions,
        topQuestions: topQuestions,
        totalTokensUsed: analytics.totalTokensUsed,
        estimatedCostUSD: analytics.estimatedCostUSD.toFixed(4),
        activeSessionsToday: analytics.dailyActiveSessions.size
    });
});

app.get('/api/limits', (req, res) => { res.json(limitsConfig); });

app.post('/api/limits', (req, res) => {
    const { maxTokensPerResponse, maxMessagesPerSession, maxQuestionsPerMinute, dailyQuota, topicFilterEnabled } = req.body;
    if (maxTokensPerResponse !== undefined) limitsConfig.maxTokensPerResponse = maxTokensPerResponse;
    if (maxMessagesPerSession !== undefined) limitsConfig.maxMessagesPerSession = maxMessagesPerSession;
    if (maxQuestionsPerMinute !== undefined) limitsConfig.maxQuestionsPerMinute = maxQuestionsPerMinute;
    if (dailyQuota !== undefined) limitsConfig.dailyQuota = dailyQuota;
    if (topicFilterEnabled !== undefined) limitsConfig.topicFilterEnabled = topicFilterEnabled;
    res.json({ success: true });
});

app.post('/api/reset-session', (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const userData = usageTracker.get(clientIp);
    if (userData) { userData.sessionCount = 0; }
    conversationMemory.delete(clientIp);
    userLanguagePreference.delete(clientIp);
    res.json({ success: true });
});

app.post('/api/setup', async (req, res) => {
    const { personality, safetyRules, styleRules } = req.body;
    if (personality) botConfig.personality = personality;
    if (safetyRules) botConfig.safetyRules = safetyRules;
    if (styleRules) botConfig.styleRules = styleRules;
    res.json({ success: true });
});

app.post('/api/update-rules', (req, res) => {
    const { personality, safetyRules, styleRules, webSearchEnabled } = req.body;
    if (personality !== undefined) botConfig.personality = personality;
    if (safetyRules !== undefined) botConfig.safetyRules = safetyRules;
    if (styleRules !== undefined) botConfig.styleRules = styleRules;
    if (webSearchEnabled !== undefined) botConfig.webSearchEnabled = webSearchEnabled;
    res.json({ success: true });
});

app.get('/api/get-rules', (req, res) => {
    res.json({
        personality: botConfig.personality,
        safetyRules: botConfig.safetyRules,
        styleRules: botConfig.styleRules,
        bookingLink: botConfig.bookingLink,
        webSearchEnabled: botConfig.webSearchEnabled
    });
});

app.post('/api/toggle-search', (req, res) => {
    botConfig.webSearchEnabled = req.body.enabled;
    res.json({ success: true });
});

// ========== MAIN CHAT ENDPOINT ==========
app.post('/api/chat', async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const userQuestion = req.body.userMessage;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    if (!apiKey) return res.json({ reply: "❌ API key missing." });
    if (!userSessionStart.has(clientIp)) userSessionStart.set(clientIp, Date.now());
    
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) return res.json({ reply: rateCheck.message });
    const topicCheck = isQuestionAllowed(userQuestion);
    if (!topicCheck.allowed) return res.json({ reply: topicCheck.reason });
    
    const faqContent = loadFAQs();
    let history = conversationMemory.get(clientIp) || [];
    const historyText = history.slice(-4).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    
    let detectedLang = userLanguagePreference.get(clientIp);
    if (!detectedLang) {
        detectedLang = detectLanguage(userQuestion);
        userLanguagePreference.set(clientIp, detectedLang);
    }
    
    const isBookingQuestion = /book|price|cost|rate|availability/i.test(userQuestion);
    const intent = detectIntent(userQuestion);
    const needsRealtime = intent === 'schedule';
    
    // Fetch real-time departures ONLY for schedule questions
    let realTimeData = "";
    if (needsRealtime) {
        const departures = await getDepartures("Salzburg Hbf", 5);
        if (departures && departures.length > 0) {
            realTimeData = "\n\n**Real-time departures from Salzburg Hbf:**\n";
            for (const dep of departures) {
                const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : "";
                realTimeData += `• ${dep.line} towards ${dep.direction} at ${dep.departureTime}${delayText}\n`;
            }
        } else {
            realTimeData = "\n\n**Real-time schedule unavailable.** Please check www.oebb.at for current departures.";
        }
    }
    
    const languageInstructions = {
        english: "RESPOND IN ENGLISH. Be direct and helpful.",
        german: "ANTWORTE AUF DEUTSCH. Seien Sie direkt und hilfreich.",
        chinese: "用中文回复。简洁直接。"
    };
    
    const systemPrompt = `You are a hotel assistant at Hotel Vogelweiderhof (Vogelweiderstraße 93/B, 5020 Salzburg).

**HOTEL FAQ (OFFICIAL INFORMATION - USE THIS FOR ALL ROUTES):**
${faqContent}

**INTENT DETECTED:** ${intent}

**SPECIFIC ROUTING INSTRUCTIONS:**

1. **HALLSTATT ROUTE (from FAQ - USE THIS):**
   - There is NO direct connection from Salzburg to Hallstatt (neither bus nor train)
   - BUS ROUTE (scenic, better views): Bus 150 → change to Bus 541 → change to Bus 543 at "Hallstatt Gosaumühle" → Bus 543 stops at "Hallstatt Lahn" (directly at the lake)
   - TRAIN ROUTE (faster): Train to Attnang-Puchheim → change to Hallstatt train → then take ferry across lake
   - Guest Mobility Ticket valid to Bad Ischl only
   - When asked "is there a direct bus/train", answer: "There is no direct connection, but..."
   - When asked about scenic vs fast, explain both options clearly

2. **KÖNIGSSEE ROUTE:**
   - No direct connection from Salzburg
   - Take train to Berchtesgaden Hbf, then bus 841 to Königssee

3. **SALZBURG CITY CENTER:**
   - From hotel: Bus 21 from Baron Schwarz Park (direction Fürstenbrunn)
   - Walking: 30-45 minutes

4. **TRAIN STATION (Salzburg Hbf):**
   - From hotel: Bus 120 or 121 from Baron Schwarz Park (direction Hauptbahnhof)

5. **REAL-TIME SCHEDULES:**
   ${realTimeData || "Use this section only if user asks for 'next train' or 'when is the next bus'"}

**CRITICAL RULES:**
- If the user asks "is there a direct bus/train to X", first say "There is no direct connection" THEN provide the best option
- For Hallstatt, explain BOTH bus (scenic) and train (faster) options
- Never say something doesn't exist if your FAQ describes it
- Never end responses with questions
- Be warm and helpful

${languageInstructions[detectedLang] || languageInstructions.english}

PREVIOUS CONVERSATION:
${historyText || "None"}

GUEST: ${userQuestion}

Remember: Understand what the guest really wants. If they ask for a route, provide the best option. If they ask about direct connections, be honest that none exist, then provide alternatives.`;

    try {
        const apiRequest = {
            model: "deepseek-chat",
            messages: [{ role: "user", content: systemPrompt }],
            temperature: 0.6,
            max_tokens: limitsConfig.maxTokensPerResponse
        };
        
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', apiRequest, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 25000
        });
        
        let reply = response.data.choices[0].message.content;
        
        if (response.data.usage) {
            updateTokenAnalytics(response.data.usage);
        }
        
        if (isBookingQuestion && !reply.includes('direct-book.com')) {
            reply += `\n\n${botConfig.bookingLink}`;
        }
        
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        
        res.json({ reply: reply });
    } catch (error) {
        console.error('Chat error:', error.message);
        res.json({ reply: "I'm having trouble right now. Please try again." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Hotel Chat Bot running on port ${PORT}`);
    console.log(`📍 Hotel: Vogelweiderstraße 93/B, 5020 Salzburg`);
    console.log(`🧠 Intent detection: ENABLED`);
    console.log(`📋 FAQ Priority: HIGH`);
    console.log(`🚆 ÖBB API: Real-time schedules only (UPDATED ENDPOINT)`);
    console.log(`🔍 Web Search: ${botConfig.webSearchEnabled ? 'ENABLED' : 'DISABLED'}\n`);
});
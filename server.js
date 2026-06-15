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

// ========== ÖBB DIRECT API CALLS ==========
const OEBB_API_URL = "https://fahrplan.oebb.at/bin/mgate.exe";

// Helper function to get current date/time in ÖBB format
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
        const { date, time } = getCurrentDateTime();
        
        const requestBody = {
            ver: "1.67",
            lang: "en",
            auth: { type: "AID", aid: "OWDL4fE4ixNiPBBm" },
            client: { id: "OEBB", type: "WEB" },
            svcReqL: [{
                req: {
                    input: { loc: { name: stationName } },
                    field: "S"
                },
                meth: "LocMatch",
                id: "1|1|1"
            }]
        };
        
        const response = await axios.post(OEBB_API_URL, requestBody, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        const locations = response.data?.svcResL?.[0]?.res?.match?.locL || [];
        if (locations.length > 0) {
            return {
                name: locations[0].name,
                extId: locations[0].extId,
                type: locations[0].type,
                x: locations[0].crd?.x,
                y: locations[0].crd?.y
            };
        }
        return null;
    } catch (error) {
        console.error('Station search error:', error.message);
        return null;
    }
}

async function getDepartures(stationName, maxDepartures = 5) {
    try {
        const station = await findStation(stationName);
        if (!station) {
            console.log(`Station not found: ${stationName}`);
            return null;
        }
        
        const { date, time } = getCurrentDateTime();
        
        const requestBody = {
            ver: "1.67",
            lang: "en",
            auth: { type: "AID", aid: "OWDL4fE4ixNiPBBm" },
            client: { id: "OEBB", type: "WEB" },
            svcReqL: [{
                req: {
                    stbLoc: { type: station.type, extId: station.extId },
                    type: "DEP",
                    maxJny: maxDepartures,
                    date: date,
                    time: time
                },
                meth: "StationBoard",
                id: "1|1|1"
            }]
        };
        
        const response = await axios.post(OEBB_API_URL, requestBody, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        const journeys = response.data?.svcResL?.[0]?.res?.jnyL || [];
        const common = response.data?.svcResL?.[0]?.res?.common;
        
        if (journeys.length === 0) return null;
        
        return journeys.slice(0, maxDepartures).map(jny => {
            const prod = common?.prodL?.[jny.prodX];
            return {
                line: prod?.name || prod?.prodCtx?.name || "Bus/Train",
                direction: jny.dirTxt || "",
                departureTime: jny.stbStop?.dTimeS?.slice(0, 2) + ":" + jny.stbStop?.dTimeS?.slice(2, 4),
                platform: jny.stbStop?.dPlatfS?.txt || jny.stbStop?.dPlatfR?.txt || "",
                delay: jny.stbStop?.dTimeR ? parseInt(jny.stbStop.dTimeR) - parseInt(jny.stbStop.dTimeS) : 0
            };
        });
    } catch (error) {
        console.error('Departures error:', error.message);
        return null;
    }
}

async function getJourney(fromStation, toStation) {
    try {
        const from = await findStation(fromStation);
        const to = await findStation(toStation);
        
        if (!from || !to) {
            console.log(`Could not find stations: ${fromStation} -> ${toStation}`);
            return null;
        }
        
        const { date, time } = getCurrentDateTime();
        
        const requestBody = {
            ver: "1.67",
            lang: "en",
            auth: { type: "AID", aid: "OWDL4fE4ixNiPBBm" },
            client: { id: "OEBB", type: "WEB" },
            svcReqL: [{
                req: {
                    depLoc: { type: from.type, extId: from.extId },
                    arrLoc: { type: to.type, extId: to.extId },
                    date: date,
                    time: time,
                    searchForArrival: false,
                    numF: 3
                },
                meth: "TripSearch",
                id: "1|1|1"
            }]
        };
        
        const response = await axios.post(OEBB_API_URL, requestBody, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        const connections = response.data?.svcResL?.[0]?.res?.outConL || [];
        if (connections.length === 0) return null;
        
        const conn = connections[0];
        const common = response.data.svcResL[0].res.common;
        
        // Parse duration (format: HHMMSS in seconds)
        const durationSec = parseInt(conn.dur);
        const durationHours = Math.floor(durationSec / 3600);
        const durationMins = Math.floor((durationSec % 3600) / 60);
        
        // Build leg information
        const legs = [];
        for (const section of conn.secL || []) {
            if (section.type === "JNY" && section.jny) {
                const prod = common?.prodL?.[section.jny.prodX];
                const direction = common?.dirL?.[section.jny.dirX]?.txt;
                legs.push({
                    line: prod?.name || prod?.prodCtx?.name || "Train",
                    direction: direction || "",
                    from: common?.locL?.[section.jny.dep?.locX]?.name,
                    to: common?.locL?.[section.jny.arr?.locX]?.name,
                    departureTime: section.jny.dep?.dTimeS?.slice(0, 2) + ":" + section.jny.dep?.dTimeS?.slice(2, 4),
                    arrivalTime: section.jny.arr?.aTimeS?.slice(0, 2) + ":" + section.jny.arr?.aTimeS?.slice(2, 4),
                    departurePlatform: section.jny.dep?.dPltfS?.txt || section.jny.dep?.dPltfR?.txt,
                    arrivalPlatform: section.jny.arr?.aPltfS?.txt || section.jny.arr?.aPltfR?.txt
                });
            }
        }
        
        return {
            from: common?.locL?.[conn.dep?.locX]?.name || fromStation,
            to: common?.locL?.[conn.arr?.locX]?.name || toStation,
            departureTime: conn.dep?.dTimeS?.slice(0, 2) + ":" + conn.dep?.dTimeS?.slice(2, 4),
            arrivalTime: conn.arr?.aTimeS?.slice(0, 2) + ":" + conn.arr?.aTimeS?.slice(2, 4),
            duration: `${durationHours}h ${durationMins}m`,
            changes: conn.chg || 0,
            legs: legs
        };
    } catch (error) {
        console.error('Journey error:', error.message);
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
    personality: `You are a helpful hotel front desk agent. Answer questions directly. Be concise. Never start with "Great question!". Never end responses with questions.`,
    
    safetyRules: `Never ask for credit card numbers. Never share other guests' data.`,
    
    styleRules: `Use sentence case. Be direct and helpful.`,
    
    websiteContent: "",
    customRules: [],
    bookingLink: "https://direct-book.com/properties/hotelvogelweiderhof",
    webSearchEnabled: true
};

// ========== LIMITS ==========
let limitsConfig = {
    maxTokensPerResponse: 300,
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

// ========== CHECK IF QUESTION NEEDS REAL-TIME DATA ==========
function needsRealTimeData(question) {
    const realTimePatterns = [
        /next (bus|train|departure|connection)/i,
        /when (does|is|will) (the|a) (bus|train)/i,
        /what time (does|is) (the|a) (bus|train)/i,
        /current (bus|train) (schedule|time|departure)/i,
        /fahrplan/i,
        /abfahrt/i,
        /live/i,
        /schedule/i,
        /departure/i
    ];
    return realTimePatterns.some(pattern => pattern.test(question));
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
    const needsRealtime = needsRealTimeData(userQuestion);
    
    // Detect destination for routing
    const destinationMatch = userQuestion.match(/(to|from|towards|for)\s+([A-Za-z\s]+)/i);
    let destination = destinationMatch ? destinationMatch[2].trim() : null;
    if (!destination && (userQuestion.includes("Königssee") || userQuestion.includes("Hallstatt") || userQuestion.includes("Vienna") || userQuestion.includes("Salzburg"))) {
        destination = userQuestion.match(/(Königssee|Hallstatt|Vienna|Wien|Salzburg|Berchtesgaden)/i)?.[0];
    }
    
    // Fetch real-time data if needed
    let realTimeData = "";
    let journeyData = "";
    
    if (needsRealtime) {
        console.log('🚆 Fetching real-time departures...');
        const departures = await getDepartures("Salzburg Hbf", 5);
        if (departures && departures.length > 0) {
            realTimeData = "\n\n**Real-time departures from Salzburg Hbf:**\n";
            for (const dep of departures) {
                const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : "";
                realTimeData += `• ${dep.line} towards ${dep.direction} at ${dep.departureTime}${delayText}\n`;
            }
        } else {
            realTimeData = "\n\n*Real-time data temporarily unavailable. Please check oebb.at for current schedules.*";
        }
    }
    
    // Fetch journey if destination detected
    if (destination) {
        console.log(`🚆 Fetching journey from Salzburg Hbf to ${destination}...`);
        const journey = await getJourney("Salzburg Hbf", destination);
        if (journey) {
            journeyData = `\n\n**Connection from Salzburg Hbf to ${destination}:**\n`;
            journeyData += `• Departure: ${journey.departureTime}\n`;
            journeyData += `• Arrival: ${journey.arrivalTime}\n`;
            journeyData += `• Duration: ${journey.duration}\n`;
            journeyData += `• Changes: ${journey.changes}\n`;
            if (journey.legs.length > 0) {
                journeyData += `• Route: ${journey.legs.map(l => `${l.line} ${l.direction ? `(${l.direction})` : ''}`).join(' → ')}\n`;
            }
        } else {
            journeyData = `\n\n*Could not find a connection to ${destination}. Please check the destination name or use oebb.at for routing.*`;
        }
    }
    
    const languageInstructions = {
        english: "RESPOND IN ENGLISH. Be concise and direct.",
        german: "ANTWORTE AUF DEUTSCH. Seien Sie direkt und hilfreich.",
        chinese: "用中文回复。简洁直接。"
    };
    
    const systemPrompt = `You are a hotel assistant at Hotel Vogelweiderhof (Vogelweiderstraße 93/B, 5020 Salzburg).

${realTimeData ? `**LIVE SCHEDULES (use this for schedule questions):**${realTimeData}` : ''}
${journeyData ? `**ROUTING INFORMATION (use this for directions):**${journeyData}` : ''}

**BUS ROUTES FROM HOTEL FAQ (use for which bus to take):**
- Bus 21 goes to City Center (direction Fürstenbrunn). Bus 21 does NOT go to train station.
- Bus 120 and 121 go to train station (direction Hauptbahnhof).
- Nearest stop: "Baron Schwarz Park", 30 meters from hotel.

**HALLSTATT ROUTE:**
- From hotel: Bus 120/121 to Salzburg Hbf → Train to Attnang-Puchheim → Train to Hallstatt (2.5-3 hours)

${languageInstructions[detectedLang] || languageInstructions.english}

PREVIOUS CONVERSATION:
${historyText || "None"}

GUEST: ${userQuestion}

Answer concisely. Use the live schedule data for "next train" questions. Never end responses with questions.`;

    try {
        const apiRequest = {
            model: "deepseek-chat",
            messages: [{ role: "user", content: systemPrompt }],
            temperature: 0.5,
            max_tokens: 350
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
        res.json({ reply: "I'm having trouble connecting to the schedule service. Please check oebb.at for current train times." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Hotel Chat Bot running on port ${PORT}`);
    console.log(`📍 Hotel: Vogelweiderstraße 93/B, 5020 Salzburg`);
    console.log(`🚆 ÖBB API: Direct integration (no external package)`);
    console.log(`🔍 Web Search: ${botConfig.webSearchEnabled ? 'ENABLED' : 'DISABLED'}\n`);
});
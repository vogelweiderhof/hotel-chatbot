require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ÖBB API Integration
let oebb = null;
try {
    oebb = require('oebb-api');
    console.log('✅ ÖBB API loaded');
} catch (error) {
    console.log('⚠️ ÖBB API not available');
}

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

// ========== ÖBB FUNCTIONS ==========
const stationCache = new Map();

async function getStationId(stationName) {
    if (!oebb) return null;
    if (stationCache.has(stationName)) return stationCache.get(stationName);
    try {
        const stations = await oebb.searchStationsNew(stationName);
        if (stations && stations.length > 0) {
            stationCache.set(stationName, stations[0]);
            return stations[0];
        }
    } catch (error) { return null; }
    return null;
}

async function getRealTimeDepartures(stationName) {
    if (!oebb) return null;
    try {
        const station = await getStationId(stationName);
        if (!station) return null;
        const options = oebb.getStationBoardDataOptions();
        options.evaId = station.number;
        options.maxJourneys = 5;
        const departures = await oebb.getStationBoardData(options);
        return departures;
    } catch (error) {
        console.error('Departures error:', error.message);
        return null;
    }
}

async function getJourney(fromStation, toStation) {
    if (!oebb) return null;
    try {
        const from = await getStationId(fromStation);
        const to = await getStationId(toStation);
        if (!from || !to) return null;
        const journeys = await oebb.getJourneys(from, to, false, new Date());
        if (journeys && journeys.connections && journeys.connections.length > 0) {
            return journeys.connections[0];
        }
    } catch (error) { return null; }
    return null;
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
    personality: `You are a helpful hotel front desk agent. You have access to three sources of information in this order:
1. FAQ (highest priority - this is your hotel's official information)
2. ÖBB API (real-time transport data - trains, buses, schedules)
3. Web Search (weather, events, general information)

When answering:
- ALWAYS check the FAQ first. If the answer is there, use it.
- If the FAQ doesn't have the answer and it's about transport (bus/train times, routes), use the ÖBB data.
- If it's about weather, events, or local attractions, use web search.
- Be concise and direct. Never start with "Great question!".
- Never end responses with questions.`,
    
    safetyRules: `Never ask for credit card numbers. Never share other guests' data.`,
    
    styleRules: `Use sentence case. Never use bold for passwords. Be direct and helpful.`,
    
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

// ========== FUNCTION TO CHECK IF ANSWER EXISTS IN FAQ ==========
function findAnswerInFAQ(question, faqContent) {
    const lowerQuestion = question.toLowerCase();
    const faqLines = faqContent.split('\n');
    
    for (const line of faqLines) {
        if (line.includes('|') && !line.startsWith('#')) {
            const [faqQuestion, faqAnswer] = line.split('|').map(s => s.trim());
            if (lowerQuestion.includes(faqQuestion.toLowerCase()) || faqQuestion.toLowerCase().includes(lowerQuestion)) {
                return { found: true, answer: faqAnswer };
            }
        }
    }
    return { found: false, answer: null };
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
    const historyText = history.slice(-6).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    
    let detectedLang = userLanguagePreference.get(clientIp);
    if (!detectedLang) {
        detectedLang = detectLanguage(userQuestion);
        userLanguagePreference.set(clientIp, detectedLang);
    }
    
    const isBookingQuestion = /book|price|cost|rate|availability/i.test(userQuestion);
    const isTransportQuestion = /bus|train|tram|bahn|fahrplan|departure|abfahrt|when|what time|how to get|directions|route|hallstatt|salzburg/i.test(userQuestion);
    const isWeatherQuestion = /weather|wetter|temp|temperature|rain|sunny|clouds/i.test(userQuestion);
    
    // STEP 1: Try to find answer in FAQ first
    const faqMatch = findAnswerInFAQ(userQuestion, faqContent);
    
    let oebbData = "";
    let webSearchData = "";
    
    // STEP 2: If FAQ didn't have answer and it's a transport question, check ÖBB
    if (!faqMatch.found && isTransportQuestion && oebb) {
        console.log('🔍 FAQ had no answer - checking ÖBB API');
        
        // Check for real-time departures
        const departures = await getRealTimeDepartures("Salzburg Baron Schwarz Park");
        if (departures && departures.journey && departures.journey.length > 0) {
            oebbData = "\n\n**Real-time departures from Baron Schwarz Park (nearest stop):**\n";
            for (let i = 0; i < Math.min(3, departures.journey.length); i++) {
                const journey = departures.journey[i];
                const delay = journey.rt?.dlm ? ` (${journey.rt.dlm} min delay)` : "";
                oebbData += `• ${journey.pr} towards ${journey.st} at ${journey.ti}${delay}\n`;
            }
        }
        
        // Check for Hallstatt journey
        if (userQuestion.toLowerCase().includes('hallstatt')) {
            const journey = await getJourney("Salzburg Hbf", "Hallstatt");
            if (journey && journey.sections && journey.sections[0]) {
                const section = journey.sections[0];
                const duration = journey.duration ? Math.round(journey.duration / 60000) : "?";
                oebbData += `\n\n**Current ÖBB train connection from Salzburg Hbf to Hallstatt:**\n• ${section.category?.name || 'Train'} ${section.category?.number || ''}\n• Departure: ${section.from?.departure?.substring(11, 16) || 'check schedule'}\n• Duration: about ${duration} minutes\n• At Hallstatt station, take the ferry across the lake.`;
            }
        }
    }
    
    // STEP 3: Use web search for weather or general info
    if (isWeatherQuestion && botConfig.webSearchEnabled) {
        webSearchData = "\n\nUse web search to find current weather information for Salzburg.";
    }
    
    const priorityInfo = [];
    if (faqMatch.found) {
        priorityInfo.push(`**FROM HOTEL FAQ (official - use this):**\n${faqMatch.answer}`);
    }
    if (oebbData) {
        priorityInfo.push(`**FROM ÖBB API (real-time data):**${oebbData}`);
    }
    
    const languageInstructions = {
        english: "RESPOND IN ENGLISH. Be concise and direct.",
        german: "ANTWORTE AUF DEUTSCH. Seien Sie direkt und hilfreich.",
        chinese: "用中文回复。简洁直接。"
    };
    
    const systemPrompt = `You are a hotel assistant at Hotel Vogelweiderhof (Vogelweiderstraße 93/B, 5020 Salzburg).

**INFORMATION PRIORITY (use in this order):**
1. FIRST - Use the "FROM HOTEL FAQ" section if present. This is your hotel's official, correct information.
2. SECOND - If no FAQ answer and the question is about transport, use the ÖBB data.
3. THIRD - For weather, use web search.

${priorityInfo.length > 0 ? priorityInfo.join('\n') : 'No FAQ match found for this question. Use ÖBB data for transport or web search for weather.'}

${languageInstructions[detectedLang] || languageInstructions.english}

PREVIOUS CONVERSATION:
${historyText || "None"}

COMPLETE FAQ FOR REFERENCE (use only if FAQ match above is insufficient):
${faqContent.substring(0, 2000)}

GUEST: ${userQuestion}

INSTRUCTIONS:
- If the FAQ had an answer (shown above), use it. Do not override it with other sources.
- For bus routes: Bus 21 goes to city center. Bus 120/121 go to train station. This is from your hotel's FAQ.
- Be concise. Never start with "Great question!". Never end with questions.`;

    try {
        const apiRequest = {
            model: "deepseek-chat",
            messages: [{ role: "user", content: systemPrompt }],
            temperature: 0.5,
            max_tokens: limitsConfig.maxTokensPerResponse
        };
        
        // Enable web search only for weather questions
        if (botConfig.webSearchEnabled && isWeatherQuestion) {
            apiRequest.search_enabled = true;
        }
        
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', apiRequest, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 30000
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
        if (history.length > 12) history.splice(0, 2);
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
    console.log(`📋 Priority: FAQ → ÖBB API → Web Search`);
    console.log(`🚍 ÖBB Transport: ${oebb ? 'ENABLED' : 'Disabled'}`);
    console.log(`🔍 Web Search: ${botConfig.webSearchEnabled ? 'ENABLED' : 'Disabled'}\n`);
});
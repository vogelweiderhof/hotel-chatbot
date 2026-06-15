require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ÖBB API Integration (optional)
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
const HOTEL_ADDRESS = "Hotel Vogelweiderhof, Vogelweiderstraße 93/B, 5020 Salzburg, Austria";
const HOTEL_STATION = "Salzburg Vogelweiderstraße";

const stationCache = new Map();

// ========== ÖBB FUNCTIONS ==========
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

function isPublicTransportQuestion(question) {
    return /bus|train|tram|sbahn|s-bahn|ubahn|u-bahn|bahn|station|haltestelle|fahrplan|how to get|public transport|oebb|öbb/i.test(question);
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
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    estimatedCostUSD: 0,
    questionsByLanguage: { english: 0, german: 0, spanish: 0, french: 0, italian: 0, chinese: 0 },
    questionsByCategory: { hotel: 0, transport: 0, local: 0, booking: 0, conversation: 0, other: 0 },
    mostAskedQuestions: new Map(),
    tokenUsageByCategory: { hotel: 0, transport: 0, local: 0, booking: 0, conversation: 0, other: 0 },
    webSearchUsage: 0,
    blockedQuestions: 0,
    dailyActiveSessions: new Set(),
    startTime: Date.now(),
    tokenHistory: []
};

const COST_PER_MILLION_TOKENS = 0.20;

function updateTokenAnalytics(usage, category) {
    if (!usage) return;
    const totalTokens = usage.total_tokens || 0;
    analytics.totalTokensUsed += totalTokens;
    analytics.totalPromptTokens += usage.prompt_tokens || 0;
    analytics.totalCompletionTokens += usage.completion_tokens || 0;
    if (category && analytics.tokenUsageByCategory[category] !== undefined) {
        analytics.tokenUsageByCategory[category] += totalTokens;
    }
    const cost = (totalTokens / 1000000) * COST_PER_MILLION_TOKENS;
    analytics.estimatedCostUSD += cost;
    analytics.tokenHistory.push({ timestamp: new Date().toISOString(), totalTokens, category, cost: cost.toFixed(6) });
    if (analytics.tokenHistory.length > 100) analytics.tokenHistory.shift();
}

function getTokenAnalyticsSummary() {
    return {
        totalTokens: analytics.totalTokensUsed,
        estimatedCostUSD: analytics.estimatedCostUSD.toFixed(4),
        averageTokensPerQuestion: analytics.totalQuestions > 0 ? (analytics.totalTokensUsed / analytics.totalQuestions).toFixed(0) : 0,
        tokenUsageByCategory: analytics.tokenUsageByCategory
    };
}

setInterval(() => {
    const topQuestions = Array.from(analytics.mostAskedQuestions.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([q, c]) => ({ question: q.substring(0, 100), count: c }));
    fs.writeFileSync(path.join(__dirname, 'analytics.json'), JSON.stringify({
        totalQuestions: analytics.totalQuestions,
        questionsByLanguage: analytics.questionsByLanguage,
        questionsByCategory: analytics.questionsByCategory,
        topQuestions: topQuestions,
        tokenAnalytics: getTokenAnalyticsSummary()
    }, null, 2));
}, 3600000);

// ========== BOT CONFIGURATION (Fixed - No repetition, no ending questions) ==========
let botConfig = {
    personality: `You are a friendly, efficient hotel front desk agent. Answer questions directly and conversationally. Be helpful and warm, but don't use repetitive phrases like "Great question!" or "That's a wonderful question!" - just answer naturally. Never start responses with the same phrase repeatedly. Vary your language. Be concise but friendly. Use occasional emojis (😊) but no more than one per message. Never end your response with a question - make statements, not questions.`,
    
    safetyRules: `Never ask for credit card numbers or passwords. Redirect to secure booking engine for payments. Never share other guests' data. Block abusive language with one neutral warning.`,
    
    styleRules: `Use sentence case only. Never use ALL CAPS. Break text into short lines. NEVER use bold for passwords. Write dates as "24 May, 2026". Show prices with € symbol. Use at most one emoji per message. Never end responses with a question mark. End with periods. Be direct but friendly.`,
    
    websiteContent: "",
    customRules: [],
    bookingLink: "https://direct-book.com/properties/hotelvogelweiderhof",
    webSearchEnabled: true
};

// ========== LIMITS ==========
let limitsConfig = {
    maxTokensPerResponse: 200,
    maxMessagesPerSession: 20,
    maxQuestionsPerMinute: 10,
    dailyQuota: 500,
    topicFilterEnabled: true
};

const usageTracker = new Map();

// ========== PERMISSIVE TOPIC FILTER ==========
function isQuestionAllowed(question, conversationHistory) {
    if (!limitsConfig.topicFilterEnabled) return { allowed: true, reason: null };
    
    const lowerQuestion = question.toLowerCase();
    
    // ALWAYS allow short questions (under 30 chars) - these are likely follow-ups
    if (question.length < 30) {
        return { allowed: true, reason: null };
    }
    
    // ALWAYS allow conversational follow-ups
    const conversationalPatterns = [
        /^(just|only|really|so|ok|thanks|thank you|great|perfect|got it|i see|ah|oh|yes|no|yeah|sure|right|wait|one more|actually)$/i,
        /(just|only|really)\?$/,
        /is that (all|it|correct|right)/i,
        /so that'?s it/i,
        /that'?s all/i,
        /what about/i,
        /how about/i,
        /and what/i,
        /also/i,
        /by the way/i,
        /one more thing/i
    ];
    
    for (const pattern of conversationalPatterns) {
        if (pattern.test(lowerQuestion)) {
            analytics.questionsByCategory.conversation++;
            return { allowed: true, reason: null };
        }
    }
    
    // Check if this follows a recent hotel-related question (context)
    if (conversationHistory && conversationHistory.length > 0) {
        const lastBotResponse = conversationHistory.slice(-2).find(m => m.role === 'assistant')?.content || '';
        const hotelKeywords = /wifi|internet|password|check-in|check-out|breakfast|parking|pool|room|address/;
        if (hotelKeywords.test(lastBotResponse)) {
            analytics.questionsByCategory.conversation++;
            return { allowed: true, reason: null };
        }
    }
    
    // Check against blocked topics
    const blockedPatterns = /politics|election|president|government|trump|biden|putin|ukraine|war|sex|porn|naked|violence|violent|fight|kill|murder|weapon|gun|bomb|attack/i;
    if (blockedPatterns.test(lowerQuestion)) {
        analytics.blockedQuestions++;
        return { allowed: false, reason: "I can only help with hotel and travel questions." };
    }
    
    // Check if it's hotel-related
    const hotelPatterns = /check[-\s]?in|check[-\s]?out|wifi|breakfast|parking|pool|pet|cancellation|reception|room|address|location|directions|how to get|taxi|bus|train|weather|restaurant|attraction|old town|city center|salzburg|book|price|cost/i;
    
    if (hotelPatterns.test(lowerQuestion)) {
        analytics.questionsByCategory.hotel++;
        return { allowed: true, reason: null };
    }
    
    analytics.questionsByCategory.other++;
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
    if (now > userData.dailyReset) { userData.dailyCount = 0; userData.dailyReset = now + 86400000; analytics.dailyActiveSessions.add(ip); }
    if (userData.minuteCount >= limitsConfig.maxQuestionsPerMinute) {
        return { allowed: false, message: "Too many questions. Please wait a moment." };
    }
    if (userData.dailyCount >= limitsConfig.dailyQuota) {
        return { allowed: false, message: "Daily limit reached. Please come back tomorrow." };
    }
    if (userData.sessionCount >= limitsConfig.maxMessagesPerSession) {
        return { allowed: false, message: "Conversation limit reached. Please refresh the page." };
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
        if (!fs.existsSync(FAQ_PATH)) return null;
        const stats = fs.statSync(FAQ_PATH);
        if (stats.mtimeMs === lastFAQModified && cachedFAQ) return cachedFAQ;
        const content = fs.readFileSync(FAQ_PATH, 'utf8');
        const lines = content.split('\n');
        const faqMap = {};
        for (const line of lines) {
            if (line.trim().startsWith('#') || line.trim() === '') continue;
            const pipeIndex = line.indexOf('|');
            if (pipeIndex > 0) {
                const question = line.substring(0, pipeIndex).trim().toLowerCase();
                const answer = line.substring(pipeIndex + 1).trim();
                faqMap[question] = answer;
            }
        }
        let faqText = "=== HOTEL INFORMATION ===\n\n";
        for (const [q, a] of Object.entries(faqMap)) faqText += `• ${q.toUpperCase()}: ${a}\n`;
        cachedFAQ = { faqMap, faqText, timestamp: stats.mtimeMs };
        lastFAQModified = stats.mtimeMs;
        console.log(`✅ FAQ loaded: ${Object.keys(faqMap).length} entries`);
        return cachedFAQ;
    } catch (error) { return null; }
}

// ========== LANGUAGE DETECTION ==========
function detectLanguage(text) {
    analytics.totalQuestions++;
    const normalizedQuestion = text.toLowerCase().replace(/[^\w\s]/g, '').substring(0, 100);
    analytics.mostAskedQuestions.set(normalizedQuestion, (analytics.mostAskedQuestions.get(normalizedQuestion) || 0) + 1);
    
    if (/[äöüß]/i.test(text)) { analytics.questionsByLanguage.german++; return 'german'; }
    if (/[\u4e00-\u9fff]/.test(text)) { analytics.questionsByLanguage.chinese++; return 'chinese'; }
    
    analytics.questionsByLanguage.english++;
    return 'english';
}

// ========== API ENDPOINTS ==========
app.get('/api/analytics', (req, res) => {
    const topQuestions = Array.from(analytics.mostAskedQuestions.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([q, c]) => ({ question: q, count: c }));
    res.json({
        totalQuestions: analytics.totalQuestions,
        questionsByLanguage: analytics.questionsByLanguage,
        questionsByCategory: analytics.questionsByCategory,
        topQuestions: topQuestions,
        webSearchUsage: analytics.webSearchUsage,
        blockedQuestions: analytics.blockedQuestions,
        activeSessionsToday: analytics.dailyActiveSessions.size,
        uptimeHours: ((Date.now() - analytics.startTime) / 3600000).toFixed(1),
        tokenAnalytics: getTokenAnalyticsSummary()
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
    res.json({ success: true, limits: limitsConfig });
});

app.post('/api/reset-session', (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const userData = usageTracker.get(clientIp);
    if (userData) { userData.sessionCount = 0; usageTracker.set(clientIp, userData); }
    conversationMemory.delete(clientIp);
    userLanguagePreference.delete(clientIp);
    res.json({ success: true });
});

app.post('/api/setup', async (req, res) => {
    const { websiteUrl, personality, safetyRules, styleRules } = req.body;
    if (personality) botConfig.personality = personality;
    if (safetyRules) botConfig.safetyRules = safetyRules;
    if (styleRules) botConfig.styleRules = styleRules;
    if (websiteUrl && websiteUrl !== '') {
        try {
            const response = await axios.get(websiteUrl, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const $ = cheerio.load(response.data);
            botConfig.websiteContent = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 2000);
        } catch (error) { botConfig.websiteContent = ""; }
    }
    res.json({ success: true });
});

app.post('/api/update-rules', (req, res) => {
    const { personality, safetyRules, styleRules, customRules, webSearchEnabled } = req.body;
    if (personality !== undefined) botConfig.personality = personality;
    if (safetyRules !== undefined) botConfig.safetyRules = safetyRules;
    if (styleRules !== undefined) botConfig.styleRules = styleRules;
    if (customRules !== undefined) botConfig.customRules = customRules;
    if (webSearchEnabled !== undefined) botConfig.webSearchEnabled = webSearchEnabled;
    res.json({ success: true });
});

app.get('/api/get-rules', (req, res) => {
    res.json({
        personality: botConfig.personality,
        safetyRules: botConfig.safetyRules,
        styleRules: botConfig.styleRules,
        customRules: botConfig.customRules,
        bookingLink: botConfig.bookingLink,
        webSearchEnabled: botConfig.webSearchEnabled
    });
});

app.post('/api/toggle-search', (req, res) => {
    botConfig.webSearchEnabled = req.body.enabled;
    res.json({ success: true });
});

app.post('/api/feedback', (req, res) => {
    const { rating, question, answer } = req.body;
    const logPath = path.join(__dirname, 'feedback.json');
    let feedback = [];
    if (fs.existsSync(logPath)) {
        try { feedback = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch(e) {}
    }
    feedback.push({ timestamp: new Date().toISOString(), rating, question });
    fs.writeFileSync(logPath, JSON.stringify(feedback, null, 2));
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
    
    let history = conversationMemory.get(clientIp) || [];
    const historyText = history.slice(-8).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    
    const topicCheck = isQuestionAllowed(userQuestion, history);
    if (!topicCheck.allowed) return res.json({ reply: topicCheck.reason });
    
    const faqData = loadFAQs();
    const faqText = faqData ? faqData.faqText : "";
    
    let detectedLang = userLanguagePreference.get(clientIp);
    if (!detectedLang) {
        detectedLang = detectLanguage(userQuestion);
        userLanguagePreference.set(clientIp, detectedLang);
    }
    
    const isBookingQuestion = /availability|available|book|booking|price|cost|rate/i.test(userQuestion);
    const isLocalInfoQuestion = /weather|restaurant|attraction|museum|transport|directions|how to get|taxi|bus|train|old town|city center/i.test(userQuestion);
    const questionCategory = isBookingQuestion ? 'booking' : (isLocalInfoQuestion ? 'local' : 'hotel');
    
    if (isLocalInfoQuestion && botConfig.webSearchEnabled) analytics.webSearchUsage++;
    
    // ÖBB Transport
    let transportInfo = "";
    if (isPublicTransportQuestion(userQuestion) && oebb) {
        const destinations = { "old town": "Salzburg Mirabellplatz", "altstadt": "Salzburg Mirabellplatz", "city center": "Salzburg Mirabellplatz", "hauptbahnhof": "Salzburg Hauptbahnhof", "airport": "Salzburg Airport" };
        let destination = null;
        for (const [key, value] of Object.entries(destinations)) {
            if (userQuestion.toLowerCase().includes(key)) { destination = value; break; }
        }
        if (destination) {
            const journey = await getJourney(HOTEL_STATION, destination);
            if (journey && journey.sections && journey.sections[0]) {
                const section = journey.sections[0];
                const duration = journey.duration ? Math.round(journey.duration / 60000) : "?";
                transportInfo = `\n\nReal-time from ${HOTEL_STATION} to ${destination}: ${section.category?.name || 'Bus'} ${section.category?.number || ''}, departing ${section.from?.departure?.substring(11, 16) || 'soon'}, about ${duration} minutes.`;
            }
        }
    }
    
    const languageInstructions = {
        english: "RESPOND IN ENGLISH. Be direct, warm, and conversational. Never start with repetitive phrases. Vary your language.",
        german: "ANTWORTE AUF DEUTSCH. Direkt, warm und gesprächig.",
        chinese: "用中文回复。直接、温暖、对话式。"
    };
    
    const systemPrompt = `You are a hotel assistant at Hotel Vogelweiderhof (Vogelweiderstraße 93/B, 5020 Salzburg).

PERSONALITY: Answer directly and conversationally. Never use repetitive openings like "Great question!" or "That's a wonderful question!" Just answer naturally. Vary your responses. Never end with a question - make statements.

STYLE RULES: Use sentence case. At most one emoji per message. Never use bold for passwords. End with periods, not question marks.

${languageInstructions[detectedLang] || languageInstructions.english}

${transportInfo ? `REAL-TIME TRANSPORT:${transportInfo}\n` : ""}

PREVIOUS CONVERSATION:
${historyText || "None"}

HOTEL INFO:
${faqText}

Hotel address: Vogelweiderstraße 93/B, 5020 Salzburg, Austria.

${isBookingQuestion ? `Booking link: ${botConfig.bookingLink}` : ''}

GUEST: ${userQuestion}

Remember: NO repetitive openings. NO ending with questions. Answer naturally.`;

    try {
        const apiRequest = {
            model: "deepseek-chat",
            messages: [{ role: "user", content: systemPrompt }],
            temperature: 0.7,
            max_tokens: limitsConfig.maxTokensPerResponse
        };
        if (botConfig.webSearchEnabled && isLocalInfoQuestion) apiRequest.search_enabled = true;
        
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', apiRequest, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        
        let reply = response.data.choices[0].message.content;
        
        if (response.data.usage) {
            updateTokenAnalytics(response.data.usage, questionCategory);
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
    console.log(`💬 Style: Direct, no repetitive openings, no ending questions`);
    console.log(`😊 Emojis: Max 1 per message`);
    console.log(`🚍 ÖBB Transport: ${oebb ? 'ENABLED' : 'Disabled'}\n`);
});
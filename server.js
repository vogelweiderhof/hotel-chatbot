require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ÖBB API Integration (optional - will work without it)
let oebb = null;
try {
    oebb = require('oebb-api');
    console.log('✅ ÖBB API loaded successfully');
} catch (error) {
    console.log('⚠️ ÖBB API not available - using web search for transport queries');
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

// CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ========== HOTEL LOCATION ==========
const HOTEL_ADDRESS = "Hotel Vogelweiderhof, Vogelweiderstraße 93/B, 5020 Salzburg, Austria";
const HOTEL_STATION = "Salzburg Vogelweiderstraße";

// Cache for station searches
const stationCache = new Map();

// ========== ÖBB API FUNCTIONS (with null checks) ==========
async function getStationId(stationName) {
    if (!oebb) return null;
    if (stationCache.has(stationName)) return stationCache.get(stationName);
    try {
        const stations = await oebb.searchStationsNew(stationName);
        if (stations && stations.length > 0) {
            stationCache.set(stationName, stations[0]);
            return stations[0];
        }
    } catch (error) {
        console.error('Station search error:', error.message);
    }
    return null;
}

async function getJourney(fromStation, toStation, addOffers = false) {
    if (!oebb) return null;
    try {
        const from = await getStationId(fromStation);
        const to = await getStationId(toStation);
        if (!from || !to) return null;
        const date = new Date();
        const journeys = await oebb.getJourneys(from, to, addOffers, date);
        if (journeys && journeys.connections && journeys.connections.length > 0) {
            return journeys.connections[0];
        }
    } catch (error) {
        console.error('Journey error:', error.message);
    }
    return null;
}

async function getDepartures(stationName, minutesAhead = 60) {
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
    }
    return null;
}

function isPublicTransportQuestion(question) {
    const transportKeywords = /bus|train|tram|sbahn|s-bahn|ubahn|u-bahn|bahn|station|haltestelle|fahrplan|schedule|departure|abfahrt|ankunft|arrival|verbindung|connection|wie komme ich|how to get|öffentliche verkehrsmittel|public transport|oebb|öbb/i;
    return transportKeywords.test(question);
}

// ========== CONVERSATION MEMORY ==========
const conversationMemory = new Map();
const userLanguagePreference = new Map();
const userSessionStart = new Map();

// ========== FAQ CACHING ==========
let cachedFAQ = null;
let lastFAQModified = 0;
const FAQ_PATH = path.join(__dirname, 'hotel-faqs.txt');

// ========== TOKEN & ANALYTICS TRACKING ==========
const analytics = {
    totalQuestions: 0,
    totalTokensUsed: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    estimatedCostUSD: 0,
    questionsByLanguage: { english: 0, german: 0, spanish: 0, french: 0, italian: 0, chinese: 0, dutch: 0, japanese: 0, korean: 0, other: 0 },
    questionsByCategory: { hotel: 0, transport: 0, local: 0, booking: 0, help: 0, other: 0 },
    mostAskedQuestions: new Map(),
    tokenUsageByCategory: { hotel: 0, transport: 0, local: 0, booking: 0, help: 0, other: 0 },
    webSearchUsage: 0,
    blockedQuestions: 0,
    dailyActiveSessions: new Set(),
    dailyDates: new Map(),
    startTime: Date.now(),
    tokenHistory: []
};

const COST_PER_MILLION_TOKENS = 0.20;

function updateTokenAnalytics(usage, category) {
    if (!usage) return;
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    analytics.totalTokensUsed += totalTokens;
    analytics.totalPromptTokens += promptTokens;
    analytics.totalCompletionTokens += completionTokens;
    if (category && analytics.tokenUsageByCategory[category] !== undefined) {
        analytics.tokenUsageByCategory[category] += totalTokens;
    } else {
        analytics.tokenUsageByCategory.other += totalTokens;
    }
    const cost = (totalTokens / 1000000) * COST_PER_MILLION_TOKENS;
    analytics.estimatedCostUSD += cost;
    analytics.tokenHistory.push({
        timestamp: new Date().toISOString(),
        totalTokens,
        promptTokens,
        completionTokens,
        category,
        cost: cost.toFixed(6)
    });
    if (analytics.tokenHistory.length > 100) analytics.tokenHistory.shift();
}

function getTokenAnalyticsSummary() {
    return {
        totalTokens: analytics.totalTokensUsed,
        totalPromptTokens: analytics.totalPromptTokens,
        totalCompletionTokens: analytics.totalCompletionTokens,
        estimatedCostUSD: analytics.estimatedCostUSD.toFixed(4),
        averageTokensPerQuestion: analytics.totalQuestions > 0 ? (analytics.totalTokensUsed / analytics.totalQuestions).toFixed(0) : 0,
        tokenUsageByCategory: analytics.tokenUsageByCategory,
        recentTokenUsage: analytics.tokenHistory.slice(-10)
    };
}

// Save analytics every hour
setInterval(() => {
    const topQuestions = Array.from(analytics.mostAskedQuestions.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([q, c]) => ({ question: q.substring(0, 100), count: c }));
    const tokenSummary = getTokenAnalyticsSummary();
    const stats = {
        totalQuestions: analytics.totalQuestions,
        questionsByLanguage: analytics.questionsByLanguage,
        questionsByCategory: analytics.questionsByCategory,
        topQuestions: topQuestions,
        webSearchUsage: analytics.webSearchUsage,
        blockedQuestions: analytics.blockedQuestions,
        activeSessionsToday: analytics.dailyActiveSessions.size,
        uptimeHours: ((Date.now() - analytics.startTime) / 3600000).toFixed(1),
        tokenAnalytics: tokenSummary
    };
    fs.writeFileSync(path.join(__dirname, 'analytics.json'), JSON.stringify(stats, null, 2));
}, 3600000);

// ========== CONVERSATIONAL BOT RULES ==========
let botConfig = {
    personality: `You are a friendly, warm, and conversational hotel front desk agent. Have a natural, back-and-forth conversation with guests. Be helpful but not robotic. Use casual, friendly language. Smile in your responses. Use phrases like "Of course!", "Happy to help!", "Great question!" occasionally. Keep responses concise but warm. Never be abrupt or short. Acknowledge follow-up questions naturally. If a guest asks for confirmation (like "just internet?"), respond warmly like "That's right! Just 'internet' - nice and simple." Never block or reject a follow-up question. Be conversational and helpful.`,
    
    safetyRules: `Never ask for or store full credit card numbers, CVV, or passwords. Redirect to secure booking engine for payments. Never share other guests' data. If uncertain about an answer, say so honestly. Block abusive language with one neutral warning.`,
    
    styleRules: `Use sentence case only — never ALL CAPS except for brief emphasis like "NO" in policy statements. Break text into short lines. Use bullet points for lists. **NEVER use bold for passwords, codes, or credentials.** Write dates in clear format like "24 May, 2026". Show prices with currency symbol followed by "per night" or "total." Use natural, conversational language. Be warm and friendly. Use occasional emojis sparingly (😊, 👍, 🏨). Keep responses concise but complete. Never end a conversation abruptly. Always leave the door open for follow-up questions.`,
    
    websiteContent: "",
    customRules: [],
    bookingLink: "https://direct-book.com/properties/hotelvogelweiderhof",
    webSearchEnabled: true
};

// ========== LIMITS CONFIGURATION ==========
let limitsConfig = {
    maxTokensPerResponse: 200,
    maxMessagesPerSession: 20,
    maxQuestionsPerMinute: 10,
    dailyQuota: 500,
    topicFilterEnabled: true
};

const usageTracker = new Map();

// ========== EXPANDED TOPIC FILTER ==========
const ALLOWED_TOPICS = {
    hotel: /check[-\s]?in|check[-\s]?out|wifi|breakfast|parking|pool|pet|cancellation|reception|room service|laundry|smoking|room type|bed|bathroom|amenities|address|location|street|where are you|hotel address/i,
    
    conversational: /^(just|only|really|so|ok|okay|thanks|thank you|great|perfect|got it|i see|ah|oh|hmm|yes|no|yeah|sure|right|correct|exactly)$/i,
    confirmation: /(just|only|really)\?$|is that (all|it|correct)|so that's it|that's all|nothing else/i,
    
    transport: /how to get|directions|get to|go to|way to|from hotel to|travel to|reach|taxi|bus|train|tram|subway|metro|shuttle|walk|drive|bike|public transport/i,
    
    local: /weather|restaurant|bar|cafe|attraction|museum|airport|station|city center|old town|downtown|nearby|local|sightseeing|thing to do|salzburg|vienna|what to see|what to do/i,
    
    booking: /availability|available|book|booking|price|cost|rate|how much|what.*price/i,
    
    help: /help|assist|support|what can you do|how do you work/i
};

const BLOCKED_TOPICS = {
    politics: /politics|election|president|government|trump|biden|putin|ukraine|war|military/i,
    adult: /sex|porn|naked|hookup|escort|adult/i,
    violence: /violence|violent|fight|kill|murder|weapon|gun|bomb|attack/i
};

function detectCategory(question) {
    const lowerQuestion = question.toLowerCase();
    for (const [category, pattern] of Object.entries(ALLOWED_TOPICS)) {
        if (pattern.test(lowerQuestion)) return category;
    }
    return 'other';
}

function isQuestionAllowed(question) {
    if (!limitsConfig.topicFilterEnabled) return { allowed: true, reason: null };
    const lowerQuestion = question.toLowerCase();
    
    // Always allow short confirmations and thanks
    if (lowerQuestion.match(/^(ok|okay|thanks|thank you|great|perfect|got it|i see|yes|no|yeah|sure|right)$/i)) {
        return { allowed: true, reason: null };
    }
    
    // Allow confirmation questions like "just internet?"
    if (lowerQuestion.match(/(just|only|really)\?$/)) {
        return { allowed: true, reason: null };
    }
    
    for (const [topic, pattern] of Object.entries(BLOCKED_TOPICS)) {
        if (pattern.test(lowerQuestion)) {
            analytics.blockedQuestions++;
            return { allowed: false, reason: `I'm here to help with hotel and travel questions only.` };
        }
    }
    
    let isAllowed = false;
    for (const [category, pattern] of Object.entries(ALLOWED_TOPICS)) {
        if (pattern.test(lowerQuestion)) {
            isAllowed = true;
            analytics.questionsByCategory[category]++;
            break;
        }
    }
    
    if (lowerQuestion.length < 5 && !isAllowed) {
        analytics.questionsByCategory.help++;
        return { allowed: true, reason: null };
    }
    
    if (!isAllowed) {
        analytics.questionsByCategory.other++;
        analytics.blockedQuestions++;
        return { allowed: false, reason: "I'm a hotel assistant. I can help with check-in/out times, WiFi, breakfast, local restaurants, weather, attractions, directions, and the hotel address. What would you like to know? 😊" };
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
    if (now > userData.dailyReset) { userData.dailyCount = 0; userData.dailyReset = now + 86400000; analytics.dailyActiveSessions.add(ip); }
    if (userData.minuteCount >= limitsConfig.maxQuestionsPerMinute) {
        return { allowed: false, message: "Too many questions. Please wait a moment." };
    }
    if (userData.dailyCount >= limitsConfig.dailyQuota) {
        return { allowed: false, message: "Daily question limit reached. Please come back tomorrow." };
    }
    if (userData.sessionCount >= limitsConfig.maxMessagesPerSession) {
        return { allowed: false, message: "Conversation limit reached. Please refresh the page to start a new conversation." };
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
    for (const [sessionId, timestamp] of userSessionStart.entries()) {
        if (now - timestamp > 3600000) {
            conversationMemory.delete(sessionId);
            userLanguagePreference.delete(sessionId);
            userSessionStart.delete(sessionId);
        }
    }
}, 3600000);

// ========== CACHED FAQ LOADER ==========
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

// ========== MULTI-LANGUAGE DETECTION ==========
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
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([q, c]) => ({ question: q, count: c }));
    const tokenSummary = getTokenAnalyticsSummary();
    res.json({
        totalQuestions: analytics.totalQuestions,
        questionsByLanguage: analytics.questionsByLanguage,
        questionsByCategory: analytics.questionsByCategory,
        topQuestions: topQuestions,
        webSearchUsage: analytics.webSearchUsage,
        blockedQuestions: analytics.blockedQuestions,
        activeSessionsToday: analytics.dailyActiveSessions.size,
        uptimeHours: ((Date.now() - analytics.startTime) / 3600000).toFixed(1),
        tokenAnalytics: tokenSummary
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
    feedback.push({ timestamp: new Date().toISOString(), rating, question, answer: answer?.substring(0, 200) });
    fs.writeFileSync(logPath, JSON.stringify(feedback, null, 2));
    res.json({ success: true });
});

// ========== MAIN CHAT ENDPOINT (Conversational) ==========
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
    
    const faqData = loadFAQs();
    const faqText = faqData ? faqData.faqText : "";
    
    let detectedLang = userLanguagePreference.get(clientIp);
    if (!detectedLang) {
        detectedLang = detectLanguage(userQuestion);
        userLanguagePreference.set(clientIp, detectedLang);
    }
    
    let history = conversationMemory.get(clientIp) || [];
    const historyText = history.slice(-6).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    
    const isBookingQuestion = /availability|available|book|booking|price|cost|rate/i.test(userQuestion);
    const isLocalInfoQuestion = /weather|restaurant|bar|cafe|attraction|museum|transport|directions|how to get|taxi|bus|train|old town|city center/i.test(userQuestion);
    const questionCategory = detectCategory(userQuestion);
    
    if (isLocalInfoQuestion && botConfig.webSearchEnabled) analytics.webSearchUsage++;
    
    // Check if this is a confirmation/follow-up question
    const isConfirmation = /(just|only|really)\?$|is that (all|it|correct)|so that's it|that's all/i.test(userQuestion);
    
    // ÖBB Transport Integration
    let transportInfo = "";
    if (isPublicTransportQuestion(userQuestion) && oebb) {
        const destinations = {
            "old town": "Salzburg Mirabellplatz",
            "altstadt": "Salzburg Mirabellplatz",
            "city center": "Salzburg Mirabellplatz",
            "zentrum": "Salzburg Mirabellplatz",
            "hauptbahnhof": "Salzburg Hauptbahnhof",
            "main station": "Salzburg Hauptbahnhof",
            "airport": "Salzburg Airport",
            "flughafen": "Salzburg Airport"
        };
        
        let destination = null;
        for (const [key, value] of Object.entries(destinations)) {
            if (userQuestion.toLowerCase().includes(key)) {
                destination = value;
                break;
            }
        }
        
        if (destination) {
            const journey = await getJourney(HOTEL_STATION, destination);
            if (journey && journey.sections && journey.sections[0]) {
                const section = journey.sections[0];
                const duration = journey.duration ? Math.round(journey.duration / 60000) : "?";
                transportInfo = `\n\n🚆 Real-time from ${HOTEL_STATION} to ${destination}: ${section.category?.name || 'Bus'} ${section.category?.number || ''}, departing ${section.from?.departure?.substring(11, 16) || 'soon'}, about ${duration} minutes.`;
            }
        }
    }
    
    const languageInstructions = {
        english: "RESPOND IN ENGLISH. Be warm, conversational, and friendly.",
        german: "ANTWORTE AUF DEUTSCH. Seien Sie warmherzig und gesprächig.",
        chinese: "用中文回复。保持温暖、对话式、友好。"
    };
    
    const systemPrompt = `You are a warm, conversational hotel assistant at Hotel Vogelweiderhof.

PERSONALITY: ${botConfig.personality}

SAFETY: ${botConfig.safetyRules}

STYLE: ${botConfig.styleRules}

${languageInstructions[detectedLang] || languageInstructions.english}

${isConfirmation ? "This is a follow-up/confirmation question. Respond warmly and conversationally. For example, if they ask 'just internet?', say 'That's right! Just internet - nice and simple. Need anything else?' Keep it friendly!" : ""}

${transportInfo ? `REAL-TIME TRANSPORT:${transportInfo}\n` : ""}

PREVIOUS CONVERSATION for context:
${historyText || "None"}

HOTEL INFO: ${faqText}

The hotel address is: Vogelweiderstraße 93/B, 5020 Salzburg, Austria.

${isBookingQuestion ? `Booking link: ${botConfig.bookingLink}` : ''}

GUEST: ${userQuestion}

Be warm, conversational, and helpful. Keep responses friendly but not too long. Use occasional emojis like 😊 or 👍. Never use bold or special formatting for passwords. If giving a password, present it as plain text.`;

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
            reply += `\n\n🔗 ${botConfig.bookingLink}`;
        }
        
        history.push({ role: "user", content: userQuestion.substring(0, 100) });
        history.push({ role: "assistant", content: reply.substring(0, 200) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        
        res.json({ reply: reply });
    } catch (error) {
        console.error('Chat error:', error.message);
        res.json({ reply: "I'm having a little trouble right now. Could you try again? 😊" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Conversational Hotel Chat Bot running on port ${PORT}`);
    console.log(`📍 Hotel: Vogelweiderstraße 93/B, 5020 Salzburg`);
    console.log(`💬 Personality: Warm, friendly, conversational`);
    console.log(`🔑 Password formatting: Plain text (no bold)`);
    console.log(`🚍 ÖBB Transport: ${oebb ? 'ENABLED' : 'DISABLED (using web search)'}`);
    console.log(`🌍 Languages: English, German, Chinese`);
    console.log(`😊 Temperature: 0.7 (natural conversation)\n`);
});
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

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
    estimatedCostUSD: 0, // DeepSeek: ~$0.14 per 1M tokens
    questionsByLanguage: { english: 0, german: 0, spanish: 0, french: 0, italian: 0, chinese: 0, dutch: 0, japanese: 0, korean: 0, other: 0 },
    questionsByCategory: { hotel: 0, transport: 0, local: 0, booking: 0, help: 0, other: 0 },
    mostAskedQuestions: new Map(),
    tokenUsageByCategory: { hotel: 0, transport: 0, local: 0, booking: 0, help: 0, other: 0 },
    webSearchUsage: 0,
    blockedQuestions: 0,
    dailyActiveSessions: new Set(),
    dailyDates: new Map(),
    startTime: Date.now(),
    tokenHistory: [] // Last 100 token usage entries
};

// DeepSeek pricing: $0.14 per 1M input tokens, $0.28 per 1M output tokens
// Using average ~$0.20 per 1M total tokens for estimation
const COST_PER_MILLION_TOKENS = 0.20;

function updateTokenAnalytics(usage, category) {
    if (!usage) return;
    
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    
    analytics.totalTokensUsed += totalTokens;
    analytics.totalPromptTokens += promptTokens;
    analytics.totalCompletionTokens += completionTokens;
    
    // Update category-specific token usage
    if (category && analytics.tokenUsageByCategory[category] !== undefined) {
        analytics.tokenUsageByCategory[category] += totalTokens;
    } else {
        analytics.tokenUsageByCategory.other += totalTokens;
    }
    
    // Update estimated cost
    const cost = (totalTokens / 1000000) * COST_PER_MILLION_TOKENS;
    analytics.estimatedCostUSD += cost;
    
    // Store last 100 token entries for history
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
    console.log('📊 Analytics Snapshot:', JSON.stringify(stats, null, 2));
    fs.writeFileSync(path.join(__dirname, 'analytics.json'), JSON.stringify(stats, null, 2));
}, 3600000);

// ========== DEFAULT RULES ==========
let botConfig = {
    personality: `You are a friendly, efficient, and trustworthy hotel front desk agent. Be warm but not overly casual. Use polite phrases like "please," "thank you," and "of course." Greet guests with time-appropriate salutations (good morning, good afternoon, good evening). Use the hotel's name naturally within the first two messages (Hotel Vogelweiderhof). Empathize before solving problems — acknowledge frustrations first. Keep responses concise (1–3 short sentences for simple queries). Never argue with a guest. Do not end answers with a question.`,
    
    safetyRules: `Never ask for or store full credit card numbers, CVV, or passwords. Redirect to secure booking engine for payments. Never repeat back sensitive information. Never share other guests' data including names, room numbers, or stay dates. Never log any personal data. If uncertain about an answer, say so honestly. Only provide verified information about room types, amenities, check-in/out times and WiFi. Never guarantee early check-in or upgrades. Block abusive language with one neutral warning then end the conversation. Never give medical advice or help bypass security policies. Escalate to a human agent if they express distress, safety concerns, or emergencies. Never change a reservation without authentication via booking ID and last name or a secure link. Refer to Booking Engine from hotel homepage where the guest can set dates to get up-to-date availability and prices.`,
    
    styleRules: `Use sentence case only — never ALL CAPS except for brief emphasis like "NO" in policy statements. Break text into short lines, avoiding walls of text. Use line breaks between separate ideas. Use bullet points for lists of amenities, steps, or policies. Bold key information such as room type, price, or time sparingly. Never use all bold or all emojis in any message. Write dates in clear format like "24 May, 2026" not "24/05/26." Show prices with currency symbol followed by "per night" or "total." Do not correct the user's typos — answer the best guess. Maintain the same speaking style consistently throughout the conversation.`,
    
    websiteContent: "",
    customRules: [],
    bookingLink: "https://direct-book.com/properties/hotelvogelweiderhof",
    webSearchEnabled: true
};

// ========== LIMITS CONFIGURATION ==========
let limitsConfig = {
    maxTokensPerResponse: 150,
    maxMessagesPerSession: 15,
    maxQuestionsPerMinute: 10,
    dailyQuota: 500,
    topicFilterEnabled: true
};

const usageTracker = new Map();

// ========== ENHANCED TOPIC FILTER ==========
const ALLOWED_TOPICS = {
    hotel: /check[-\s]?in|check[-\s]?out|wifi|breakfast|parking|pool|pet|cancellation|reception|room service|laundry|smoking|room type|bed|bathroom|amenities|checkin|checkout/i,
    transport: /how to get|directions|get to|go to|way to|from hotel to|travel to|reach|taxi|bus|train|tram|subway|metro|shuttle|walk|drive|bike|public transport|car rental|pick up|drop off|uber|lyft|navigate/i,
    local: /weather|restaurant|bar|cafe|attraction|museum|airport|station|city center|old town|downtown|nearby|local|sightseeing|thing to do|wetter|restaurant|sehenswürdigkeiten|essen|trinken|what to see|what to do|salzburg|vienna|innsbruck|pharmacy|hospital|doctor|apotheke|krankenhaus/i,
    booking: /availability|available|book|booking|price|cost|rate|how much|what.*price|buchen|verfügbarkeit|preis/i,
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
    for (const [topic, pattern] of Object.entries(BLOCKED_TOPICS)) {
        if (pattern.test(lowerQuestion)) {
            analytics.blockedQuestions++;
            return { allowed: false, reason: `I can only answer questions about the hotel, local attractions, transportation, and travel.` };
        }
    }
    let isAllowed = false;
    for (const [topic, pattern] of Object.entries(ALLOWED_TOPICS)) {
        if (pattern.test(lowerQuestion)) {
            isAllowed = true;
            analytics.questionsByCategory[topic]++;
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
        return { allowed: false, reason: "I'm a hotel assistant. I can help with check-in/out times, WiFi, breakfast, local restaurants, weather, attractions, and directions." };
    }
    return { allowed: true, reason: null };
}

function checkRateLimit(ip) {
    const now = Date.now();
    let userData = usageTracker.get(ip);
    if (!userData) {
        userData = { minuteCount: 1, minuteReset: now + 60000, dailyCount: 1, dailyReset: now + 86400000, sessionCount: 1 };
        usageTracker.set(ip, userData);
        const today = new Date().toDateString();
        if (!analytics.dailyDates.has(today)) analytics.dailyDates.set(today, 0);
        analytics.dailyDates.set(today, analytics.dailyDates.get(today) + 1);
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
        let faqText = "=== OFFICIAL HOTEL INFORMATION ===\n\n";
        for (const [q, a] of Object.entries(faqMap)) faqText += `• ${q.toUpperCase()}: ${a}\n`;
        cachedFAQ = { faqMap, faqText, timestamp: stats.mtimeMs };
        lastFAQModified = stats.mtimeMs;
        console.log(`✅ FAQ loaded: ${Object.keys(faqMap).length} entries`);
        return cachedFAQ;
    } catch (error) { return null; }
}

// ========== ENHANCED MULTI-LANGUAGE DETECTION ==========
function detectLanguage(text) {
    analytics.totalQuestions++;
    
    const normalizedQuestion = text.toLowerCase().replace(/[^\w\s]/g, '').substring(0, 100);
    analytics.mostAskedQuestions.set(normalizedQuestion, (analytics.mostAskedQuestions.get(normalizedQuestion) || 0) + 1);
    
    if (/\b(auf deutsch|german|deutsch|sprache deutsch|deutsche)\b/i.test(text)) {
        analytics.questionsByLanguage.german++;
        return 'german';
    }
    if (/\b(spanish|español|castellano|hablas español)\b/i.test(text)) {
        analytics.questionsByLanguage.spanish++;
        return 'spanish';
    }
    if (/\b(french|français|parlez-vous français|french language)\b/i.test(text)) {
        analytics.questionsByLanguage.french++;
        return 'french';
    }
    if (/\b(italian|italiano|parli italiano|lingua italiana)\b/i.test(text)) {
        analytics.questionsByLanguage.italian++;
        return 'italian';
    }
    if (/\b(chinese|中文|汉语|普通话|mandarin|cn)\b/i.test(text)) {
        analytics.questionsByLanguage.chinese++;
        return 'chinese';
    }
    if (/\b(dutch|nederlands|spreek je nederlands|holland)\b/i.test(text)) {
        analytics.questionsByLanguage.dutch++;
        return 'dutch';
    }
    if (/\b(japanese|日本語|nihongo|japanese language)\b/i.test(text)) {
        analytics.questionsByLanguage.japanese++;
        return 'japanese';
    }
    if (/\b(korean|한국어|hangul|korean language)\b/i.test(text)) {
        analytics.questionsByLanguage.korean++;
        return 'korean';
    }
    
    if (/[äöüß]/i.test(text)) { analytics.questionsByLanguage.german++; return 'german'; }
    if (/á|é|í|ó|ú|ñ/i.test(text)) { analytics.questionsByLanguage.spanish++; return 'spanish'; }
    if (/ê|è|é|à|ç|û|î|ô|ï|ë/i.test(text) && /\b(je|tu|il|elle|nous|vous)\b/i.test(text)) { analytics.questionsByLanguage.french++; return 'french'; }
    if (/à|è|é|ì|ò|ù|ci|ti|mi|si/i.test(text) && /\b(io|tu|lui|lei|noi|voi|loro)\b/i.test(text)) { analytics.questionsByLanguage.italian++; return 'italian'; }
    if (/[\u4e00-\u9fff]|[\u3400-\u4dbf]|[\u3000-\u303f]/.test(text)) { analytics.questionsByLanguage.chinese++; return 'chinese'; }
    if (/[\u3040-\u309f]|[\u30a0-\u30ff]|[\uff00-\uff9f]/.test(text)) { analytics.questionsByLanguage.japanese++; return 'japanese'; }
    if (/[\uac00-\ud7af]|[\u1100-\u11ff]|[\u3130-\u318f]/.test(text)) { analytics.questionsByLanguage.korean++; return 'korean'; }
    if (/[àèìòùáéíóúâêîôûäëïöü]/i.test(text)) { analytics.questionsByLanguage.dutch++; return 'dutch'; }
    
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
    
    const faqData = loadFAQs();
    const faqText = faqData ? faqData.faqText : "";
    
    let detectedLang = userLanguagePreference.get(clientIp);
    if (!detectedLang) {
        detectedLang = detectLanguage(userQuestion);
        userLanguagePreference.set(clientIp, detectedLang);
    }
    
    let history = conversationMemory.get(clientIp) || [];
    const historyText = history.slice(-6).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    
    const isBookingQuestion = /availability|available|book|booking|price|cost|rate|buchen|verfügbarkeit|preis|how much|what.*price/i.test(userQuestion);
    const isLocalInfoQuestion = /weather|restaurant|bar|cafe|attraction|museum|wetter|restaurant|sehenswürdigkeiten|transport|directions|how to get|taxi|bus|train|old town|city center/i.test(userQuestion);
    const questionCategory = detectCategory(userQuestion);
    
    if (isLocalInfoQuestion && botConfig.webSearchEnabled) analytics.webSearchUsage++;
    
    const languageInstructions = {
        english: "RESPOND IN ENGLISH. Be concise and friendly.",
        german: "ANTWORTE AUF DEUTSCH. Verwenden Sie 'Sie' als Höflichkeitsform.",
        spanish: "RESPONDE EN ESPAÑOL. Use 'usted' para cortesía.",
        french: "RÉPONDEZ EN FRANÇAIS. Utilisez 'vous' pour la politesse.",
        italian: "RISPONDI IN ITALIANO. Usa 'lei' per cortesia.",
        chinese: "用中文回复。使用礼貌用语。保持简洁友好。",
        dutch: "ANTWOORD IN HET NEDERLANDS. Gebruik beleefde vormen.",
        japanese: "日本語で回答してください。丁寧な表現を使用してください。",
        korean: "한국어로 응답하세요. 공손한 표현을 사용하세요."
    };
    const languageInstruction = languageInstructions[detectedLang] || languageInstructions.english;
    
    const systemPrompt = `You are a hotel assistant at Hotel Vogelweiderhof.

PERSONALITY: ${botConfig.personality}
SAFETY: ${botConfig.safetyRules}
STYLE: ${botConfig.styleRules}

${languageInstruction}

PREVIOUS CONVERSATION:
${historyText || "None"}

${faqText}

${isBookingQuestion ? `Booking link: ${botConfig.bookingLink}` : ''}
${isLocalInfoQuestion && botConfig.webSearchEnabled ? `Use web search for current info (weather, restaurants, transport, directions).` : ''}

GUEST: ${userQuestion}`;

    try {
        const apiRequest = {
            model: "deepseek-chat",
            messages: [{ role: "user", content: systemPrompt }],
            temperature: 0.3,
            max_tokens: limitsConfig.maxTokensPerResponse
        };
        if (botConfig.webSearchEnabled && isLocalInfoQuestion) apiRequest.search_enabled = true;
        
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', apiRequest, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        
        let reply = response.data.choices[0].message.content;
        
        // Track token usage from API response
        if (response.data.usage) {
            updateTokenAnalytics(response.data.usage, questionCategory);
        }
        
        if (isBookingQuestion && !reply.includes('direct-book.com')) {
            const bookingText = { english: "Check availability:", german: "Verfügbarkeit prüfen:", spanish: "Ver disponibilidad:", french: "Vérifier disponibilité:", italian: "Verifica disponibilità:", chinese: "查看空房情况：" };
            reply += `\n\n🔗 ${bookingText[detectedLang] || bookingText.english} ${botConfig.bookingLink}`;
        }
        
        history.push({ role: "user", content: userQuestion.substring(0, 100) });
        history.push({ role: "assistant", content: reply.substring(0, 200) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        
        res.json({ reply: reply });
    } catch (error) {
        console.error('Chat error:', error.message);
        res.json({ reply: "I apologize, but I'm having trouble right now. Please try again in a moment." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Hotel Chat Bot running on port ${PORT}`);
    console.log(`📊 Analytics: Tracking questions, tokens, and costs`);
    console.log(`💰 Token pricing: ~$${COST_PER_MILLION_TOKENS} per 1M tokens`);
    console.log(`🌍 Languages: EN, DE, ES, FR, IT, ZH, NL, JA, KO`);
    console.log(`💾 Conversation memory: Last 5 exchanges`);
    console.log(`🔍 Web search: ${botConfig.webSearchEnabled ? 'ON' : 'OFF'}\n`);
});
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
    maxTokensPerResponse: 200,
    maxMessagesPerSession: 15,
    maxQuestionsPerMinute: 10,
    dailyQuota: 50,
    topicFilterEnabled: true
};

const usageTracker = new Map();

// Topic filter patterns
const ALLOWED_TOPICS = {
    hotel: /check[-\s]?in|check[-\s]?out|wifi|breakfast|parking|pool|pet|cancellation|reception|room service|laundry|smoking|shuttle|tax|room type|bed|bathroom|amenities/i,
    local: /weather|restaurant|bar|cafe|attraction|museum|transport|taxi|bus|train|airport|directions|nearby|local|sightseeing|thing to do|wetter|restaurant|sehenswürdigkeiten|essen|trinken/i,
    booking: /availability|available|book|booking|price|cost|rate|how much|what.*price|buchen|verfügbarkeit|preis/i,
    help: /help|assist|support|what can you do|how do you work/i
};

const BLOCKED_TOPICS = {
    politics: /politics|election|president|government|trump|biden|putin|ukraine|war|military/i,
    adult: /sex|porn|naked|hookup|escort|adult/i,
    violence: /violence|violent|fight|kill|murder|weapon|gun|bomb|attack/i
};

function isQuestionAllowed(question) {
    if (!limitsConfig.topicFilterEnabled) return { allowed: true, reason: null };
    const lowerQuestion = question.toLowerCase();
    for (const [topic, pattern] of Object.entries(BLOCKED_TOPICS)) {
        if (pattern.test(lowerQuestion)) {
            return { allowed: false, reason: `I can only answer questions about the hotel, local attractions, and travel.` };
        }
    }
    let isAllowed = false;
    for (const [topic, pattern] of Object.entries(ALLOWED_TOPICS)) {
        if (pattern.test(lowerQuestion)) {
            isAllowed = true;
            break;
        }
    }
    if (lowerQuestion.length < 5 && !isAllowed) return { allowed: true, reason: null };
    if (!isAllowed) return { allowed: false, reason: "I'm a hotel assistant. I can help with check-in/out times, WiFi, breakfast, local restaurants, weather, and attractions." };
    return { allowed: true, reason: null };
}

function checkRateLimit(ip) {
    const now = Date.now();
    const userData = usageTracker.get(ip);
    if (!userData) {
        usageTracker.set(ip, { minuteCount: 1, minuteReset: now + 60000, dailyCount: 1, dailyReset: now + 86400000, sessionCount: 1 });
        return { allowed: true, message: null };
    }
    if (now > userData.minuteReset) { userData.minuteCount = 0; userData.minuteReset = now + 60000; }
    if (now > userData.dailyReset) { userData.dailyCount = 0; userData.dailyReset = now + 86400000; }
    if (userData.minuteCount >= limitsConfig.maxQuestionsPerMinute) return { allowed: false, message: "Too many questions. Please wait a moment." };
    if (userData.dailyCount >= limitsConfig.dailyQuota) return { allowed: false, message: "Daily question limit reached. Please come back tomorrow." };
    if (userData.sessionCount >= limitsConfig.maxMessagesPerSession) return { allowed: false, message: "Conversation limit reached. Please refresh the page." };
    userData.minuteCount++; userData.dailyCount++; userData.sessionCount++;
    usageTracker.set(ip, userData);
    return { allowed: true, message: null };
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of usageTracker.entries()) {
        if (now > data.dailyReset && now > data.minuteReset) usageTracker.delete(ip);
    }
}, 3600000);

// ========== API ENDPOINTS ==========
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
    if (userData) userData.sessionCount = 0;
    res.json({ success: true });
});

function detectLanguage(text) {
    if (/[äöüß]/i.test(text)) return 'german';
    if (/á|é|í|ó|ú|ñ/i.test(text)) return 'spanish';
    if (/ê|è|é|à|ç|û|î|ô|ï|ë/i.test(text)) return 'french';
    if (/à|è|é|ì|ò|ù/i.test(text)) return 'italian';
    return 'auto';
}

function loadFAQs() {
    try {
        const faqPath = path.join(__dirname, 'hotel-faqs.txt');
        if (!fs.existsSync(faqPath)) return null;
        const content = fs.readFileSync(faqPath, 'utf8');
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
        let faqText = "HOTEL INFO:\n";
        for (const [q, a] of Object.entries(faqMap)) faqText += `${q}: ${a}\n`;
        return { faqMap, faqText };
    } catch (error) { return null; }
}

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
    res.json({ success: true, message: "Setup complete!" });
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

app.post('/api/chat', async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const userQuestion = req.body.userMessage;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    if (!apiKey) return res.json({ reply: "❌ API key missing." });
    
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) return res.json({ reply: rateCheck.message });
    
    const topicCheck = isQuestionAllowed(userQuestion);
    if (!topicCheck.allowed) return res.json({ reply: topicCheck.reason });
    
    const faqData = loadFAQs();
    const faqText = faqData ? faqData.faqText : "";
    const detectedLang = detectLanguage(userQuestion);
    const isBookingQuestion = /availability|available|book|booking|price|cost|rate|buchen|verfügbarkeit|preis/i.test(userQuestion);
    const isLocalInfoQuestion = /weather|restaurant|bar|cafe|attraction|museum|wetter|restaurant|sehenswürdigkeiten/i.test(userQuestion);
    
    const systemPrompt = `You are a hotel assistant. Follow these rules STRICTLY:

PERSONALITY: ${botConfig.personality}

SAFETY RULES: ${botConfig.safetyRules}

STYLE RULES: ${botConfig.styleRules}

LANGUAGE: Respond in the SAME language as the guest.

HOTEL INFO: ${faqText || "No FAQ loaded"}

${isBookingQuestion ? `For booking: ${botConfig.bookingLink}` : ''}
${isLocalInfoQuestion && botConfig.webSearchEnabled ? `Use web search for current local information.` : ''}

GUEST: ${userQuestion}`;

    try {
        const apiRequest = {
            model: "deepseek-chat",
            messages: [{ role: "user", content: systemPrompt }],
            temperature: 0.5,
            max_tokens: limitsConfig.maxTokensPerResponse
        };
        if (botConfig.webSearchEnabled && isLocalInfoQuestion) apiRequest.search_enabled = true;
        
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', apiRequest, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        
        let reply = response.data.choices[0].message.content;
        if (isBookingQuestion && !reply.includes('direct-book.com')) reply += `\n\n🔗 Please check availability here: ${botConfig.bookingLink}`;
        res.json({ reply: reply });
    } catch (error) {
        console.error('Chat error:', error.message);
        res.json({ reply: "I apologize, but I'm having trouble right now. Please try again in a moment." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Hotel Chat Bot running on port ${PORT}`);
    console.log(`📊 Limits: ${limitsConfig.maxMessagesPerSession} msgs/session, ${limitsConfig.dailyQuota}/day`);
    console.log(`🎭 Rules: Personality + Safety + Style loaded\n`);
});
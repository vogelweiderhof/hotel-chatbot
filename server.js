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

// ========== WORKING ÖBB API USING OFFICIAL ENDPOINT ==========
// This uses the public ÖBB Scotty API that actually works

async function getRealTimeDepartures(stationName, maxResults = 5) {
    try {
        // First, search for the station ID
        const searchUrl = `https://fahrplan.oebb.at/bin/query.exe/dny?L=vs_webapp&xml=true&REQ0JourneyStopsS0A=1&REQ0JourneyStopsS0G=${encodeURIComponent(stationName)}`;
        
        const searchResponse = await axios.get(searchUrl, { timeout: 8000 });
        const searchData = searchResponse.data;
        
        // Extract station ID from XML (simplified - looking for stopID)
        let stationId = null;
        const stopIdMatch = searchData.match(/stopID="([^"]+)"/);
        if (stopIdMatch) stationId = stopIdMatch[1];
        
        if (!stationId) {
            console.log(`Could not find station ID for: ${stationName}`);
            return null;
        }
        
        // Now get departures using the station ID
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        
        const departuresUrl = `https://fahrplan.oebb.at/bin/query.exe/dny?L=vs_webapp&xml=true&REQ0JourneyStopsS0A=1&REQ0JourneyStopsS0ID=${stationId}&REQ0HafasSearchForw=1&date=${year}${month}${day}&time=${hours}${minutes}&maxJourneys=${maxResults}`;
        
        const departuresResponse = await axios.get(departuresUrl, { timeout: 8000 });
        const xmlData = departuresResponse.data;
        
        // Parse XML response for journeys
        const journeys = [];
        const journeyMatches = xmlData.matchAll(/<Journey>([\s\S]*?)<\/Journey>/g);
        
        for (const match of journeyMatches) {
            const journeyXml = match[1];
            
            // Extract line/product name
            let line = "Bus/Train";
            const prodMatch = journeyXml.match(/<Prod(?:ection)?[^>]*name="([^"]+)"/);
            if (prodMatch) line = prodMatch[1];
            
            // Extract destination
            let destination = "";
            const destMatch = journeyXml.match(/<Dest[^>]*>([^<]+)<\/Dest>/);
            if (destMatch) destination = destMatch[1];
            
            // Extract departure time
            let departureTime = "";
            const timeMatch = journeyXml.match(/<Time[^>]*>([^<]+)<\/Time>/);
            if (timeMatch) departureTime = timeMatch[1];
            
            // Extract delay if any
            let delay = 0;
            const delayMatch = journeyXml.match(/<RTDelay>([^<]+)<\/RTDelay>/);
            if (delayMatch) delay = parseInt(delayMatch[1]) || 0;
            
            if (line && destination && departureTime) {
                journeys.push({ line, direction: destination, departureTime, delay });
            }
            
            if (journeys.length >= maxResults) break;
        }
        
        return journeys.length > 0 ? journeys : null;
        
    } catch (error) {
        console.log("ÖBB API error:", error.message);
        return null;
    }
}

// Alternative: Use simple web scraping for real data
async function getSimpleDepartures(stationName) {
    try {
        // Try the mobile version of ÖBB which is simpler
        const searchUrl = `https://fahrplan.oebb.at/webapp/#!P|TP!H${encodeURIComponent(stationName)}`;
        
        // This is a fallback - for actual implementation, we'll use a reliable public API
        // Since ÖBB doesn't provide a free public API, we'll use a workaround
        
        return null;
    } catch (error) {
        return null;
    }
}

// ========== ALTERNATIVE: Use a working public transport API ==========
// Since ÖBB API is unreliable, we'll provide schedule info from FAQ
// and guide users to official sources

function getScheduleFromFAQ(question) {
    const lower = question.toLowerCase();
    
    if (lower.includes('bus 150')) {
        return `Bus 150 schedule information:
• Route: Salzburg → Bad Ischl (towards Hallstatt direction)
• Frequency: Approximately every 30-60 minutes
• First bus: Around 5:00 AM
• Last bus: Around 8:00 PM
• Journey time: ~1.5 hours to Bad Ischl

For exact real-time departures today, please check:
• www.oebb.at (official, always up to date)
• Google Maps (click on the bus stop for live times)
• Scotty app by ÖBB

Would you like the full scenic route to Hallstatt using Bus 150?`;
    }
    
    if (lower.includes('bus 120') || lower.includes('bus 121')) {
        return `Bus 120/121 schedule from Baron Schwarz Park (your hotel):
• Direction: Hauptbahnhof (Train Station)
• Frequency: Every 20-30 minutes
• Journey time: ~10-11 minutes
• Important: Wave to the driver to stop

For exact real-time departures today, check www.oebb.at or Google Maps.

Bus 21 (different direction) goes to City Center (direction Fürstenbrunn).`;
    }
    
    if (lower.includes('bus 21')) {
        return `Bus 21 schedule from Baron Schwarz Park (your hotel):
• Direction: Fürstenbrunn (City Center)
• Frequency: Every 15-20 minutes
• Journey time: ~15 minutes to City Center

For exact real-time departures, check www.oebb.at or Google Maps.

Bus 21 does NOT go to the train station - use Bus 120/121 for that.`;
    }
    
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
    personality: `You are a helpful hotel front desk agent. You understand what the guest really wants.`,
    
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
    
    if (lower.includes('hallstatt')) return 'hallstatt';
    if (lower.includes('königssee') || lower.includes('koenigssee')) return 'koenigssee';
    if (lower.includes('vienna') || lower.includes('wien')) return 'vienna';
    if (lower.includes('salzburg') && (lower.includes('city center') || lower.includes('altstadt'))) return 'salzburg_city';
    if (lower.includes('train station') || lower.includes('hauptbahnhof') || lower.includes('hbf')) return 'train_station';
    if (/(next|when|what time|schedule).*(bus|train|departure)/i.test(question)) return 'schedule';
    if (lower.includes('bus 150') || lower.includes('bus150')) return 'bus150';
    if (lower.includes('bus 120') || lower.includes('bus120')) return 'bus120';
    if (lower.includes('bus 121') || lower.includes('bus121')) return 'bus121';
    if (lower.includes('bus 21')) return 'bus21';
    if (lower.includes('bus') || lower.includes('train')) return 'transport';
    return 'general';
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
    
    // CHECK FOR SCHEDULE QUESTIONS FROM FAQ FIRST
    const scheduleAnswer = getScheduleFromFAQ(userQuestion);
    if (scheduleAnswer) {
        // Store in conversation memory
        let history = conversationMemory.get(clientIp) || [];
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: scheduleAnswer.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: scheduleAnswer });
    }
    
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
    
    const languageInstructions = {
        english: "RESPOND IN ENGLISH. Be direct and helpful. For schedule questions, direct guests to www.oebb.at or Google Maps for real-time departures.",
        german: "ANTWORTE AUF DEUTSCH. Seien Sie direkt und hilfreich. Für Fahrplanfragen verweisen Sie auf www.oebb.at oder Google Maps.",
        chinese: "用中文回复。对于时刻表问题，请引导客人访问 www.oebb.at 或 Google 地图查看实时班次。"
    };
    
    const systemPrompt = `You are a hotel assistant at Hotel Vogelweiderhof (Vogelweiderstraße 93/B, 5020 Salzburg).

**HOTEL FAQ (OFFICIAL INFORMATION - USE THIS FOR ALL ROUTES):**
${faqContent}

**INTENT DETECTED:** ${intent}

**IMPORTANT - REAL TIME SCHEDULES:**
The hotel does not have direct API access to real-time bus/train schedules. When guests ask for specific departure times (e.g., "when is the next bus 150"), ALWAYS respond with:
1. "For real-time departures, please check www.oebb.at or Google Maps - both show live schedules."
2. Then provide the general frequency from the FAQ (e.g., "Bus 150 runs approximately every 30-60 minutes").

**SPECIFIC ROUTING INSTRUCTIONS:**

1. **HALLSTATT ROUTE (from FAQ - USE THIS):**
   - There is NO direct connection from Salzburg to Hallstatt (neither bus nor train)
   - BUS ROUTE (scenic, better views): Bus 150 → change to Bus 541 → change to Bus 543 at "Hallstatt Gosaumühle" → Bus 543 stops at "Hallstatt Lahn" (directly at the lake)
   - TRAIN ROUTE (faster): Train to Attnang-Puchheim → change to Hallstatt train → then take ferry across lake
   - Guest Mobility Ticket valid to Bad Ischl only

2. **BUS 150 SCHEDULE:**
   - Route: Salzburg to Bad Ischl (towards Hallstatt)
   - Frequency: Every 30-60 minutes
   - First bus: ~5:00 AM, Last bus: ~8:00 PM
   - For exact today's departures: www.oebb.at

3. **BUS 120/121 FROM HOTEL:**
   - From Baron Schwarz Park to Hauptbahnhof (Train Station)
   - Frequency: Every 20-30 minutes
   - IMPORTANT: Wave to the driver to stop
   - For live departures: www.oebb.at or Google Maps

4. **BUS 21 FROM HOTEL:**
   - From Baron Schwarz Park to City Center (direction Fürstenbrunn)
   - Frequency: Every 15-20 minutes

**CRITICAL RULES:**
- NEVER say you don't have schedule information without directing to www.oebb.at
- For any "when is the next bus/train" question: First give the website, THEN give general frequency
- Never end responses with questions
- Be warm and helpful

${languageInstructions[detectedLang] || languageInstructions.english}

PREVIOUS CONVERSATION:
${historyText || "None"}

GUEST: ${userQuestion}`;

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
    console.log(`📋 FAQ Priority: HIGH`);
    console.log(`🚆 Real-time schedules: Using FAQ + direct links to www.oebb.at`);
    console.log(`🔍 Web Search: ${botConfig.webSearchEnabled ? 'ENABLED' : 'DISABLED'}\n`);
});
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

// ========== HELPER FUNCTIONS ==========
function isWeekendOrHoliday() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    return (dayOfWeek === 0 || dayOfWeek === 6);
}

// ========== VAO/HAFAS API FOR REAL-TIME BUS DEPARTURES ==========
const VAO_API_URL = "https://vao.demo.hafas.de/gate";

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
            timeout: 10000,
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

async function getRealTimeDepartures(stationName, maxResults = 30) {
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
            timeout: 10000,
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
            
            // Extract bus number
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
        
        // Filter out entries without bus numbers and remove duplicates
        results = results.filter(r => r.busNumber && r.departureTime !== "--:--");
        
        // Remove duplicate times for same bus number and direction
        const uniqueResults = [];
        const seen = new Set();
        for (const r of results) {
            const key = `${r.busNumber}|${r.direction}|${r.departureTime}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(r);
            }
        }
        
        return uniqueResults;
        
    } catch (error) {
        console.error('VAO API error:', error.message);
        return null;
    }
}

// ========== GET ALL BUS DEPARTURES FROM KEY STOPS ==========
async function getAllBusData() {
    const stops = [
        { name: "Baron Schwarz Park", context: "hotel" },
        { name: "Hanuschplatz", context: "city_center" },
        { name: "Salzburg Hbf", context: "train_station" }
    ];
    
    const allData = {};
    
    for (const stop of stops) {
        const departures = await getRealTimeDepartures(stop.name, 40);
        if (departures) {
            allData[stop.context] = {
                stopName: stop.name,
                departures: departures
            };
        }
    }
    
    return allData;
}

// ========== WEATHER API ==========
async function getWeatherData() {
    try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=Salzburg&count=1&language=en&format=json`;
        const geoResponse = await axios.get(geoUrl, { timeout: 8000 });
        
        if (!geoResponse.data.results || geoResponse.data.results.length === 0) return null;
        
        const location = geoResponse.data.results[0];
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current_weather=true&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe/Vienna&forecast_days=3`;
        const weatherResponse = await axios.get(weatherUrl, { timeout: 8000 });
        
        const current = weatherResponse.data.current_weather;
        const daily = weatherResponse.data.daily;
        
        if (!current) return null;
        
        const weatherCodes = {
            0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
            45: "Foggy", 51: "Light drizzle", 61: "Light rain", 63: "Moderate rain",
            65: "Heavy rain", 71: "Light snow", 73: "Moderate snow", 75: "Heavy snow", 95: "Thunderstorm"
        };
        
        return {
            city: location.name,
            current: {
                temperature: current.temperature,
                condition: weatherCodes[current.weathercode] || "Unknown",
                windSpeed: current.windspeed
            },
            forecast: daily.time.slice(0, 3).map((time, i) => ({
                day: new Date(time).toLocaleDateString('en-US', { weekday: 'short' }),
                high: daily.temperature_2m_max[i],
                low: daily.temperature_2m_min[i],
                condition: weatherCodes[daily.weather_code[i]] || "Unknown"
            }))
        };
    } catch (error) {
        console.log("Weather API error:", error.message);
        return null;
    }
}

// ========== STATIC KNOWLEDGE BASE ==========
function getKnowledgeBase() {
    return {
        busStops: {
            "Baron Schwarz Park": {
                location: "Hotel Vogelweiderhof bus stop, 30 meters from the hotel",
                coordinates: "Schallmoos district"
            },
            "Hanuschplatz": {
                location: "City center stop, near Old Town",
                coordinates: "Altstadt"
            },
            "Salzburg Hbf": {
                location: "Salzburg Main Train Station",
                coordinates: "Hauptbahnhof"
            },
            "Markartplatz": {
                location: "Central square in Salzburg",
                coordinates: "Near Old Town"
            }
        },
        busRoutes: {
            "21": {
                description: "Connects Hotel Vogelweiderhof with City Center",
                directions: {
                    "Fürstenbrunn": "City Center (Altstadt)",
                    "Bergheim": "Back to Hotel area (Baron Schwarz Park)"
                }
            },
            "120": {
                description: "Connects Hotel Vogelweiderhof with Train Station",
                directions: {
                    "Hauptbahnhof": "Salzburg Main Train Station",
                    "Pelting": "Back to Hotel area (Baron Schwarz Park)"
                }
            },
            "121": {
                description: "Connects Hotel Vogelweiderhof with Train Station (same route as 120)",
                directions: {
                    "Hauptbahnhof": "Salzburg Main Train Station",
                    "Pelting": "Back to Hotel area (Baron Schwarz Park)"
                }
            },
            "150": {
                description: "From Train Station to Bad Ischl (connection to Hallstatt)",
                directions: {
                    "Bad Ischl": "Transfer to Bus 541 → Bus 543 for Hallstatt"
                }
            },
            "840": {
                description: "From Train Station to Königssee (Germany)",
                directions: {
                    "Jennerbahn": "Get off at 'Königssee' stop for the lake"
                }
            },
            "25": {
                description: "From Markartplatz to Hellbrunn, Zoo, Untersbergbahn",
                directions: {
                    "Untersbergbahn": "Hellbrunn Palace, Zoo, Untersberg cable car"
                }
            }
        },
        guestTicket: {
            name: "Guest Mobility Ticket",
            description: "Free public transport in Salzburg province",
            requires: "Online check-in before arrival"
        },
        nearbyRestaurants: [
            { name: "Smash to Go", location: "Beside hotel", cuisine: "Burgers", discount: "15% for hotel guests" },
            { name: "Mr. Cevap", location: "1 min walk", cuisine: "Balkan grill" },
            { name: "Gasthaus Turnerwirt", location: "3 min walk, across street", cuisine: "Traditional Austrian" }
        ],
        cityCenterRestaurants: [
            { name: "Sternbräu", cuisine: "Traditional Austrian" },
            { name: "St. Peter", cuisine: "Oldest restaurant in Europe" },
            { name: "Stieglkeller", cuisine: "Austrian with Stiegl beer" },
            { name: "Augustinerbräu", cuisine: "Monastery brewery" }
        ],
        sights: [
            { name: "Hohensalzburg Fortress", description: "Largest preserved castle in Central Europe" },
            { name: "Mirabell Palace & Gardens", description: "Baroque palace, free gardens" },
            { name: "Mozart's Birthplace", description: "Getreidegasse 9" },
            { name: "Salzburg Cathedral", description: "Baroque cathedral" },
            { name: "Hellbrunn Palace", description: "Famous trick fountains" },
            { name: "Untersberg Mountain", description: "1,853m cable car with 360° view" }
        ]
    };
}

// ========== CONVERSATION MEMORY ==========
const conversationMemory = new Map();
const userSessionStart = new Map();

// ========== FAQ LOADER ==========
let cachedFAQ = null;
let lastFAQModified = 0;
const FAQ_PATH = path.join(__dirname, 'hotel-faqs.txt');

function loadFAQs() {
    try {
        if (!fs.existsSync(FAQ_PATH)) return "No FAQ loaded";
        const stats = fs.statSync(FAQ_PATH);
        if (stats.mtimeMs === lastFAQModified && cachedFAQ) return cachedFAQ;
        cachedFAQ = fs.readFileSync(FAQ_PATH, 'utf8');
        lastFAQModified = stats.mtimeMs;
        console.log(`✅ FAQ loaded`);
        return cachedFAQ;
    } catch (error) { 
        return "FAQ unavailable"; 
    }
}

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
    personality: `You are a helpful hotel front desk agent at Hotel Vogelweiderhof in Salzburg.`,
    safetyRules: `Never ask for credit card numbers. Never share other guests' data.`,
    styleRules: `Use sentence case. Be direct, helpful, and warm. Never end responses with questions.`,
    websiteContent: "",
    customRules: [],
    bookingLink: "https://direct-book.com/properties/hotelvogelweiderhof",
    webSearchEnabled: true
};

// ========== LIMITS ==========
let limitsConfig = {
    maxTokensPerResponse: 600,
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

// ========== MAIN CHAT ENDPOINT - AI DOES ALL THE REASONING ==========
app.post('/api/chat', async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const userQuestion = req.body.userMessage;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    if (!apiKey) return res.json({ reply: "❌ API key missing. Please contact reception." });
    
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) return res.json({ reply: rateCheck.message });
    const topicCheck = isQuestionAllowed(userQuestion);
    if (!topicCheck.allowed) return res.json({ reply: topicCheck.reason });
    
    const faqContent = loadFAQs();
    let history = conversationMemory.get(clientIp) || [];
    const isWeekend = isWeekendOrHoliday();
    
    // Fetch real-time data
    console.log("🔄 Fetching live bus data...");
    const busData = await getAllBusData();
    console.log("✅ Live bus data fetched");
    
    const weatherData = await getWeatherData();
    const knowledgeBase = getKnowledgeBase();
    
    // Build conversation history
    const historyText = history.slice(-10).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    
    // The system prompt - AI does all the reasoning
    const systemPrompt = `You are a helpful hotel assistant at Hotel Vogelweiderhof in Salzburg.

========================================
YOUR TASK
========================================
Understand what the guest is asking and provide helpful, accurate information. You have access to:
1. Real-time bus departure data
2. Current weather data
3. FAQ and hotel information
4. Knowledge about Salzburg

========================================
REAL-TIME BUS DATA (LIVE FROM ÖBB)
========================================

${JSON.stringify(busData, null, 2)}

========================================
WEATHER DATA (LIVE)
========================================

${weatherData ? JSON.stringify(weatherData, null, 2) : "Weather data currently unavailable"}

========================================
STATIC KNOWLEDGE BASE
========================================

${JSON.stringify(knowledgeBase, null, 2)}

========================================
HOTEL FAQ
========================================

${faqContent}

========================================
CONVERSATION HISTORY
========================================

${historyText || "No previous conversation"}

========================================
CURRENT QUESTION
========================================

Guest: ${userQuestion}

========================================
INSTRUCTIONS
========================================

1. LANGUAGE: Respond in the SAME language as the guest's question. If they ask in German, respond in German. If in English, respond in English. If they switch languages, switch with them.

2. BUS QUERIES: When asked about buses:
   - Understand where the guest is (hotel? city center? train station?) from context
   - Understand where they want to go
   - Show ONLY relevant departures for their journey
   - Filter bus data to show only the bus line they asked about
   - Format departure times clearly (e.g., "20:34")
   - Include delay information if present
   - Mention the Guest Mobility Ticket makes the ride FREE

3. LOCATION MAPPING:
   - "Fürstenbrunn" direction = City Center (Altstadt)
   - "Bergheim" direction = Back to Hotel area (Baron Schwarz Park)
   - "Hauptbahnhof" = Main Train Station
   - "Pelting" = Back to Hotel area (from train station)

4. ROUTE QUERIES: When asked "how to get to X":
   - Provide the best bus option
   - Include direction, travel time, and bus stop location
   - Remind about free Guest Mobility Ticket

5. WEATHER QUERIES: Use the weather data above to answer

6. RESTAURANT/FOOD QUERIES: Use the knowledge base

7. SIGHTSEEING QUERIES: Use the knowledge base

8. CRITICAL RULES:
   - NEVER end responses with questions
   - NEVER ask "Would you like...", "Can I help you with...", "Is there anything else..."
   - Just state the information and stop
   - Be warm, helpful, and concise
   - Use bullet points or line breaks for clarity

${isWeekend ? "NOTE: Today is a weekend or holiday. Bus schedules may have reduced frequency." : ""}

Now, respond to the guest's question naturally and helpfully.`;

    try {
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: "deepseek-chat",
            messages: [{ role: "user", content: systemPrompt }],
            temperature: 0.5,
            max_tokens: limitsConfig.maxTokensPerResponse
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        
        let reply = response.data.choices[0].message.content;
        
        // Safety: remove any trailing question marks
        reply = reply.replace(/\?$/, '.');
        reply = reply.replace(/ Would you like.*$/s, '');
        reply = reply.replace(/ Can I help.*$/s, '');
        reply = reply.replace(/ Is there anything.*$/s, '');
        reply = reply.replace(/ Let me know if.*$/s, '');
        
        if (response.data.usage) {
            updateTokenAnalytics(response.data.usage);
        }
        
        // Store in conversation memory
        analytics.totalQuestions++;
        const normalizedQuestion = userQuestion.toLowerCase().substring(0, 100);
        analytics.mostAskedQuestions.set(normalizedQuestion, (analytics.mostAskedQuestions.get(normalizedQuestion) || 0) + 1);
        
        history.push({ role: "user", content: userQuestion.substring(0, 300) });
        history.push({ role: "assistant", content: reply.substring(0, 800) });
        if (history.length > 15) history.splice(0, 3);
        conversationMemory.set(clientIp, history);
        
        res.json({ reply: reply });
        
    } catch (error) {
        console.error('Chat error:', error.message);
        const errorReply = "I'm having technical difficulties. Please try again later.";
        res.json({ reply: errorReply });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Hotel Chat Bot running on port ${PORT}`);
    console.log(`📍 Hotel: Vogelweiderstraße 93/B, 5020 Salzburg`);
    console.log(`🚆 VAO/HAFAS API: ENABLED (LIVE real-time departures)`);
    console.log(`🌤️ Weather API: ENABLED (Open-Meteo)`);
    console.log(`🧠 AI-POWERED: The AI understands context, location, and language`);
    console.log(`📦 Raw bus data provided to AI - AI decides what to show`);
    console.log(`💾 Conversation memory: ENABLED`);
    console.log(`📋 FAQ loaded: ${loadFAQs() !== "No FAQ loaded" ? "YES" : "NO"}`);
    console.log(`\n✅ The AI automatically:`);
    console.log(`   • Detects language from the question`);
    console.log(`   • Figures out where the user is and where they want to go`);
    console.log(`   • Filters bus departures to show only relevant direction`);
    console.log(`   • Never ends responses with questions`);
    console.log(`   • Uses real-time bus data live from ÖBB\n`);
});
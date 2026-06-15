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

// ========== CHECK IF TODAY IS WEEKEND OR HOLIDAY ==========
function isWeekendOrHoliday() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return true;
    
    const year = today.getFullYear();
    const holidays = [
        `${year}-01-01`, `${year}-01-06`, `${year}-04-21`, `${year}-05-01`,
        `${year}-05-29`, `${year}-06-09`, `${year}-06-19`, `${year}-08-15`,
        `${year}-10-26`, `${year}-11-01`, `${year}-12-08`, `${year}-12-25`, `${year}-12-26`
    ];
    const todayStr = today.toISOString().split('T')[0];
    return holidays.includes(todayStr);
}

// ========== HARDCODED WIFI RESPONSE ==========
function getWifiResponse(lang = 'english') {
    if (lang === 'german') {
        return "Das WLAN-Passwort lautet: internet (alles kleingeschrieben). Der Netzwerkname ist Vogelweiderhof.";
    }
    if (lang === 'chinese') {
        return "WiFi密码是：internet（全部小写）。网络名称是Vogelweiderhof。";
    }
    return "The WiFi password is: internet (all lowercase). The network name is Vogelweiderhof.";
}

// ========== WEATHER API (Open-Meteo) ==========
async function getWeather(city = "Salzburg") {
    try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
        const geoResponse = await axios.get(geoUrl, { timeout: 8000 });
        
        if (!geoResponse.data.results || geoResponse.data.results.length === 0) {
            return null;
        }
        
        const location = geoResponse.data.results[0];
        const lat = location.latitude;
        const lon = location.longitude;
        
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe/Vienna&forecast_days=3`;
        const weatherResponse = await axios.get(weatherUrl, { timeout: 8000 });
        
        const current = weatherResponse.data.current_weather;
        const daily = weatherResponse.data.daily;
        
        if (!current) return null;
        
        let response = `Weather in ${location.name}:\n`;
        response += `Current: ${current.temperature}°C, ${getWeatherDescription(current.weathercode)}\n`;
        response += `Wind: ${current.windspeed} km/h\n\n`;
        
        response += `3-Day Forecast:\n`;
        for (let i = 0; i < daily.time.length && i < 3; i++) {
            const day = new Date(daily.time[i]);
            const dayName = day.toLocaleDateString('en-US', { weekday: 'short' });
            response += `${dayName}: High ${daily.temperature_2m_max[i]}°C / Low ${daily.temperature_2m_min[i]}°C, ${getWeatherDescription(daily.weather_code[i])}\n`;
        }
        
        return response;
    } catch (error) {
        console.log("Weather API error:", error.message);
        return null;
    }
}

function getWeatherDescription(code) {
    const descriptions = {
        0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Foggy", 51: "Light drizzle", 61: "Light rain", 63: "Moderate rain",
        65: "Heavy rain", 71: "Light snow", 73: "Moderate snow", 75: "Heavy snow", 95: "Thunderstorm"
    };
    return descriptions[code] || "Unknown";
}

// ========== CURRENCY CONVERSION API ==========
async function convertCurrency(amount, from, to) {
    try {
        from = from.toUpperCase();
        to = to.toUpperCase();
        
        const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.rates) {
            const rate = response.data.rates[to];
            const converted = (amount * rate).toFixed(2);
            return `${amount} ${from} = ${converted} ${to}\nExchange rate: 1 ${from} = ${rate} ${to}`;
        }
        return null;
    } catch (error) {
        console.log("Currency API error:", error.message);
        return null;
    }
}

// ========== TIME ZONE INFO ==========
function getTimeZoneInfo(lang = 'english') {
    const now = new Date();
    const salzburgTime = now.toLocaleString(lang === 'german' ? 'de-DE' : lang === 'chinese' ? 'zh-CN' : 'en-US', { timeZone: 'Europe/Vienna' });
    const isDST = isDaylightSavingTime(now);
    
    if (lang === 'german') {
        return `Aktuelle Uhrzeit in Salzburg: ${salzburgTime}\nZeitzone: Mitteleuropäische Zeit (MEZ/MESZ)\nSommerzeit: ${isDST ? 'Aktiv (UTC+2)' : 'Nicht aktiv (UTC+1)'}`;
    }
    if (lang === 'chinese') {
        return `萨尔茨堡当前时间: ${salzburgTime}\n时区: 中欧时间 (CET/CEST)\n夏令时: ${isDST ? '生效中 (UTC+2)' : '未生效 (UTC+1)'}`;
    }
    return `Current time in Salzburg: ${salzburgTime}\nTime zone: Central European Time (CET/CEST)\nDaylight Saving Time: ${isDST ? 'Active (UTC+2)' : 'Not active (UTC+1)'}`;
}

function isDaylightSavingTime(date) {
    const jan = new Date(date.getFullYear(), 0, 1);
    const jul = new Date(date.getFullYear(), 6, 1);
    const stdTimezoneOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    return date.getTimezoneOffset() < stdTimezoneOffset;
}

// ========== RESTAURANT INFORMATION ==========
function getNearbyRestaurants(lang = 'english') {
    if (lang === 'german') {
        return `Restaurants in der Nähe des Hotel Vogelweiderhof:

DIREKT BEIM HOTEL (1-3 Gehminuten):

Smash to Go (Food Truck) - Neben dem Hotel, 15% Rabatt für Hotelgäste
Mr. Cevap - 1 Gehminute, Balkan Grill
Gasthaus Turnerwirt - 3 Gehminuten, gegenüber, traditionelle österreichische Küche

ENTLANG DER VOGELWEIDERSTRASSE (20 Gehminuten oder Bus 120/121 bis Pauernfeindstraße):
Restaurant Fuxn - Österreichische Küche

STADTZENTRUM (15 Minuten mit Bus 21 - KOSTENLOS mit Gästekarte):
Sternbräu, St. Peter (ältestes Restaurant Europas), Stieglkeller, Augustinerbräu (Bus 21 bis Landeskrankenhaus)`;
    }
    if (lang === 'chinese') {
        return `Hotel Vogelweiderhof 附近餐厅:

酒店旁边 (1-3分钟步行):

Smash to Go (餐车) - 酒店旁边，酒店客人15%折扣
Mr. Cevap - 步行1分钟，巴尔干烤肉
Gasthaus Turnerwirt - 步行3分钟，街对面，传统奥地利菜

Vogelweiderstraße沿线 (步行20分钟或乘120/121路巴士到Pauernfeindstraße站):
Restaurant Fuxn - 奥地利菜

市中心 (乘21路巴士15分钟 - 凭客人卡免费):
Sternbräu, St. Peter (欧洲最古老餐厅), Stieglkeller, Augustinerbräu (21路巴士到Landeskrankenhaus站)`;
    }
    return `Restaurants near Hotel Vogelweiderhof:

BESIDE THE HOTEL (1-3 min walk):
Smash to Go (Food Truck) - Beside hotel, 15% discount for hotel guests
Mr. Cevap - 1 min walk, Balkan grill
Gasthaus Turnerwirt - 3 min walk, across the street, traditional Austrian

ALONG VOGELWEIDERSTRASSE (20 min walk or Bus 120/121 to Pauernfeindstraße):
Restaurant Fuxn - Austrian cuisine

CITY CENTER (15 min by Bus 21 - FREE with Guest Ticket):
Sternbräu, St. Peter (oldest restaurant in Europe), Stieglkeller, Augustinerbräu (Bus 21 to Landeskrankenhaus)`;
}

// ========== SIGHTS INFORMATION ==========
function getSights(lang = 'english') {
    if (lang === 'german') {
        return `Sehenswürdigkeiten in Salzburg:

Das Stadtzentrum ist 15 Minuten mit dem Bus 21 entfernt (Richtung Fürstenbrunn). Ihre Gästekarte macht die Fahrt KOSTENLOS.

TOP SEHENSWÜRDIGKEITEN:
- Festung Hohensalzburg (größte erhaltene Burg Mitteleuropas)
- Schloss Mirabell & Mirabellgarten (barocker Palast, Eintritt frei)
- Mozarts Geburtshaus (Getreidegasse 9)
- Salzburger Dom (barocke Kathedrale)
- Getreidegasse (berühmte Einkaufsstraße)
- Schloss Hellbrunn (Wasserspiele) - Bus 25 ab Markartplatz
- Untersberg (1.853m mit Seilbahn) - Bus 25 ab Markartplatz
- Gaisberg (1.287m mit Panoramablick) - Bus 151 ab Mirabellplatz

RÜCKFAHRT: Bus 21 Richtung Bergheim bis Baron Schwarz Park`;
    }
    if (lang === 'chinese') {
        return `萨尔茨堡景点:

乘坐21路巴士15分钟即可到达市中心（方向Fürstenbrunn）。您的客人卡可免费乘坐。

顶级景点:
- 霍亨萨尔茨堡城堡（中欧最大的保存完好的城堡之一）
- 米拉贝尔宫及花园（巴洛克式宫殿，花园免费）
- 莫扎特出生地（Getreidegasse 9）
- 萨尔茨堡大教堂（巴洛克式大教堂）
- Getreidegasse购物街
- 海尔布伦宫（trick fountains）- 从Markartplatz乘25路巴士
- 翁特斯贝格山（1,853米缆车）- 从Markartplatz乘25路巴士
- 盖斯贝格山（1,287米全景）- 从Mirabellplatz乘151路巴士

返回酒店: 乘坐21路巴士方向Bergheim，在Baron Schwarz Park下车`;
    }
    return `Sights and Attractions in Salzburg:

The city center is 15 minutes away by Bus 21 (direction Fürstenbrunn). Your Guest Ticket makes this FREE.

TOP SIGHTS:
- Hohensalzburg Fortress (one of largest preserved castles in Europe)
- Mirabell Palace & Gardens (baroque palace, free gardens)
- Mozart's Birthplace (Getreidegasse 9)
- Salzburg Cathedral (baroque cathedral)
- Getreidegasse (famous shopping street)
- Hellbrunn Palace (trick fountains) - Bus 25 from Markartplatz
- Untersberg Mountain (1,853m cable car) - Bus 25 from Markartplatz
- Gaisberg Mountain (1,287m views) - Bus 151 from Mirabellplatz

RETURN TO HOTEL: Bus 21 direction Bergheim to Baron Schwarz Park`;
}

// ========== EVENT INFORMATION ==========
function getEvents(lang = 'english') {
    if (lang === 'german') {
        return `Veranstaltungen in Salzburg:

- Mozartwoche (Ende Januar)
- Osterfestspiele (März/April)
- Pfingstfestspiele (Mai/Juni)
- Salzburger Festspiele (Juli/August, 5 Wochen)
- Jazz & The City (5-tägiges Festival)
- Winterfest (Ende November bis Anfang Januar)
- Advent- und Christkindlmärkte (November/Dezember)

Details: www.salzburg.info/de/veranstaltungen`;
    }
    if (lang === 'chinese') {
        return `萨尔茨堡活动:

- 莫扎特周（一月底）
- 复活节音乐节（三月/四月）
- 圣灵降临节音乐节（五月/六月）
- 萨尔茨堡艺术节（七月/八月，5周）
- Jazz & The City（5天节日）
- Winterfest（十一月底至一月初）
- 圣诞市场（十一月/十二月）

详情：www.salzburg.info/zh/events`;
    }
    return `Upcoming Events in Salzburg:

- Mozart Week (late January)
- Easter Festival (March/April)
- Whitsun Festival (May/June)
- Salzburg Festival (July/August, 5 weeks)
- Jazz & The City (5 days)
- Winterfest (late November to early January)
- Christmas Markets (November/December)

Details: www.salzburg.info/en/events`;
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

async function getRealTimeDepartures(stationName, maxResults = 15, filterLine = null) {
    try {
        const station = await findStation(stationName);
        if (!station) {
            return null;
        }
        
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
        
        let results = journeys.slice(0, maxResults).map(jny => {
            const prod = common?.prodL?.[jny.prodX];
            const depTime = jny.stbStop?.dTimeS || "";
            const delay = jny.stbStop?.dTimeR ? parseInt(jny.stbStop.dTimeR) - parseInt(jny.stbStop.dTimeS) : 0;
            
            let line = prod?.name || prod?.line || "";
            let productType = prod?.type || "UNKNOWN";
            let productName = prod?.name || "";
            
            let busNumber = null;
            if (productType === "BUS") {
                const numberMatch = productName.match(/\b(\d{2,3})\b/);
                if (numberMatch) busNumber = numberMatch[1];
                const lineMatch = line.match(/\b(\d{2,3})\b/);
                if (lineMatch && !busNumber) busNumber = lineMatch[1];
            }
            
            let displayLine = line;
            if (productType === "BUS" && busNumber) {
                displayLine = `Bus ${busNumber}`;
            } else if (productType === "BUS") {
                displayLine = `Bus ${line}`;
            }
            
            return {
                line: displayLine,
                rawLine: line,
                busNumber: busNumber,
                productType: productType,
                direction: jny.dirTxt || "",
                departureTime: depTime ? `${depTime.slice(0,2)}:${depTime.slice(2,4)}` : "--:--",
                delay: delay
            };
        });
        
        if (filterLine) {
            const filterNum = filterLine.toString();
            results = results.filter(r => 
                r.busNumber === filterNum || 
                r.rawLine.includes(filterNum) ||
                r.line.includes(filterNum)
            );
        }
        
        return results.length > 0 ? results : null;
        
    } catch (error) {
        console.error('VAO API error:', error.message);
        return null;
    }
}

// ========== BUS KNOWLEDGE BASE ==========
const BUS_KNOWLEDGE = {
    fromHotel: {
        "21": { direction: "Fürstenbrunn", destination: "City Center", description: "Goes directly to Salzburg City Center", tips: "FREE with Guest Mobility Ticket" },
        "120": { direction: "Hauptbahnhof", destination: "Train Station", description: "Goes to main train station", tips: "Wave to driver to stop" },
        "121": { direction: "Hauptbahnhof", destination: "Train Station", description: "Goes to main train station", tips: "Wave to driver to stop" }
    },
    fromTrainStation: {
        "120": { direction: "Pelting", destination: "Hotel Vogelweiderhof", description: "Returns to hotel", tips: "Get off at Baron Schwarz Park" },
        "121": { direction: "Pelting", destination: "Hotel Vogelweiderhof", description: "Returns to hotel", tips: "Get off at Baron Schwarz Park" },
        "150": { direction: "Bad Ischl", destination: "Hallstatt Connection", description: "Take to Bad Ischl, then Bus 541 → Bus 543 to Hallstatt", tips: "Guest ticket valid only to Bad Ischl" },
        "840": { direction: "Jennerbahn", destination: "Königssee", description: "Get off at 'Königssee' stop for the lake", tips: "Bring passport (crosses to Germany)" },
        "151": { direction: "Gaisberg", destination: "Gaisberg Mountain", description: "Goes to Gaisberg viewpoint", tips: "Limited weekend service" }
    },
    fromMarkartplatz: {
        "25": { direction: "Untersbergbahn", destination: "Hellbrunn/Zoo/Untersberg", description: "Stops at Hellbrunn Palace, Zoo, Untersberg cable car", tips: "Perfect for day trips" }
    }
};

// ========== DESTINATION INFORMATION ==========
function getDestinationInfo(destination, lang = 'english') {
    const info = {
        "hallstatt": {
            english: "Take Bus 150 from Salzburg Hbf to Bad Ischl, then Bus 541 to Bus 543 to Hallstatt Lahn (directly at the lake). Train alternative: Train to Attnang-Puchheim to Hallstatt train to ferry. Guest Mobility Ticket valid only until Bad Ischl.",
            german: "Nehmen Sie den Bus 150 ab Salzburg Hbf nach Bad Ischl, dann Bus 541 zu Bus 543 nach Hallstatt Lahn (direkt am See). Zugalternative: Zug nach Attnang-Puchheim, dann Zug nach Hallstatt, dann Fähre. Gästekarte nur bis Bad Ischl gültig.",
            chinese: "从萨尔茨堡火车总站乘坐150路巴士到巴德伊舍，然后换乘541路巴士，再换乘543路巴士到哈尔施塔特Lahn站（湖边）。"
        },
        "königssee": {
            english: "Take Bus 840 from Salzburg Hbf. Get off at the stop 'Königssee' - this is the lake itself. The bus continues to Jennerbahn (cable car). Journey takes about 1 hour. Bring your passport as it crosses into Germany.",
            german: "Nehmen Sie den Bus 840 ab Salzburg Hbf. Steigen Sie an der Haltestelle 'Königssee' aus - das ist der See selbst. Die Fahrt dauert etwa 1 Stunde. Bringen Sie Ihren Reisepass mit.",
            chinese: "从萨尔茨堡火车总站乘坐840路巴士。在'国王湖'站下车 - 这就是湖本身。车程约1小时。请携带护照。"
        }
    };
    return info[destination]?.[lang] || info[destination]?.english || null;
}

// ========== CONVERSATION MEMORY ==========
const conversationMemory = new Map();
const userLanguagePreference = new Map();
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
        console.log(`FAQ loaded`);
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

// ========== LANGUAGE DETECTION ==========
function detectLanguage(text) {
    analytics.totalQuestions++;
    const normalizedQuestion = text.toLowerCase().replace(/[^\w\s]/g, '').substring(0, 100);
    analytics.mostAskedQuestions.set(normalizedQuestion, (analytics.mostAskedQuestions.get(normalizedQuestion) || 0) + 1);
    if (/[äöüß]/i.test(text)) return 'german';
    if (/[\u4e00-\u9fff]/.test(text)) return 'chinese';
    if (/[áéíóúñ¿¡]/i.test(text)) return 'spanish';
    if (/[àâçéèêëîïôûùüÿ]/i.test(text)) return 'french';
    return 'english';
}

// ========== INTENT DETECTION ==========
function detectIntent(question) {
    const lower = question.toLowerCase();
    
    if (lower.includes('wifi') || lower.includes('password') || lower.includes('internet') || lower.includes('network')) return 'wifi';
    if (/(wetter|weather|temp|temperatur|forecast|rain|snow|sun|cloud)/i.test(question)) return 'weather';
    if (/(currency|euro|dollar|exchange|convert|wechselkurs|umrechnen|usd|eur|gbp|chf|jpy|cny)/i.test(question)) return 'currency';
    if (/(time zone|what time is it|current time|local time|zeitzone|wie spät|uhrzeit)/i.test(question)) return 'timezone';
    if (lower.includes('restaurant') || lower.includes('eatery') || lower.includes('food') || lower.includes('eat')) return 'restaurants';
    if (lower.includes('sightseeing') || lower.includes('sehenswürdigkeiten') || lower.includes('attraction')) return 'sights';
    if (lower.includes('event') || lower.includes('festival') || lower.includes('konzert') || lower.includes('concert')) return 'events';
    
    if (lower.includes('hallstatt') || lower.includes('königssee') || lower.includes('koenigssee')) return 'destination';
    
    if (lower.includes('bus 21') || lower.includes('bus21')) return 'bus21_hotel';
    if (lower.includes('bus 120') || lower.includes('bus120')) return 'bus120_hotel';
    if (lower.includes('bus 121') || lower.includes('bus121')) return 'bus121_hotel';
    if (lower.includes('bus 150') || lower.includes('bus150')) return 'bus150_trainstation';
    if (lower.includes('bus 840') || lower.includes('bus840')) return 'bus840_trainstation';
    if (lower.includes('bus 151') || lower.includes('bus151')) return 'bus151_trainstation';
    if (lower.includes('bus 25') || lower.includes('bus25')) return 'bus25_markartplatz';
    
    return 'general';
}

// ========== GENERATE BUS RESPONSE WITH SCHEDULE ==========
async function generateBusResponse(busNumber, context, lang = 'english') {
    let stationToQuery = "";
    let busInfo = null;
    let location = "";
    let stationName = "";
    
    if (context === "hotel") {
        stationToQuery = "Baron Schwarz Park";
        stationName = "Baron Schwarz Park (your hotel bus stop)";
        busInfo = BUS_KNOWLEDGE.fromHotel[busNumber];
        location = "from your hotel";
    } else if (context === "trainstation") {
        stationToQuery = "Salzburg Hbf";
        stationName = "Salzburg Hauptbahnhof";
        busInfo = BUS_KNOWLEDGE.fromTrainStation[busNumber];
        location = "from the main train station";
    } else if (context === "markartplatz") {
        stationToQuery = "Markartplatz";
        stationName = "Markartplatz";
        busInfo = BUS_KNOWLEDGE.fromMarkartplatz[busNumber];
        location = "from Markartplatz";
    }
    
    const departures = await getRealTimeDepartures(stationToQuery, 10, busNumber);
    
    let response = "";
    
    if (busInfo) {
        response += `Bus ${busNumber} ${location}:\n`;
        response += `Destination: ${busInfo.destination}\n`;
        response += `Direction: ${busInfo.direction}\n`;
        response += `${busInfo.description}\n`;
        response += `Tip: ${busInfo.tips}\n\n`;
    }
    
    if (departures && departures.length > 0) {
        if (lang === 'german') {
            response += `Nächste Abfahrten von ${stationName}:\n`;
        } else if (lang === 'chinese') {
            response += `${stationName}的即将发车时间:\n`;
        } else {
            response += `Next departures from ${stationName}:\n`;
        }
        
        for (const dep of departures.slice(0, 6)) {
            const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : '';
            response += `${dep.departureTime}${delayText}\n`;
        }
        response += `\nFor real-time updates, check www.oebb.at or Google Maps.`;
    } else {
        if (lang === 'german') {
            response += `Keine aktuellen Abfahrten für Bus ${busNumber} gefunden. Bitte besuchen Sie www.oebb.at für Fahrplaninformationen.`;
        } else if (lang === 'chinese') {
            response += `未找到${busNumber}路巴士的实时班次。请访问www.oebb.at查看时刻表信息。`;
        } else {
            response += `No live departures found for Bus ${busNumber}. Please check www.oebb.at for schedule information.`;
        }
    }
    
    return response;
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
    
    if (!apiKey) return res.json({ reply: "API key missing. Please contact reception." });
    
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) return res.json({ reply: rateCheck.message });
    const topicCheck = isQuestionAllowed(userQuestion);
    if (!topicCheck.allowed) return res.json({ reply: topicCheck.reason });
    
    const faqContent = loadFAQs();
    let history = conversationMemory.get(clientIp) || [];
    let detectedLang = userLanguagePreference.get(clientIp);
    
    if (!detectedLang) {
        detectedLang = detectLanguage(userQuestion);
        userLanguagePreference.set(clientIp, detectedLang);
    }
    
    const isBookingQuestion = /book|price|cost|rate|availability/i.test(userQuestion);
    const intent = detectIntent(userQuestion);
    const lowerQuestion = userQuestion.toLowerCase();
    
    // ========== HARDCODED RESPONSES (with language support) ==========
    
    if (intent === 'wifi') {
        const reply = getWifiResponse(detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'weather') {
        let reply = await getWeather("Salzburg");
        if (!reply) {
            reply = detectedLang === 'german' ? "Wetterinformationen sind gerade nicht verfügbar. Bitte überprüfen Sie eine Wetter-App." :
                   detectedLang === 'chinese' ? "天气信息暂时不可用。请查看天气应用程序。" :
                   "Weather information is currently unavailable. Please check a weather app.";
        }
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply.substring(0, 500) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'currency') {
        let amount = 1;
        let from = "EUR";
        let to = "USD";
        
        const amountMatch = lowerQuestion.match(/(\d+(?:\.\d+)?)/);
        if (amountMatch) amount = parseFloat(amountMatch[1]);
        
        const currencyMatches = lowerQuestion.match(/\b(eur|usd|gbp|chf|jpy|cny|aud|cad|try|sek|nok|dkk|pln|czk)\b/gi);
        if (currencyMatches && currencyMatches.length >= 2) {
            from = currencyMatches[0].toUpperCase();
            to = currencyMatches[1].toUpperCase();
        }
        
        let reply = await convertCurrency(amount, from, to);
        if (!reply) {
            reply = detectedLang === 'german' ? "Währungsumrechnung ist gerade nicht verfügbar." :
                   detectedLang === 'chinese' ? "货币换算暂时不可用。" :
                   "Currency conversion is currently unavailable.";
        }
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'timezone') {
        const reply = getTimeZoneInfo(detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'restaurants') {
        const reply = getNearbyRestaurants(detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'sights') {
        const reply = getSights(detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'events') {
        const reply = getEvents(detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'destination') {
        let dest = null;
        if (lowerQuestion.includes('hallstatt')) dest = 'hallstatt';
        else if (lowerQuestion.includes('königssee') || lowerQuestion.includes('koenigssee')) dest = 'königssee';
        
        if (dest) {
            const info = getDestinationInfo(dest, detectedLang);
            if (info) {
                const reply = `Travel Information:\n\n${info}`;
                history.push({ role: "user", content: userQuestion.substring(0, 150) });
                history.push({ role: "assistant", content: reply });
                if (history.length > 10) history.splice(0, 2);
                conversationMemory.set(clientIp, history);
                return res.json({ reply: reply });
            }
        }
    }
    
    // ========== BUS RESPONSES ==========
    if (intent === 'bus21_hotel') {
        const reply = await generateBusResponse("21", "hotel", detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'bus120_hotel') {
        const reply = await generateBusResponse("120", "hotel", detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'bus121_hotel') {
        const reply = await generateBusResponse("121", "hotel", detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'bus150_trainstation') {
        const reply = await generateBusResponse("150", "trainstation", detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'bus840_trainstation') {
        const reply = await generateBusResponse("840", "trainstation", detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'bus151_trainstation') {
        const reply = await generateBusResponse("151", "trainstation", detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'bus25_markartplatz') {
        const reply = await generateBusResponse("25", "markartplatz", detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    // ========== USE DEEPSEEK AI FOR GENERAL QUESTIONS WITH FULL CONTEXT ==========
    const historyText = history.slice(-8).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    const isWeekend = isWeekendOrHoliday();
    const weekendNote = isWeekend ? "\n\nNote: Today is a weekend or public holiday. Bus schedules may have reduced service." : "";
    
    const languageInstructions = {
        english: "Respond in English. Be direct and helpful. Never end with questions. Use plain text only.",
        german: "Antworte auf Deutsch. Sei direkt und hilfreich. Beende Antworten niemals mit Fragen. Verwende nur Klartext.",
        chinese: "用中文回复。简洁直接。永远不要以问题结束。只使用纯文本。",
        spanish: "Responde en español. Sea directo y útil. Nunca termine las respuestas con preguntas. Use solo texto plano.",
        french: "Répondez en français. Soyez direct et utile. Ne terminez jamais les réponses par des questions. Utilisez uniquement du texte brut."
    };
    
    const systemPrompt = `You are a helpful hotel assistant at Hotel Vogelweiderhof in Salzburg.

HOTEL FAQ:
${faqContent}

BUS INFORMATION:
- From hotel (Baron Schwarz Park, 30m from hotel): Bus 21 to City Center (direction Fürstenbrunn) - FREE with Guest Mobility Ticket
- Bus 120/121 from hotel to Train Station (direction Hauptbahnhof)
- From Train Station: Bus 120/121 to hotel (direction Pelting), Bus 150 to Hallstatt (direction Bad Ischl), Bus 840 to Königssee (get off at "Königssee" stop), Bus 151 to Gaisberg
- From Markartplatz: Bus 25 to Hellbrunn, Zoo, Untersbergbahn
- Hallstatt route: Bus 150 to Bad Ischl, then Bus 541 to Bus 543 to Hallstatt Lahn

NEARBY RESTAURANTS:
- Smash to Go (beside hotel, 15% discount for hotel guests)
- Mr. Cevap (1 min walk)
- Gasthaus Turnerwirt (3 min walk)
- Restaurant Fuxn (20 min walk or Bus 120/121 to Pauernfeindstraße)

CITY CENTER RESTAURANTS (via Bus 21, FREE with Guest Ticket):
Sternbräu, St. Peter (oldest restaurant in Europe), Stieglkeller, Augustinerbräu

SIGHTS:
Hohensalzburg Fortress, Mirabell Palace, Mozart's Birthplace, Salzburg Cathedral, Hellbrunn Palace, Untersberg mountain (1,853m), Gaisberg mountain (1,287m)

CONVERSATION HISTORY (use this to understand context and follow-up questions):
${historyText}

GUEST: ${userQuestion}

IMPORTANT RULES:
- If the guest says "ja", "yes", "yep", "si", "oui", "是的", "是" - this means YES to your previous question
- If the previous question asked about bus schedules, provide the schedule
- Use the conversation history to understand what the guest is referring to
- Never end responses with questions unless asking for a simple yes/no
- Be warm, helpful, and conversational
${weekendNote}

${languageInstructions[detectedLang] || languageInstructions.english}`;

    try {
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: "deepseek-chat",
            messages: [{ role: "user", content: systemPrompt }],
            temperature: 0.6,
            max_tokens: limitsConfig.maxTokensPerResponse
        }, {
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
        history.push({ role: "assistant", content: reply.substring(0, 500) });
        if (history.length > 12) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        
        res.json({ reply: reply });
    } catch (error) {
        console.error('Chat error:', error.message);
        const errorReply = detectedLang === 'german' ? "Ich habe gerade technische Probleme. Bitte versuchen Sie es später noch einmal." :
                          detectedLang === 'chinese' ? "我遇到了一些技术问题。请稍后再试。" :
                          "I'm having technical difficulties. Please try again later.";
        res.json({ reply: errorReply });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Hotel Chat Bot running on port ${PORT}`);
    console.log(`📍 Hotel: Vogelweiderstraße 93/B, 5020 Salzburg`);
    console.log(`🚆 VAO/HAFAS API: ENABLED (real-time bus departures)`);
    console.log(`🌤️ Weather API: ENABLED (Open-Meteo)`);
    console.log(`💱 Currency API: ENABLED (Frankfurter/ECB)`);
    console.log(`📅 Weekend/holiday detection: ENABLED`);
    console.log(`🌍 Multi-language: English, German, Chinese, Spanish, French`);
    console.log(`💾 Conversation memory: ENABLED (remembers last 12 messages)`);
    console.log(`📋 FAQ loaded: ${loadFAQs() !== "No FAQ loaded" ? "YES" : "NO"}\n`);
});
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
function getWifiResponse() {
    return "The WiFi password is: internet (all lowercase). The network name is Vogelweiderhof.";
}

// ========== WEATHER API (Open-Meteo - Most Reliable Free Weather API) ==========
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
        
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,relative_humidity_2m,precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe/Vienna&forecast_days=3`;
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
        0: "Clear sky",
        1: "Mainly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Foggy",
        51: "Light drizzle",
        61: "Light rain",
        63: "Moderate rain",
        65: "Heavy rain",
        71: "Light snow",
        73: "Moderate snow",
        75: "Heavy snow",
        95: "Thunderstorm"
    };
    return descriptions[code] || "Unknown";
}

// ========== CURRENCY CONVERSION API (Frankfurter - ECB Official Data) ==========
async function convertCurrency(amount, from, to) {
    try {
        from = from.toUpperCase();
        to = to.toUpperCase();
        
        const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
        const response = await axios.get(url, { timeout: 8000 });
        
        if (response.data && response.data.rates) {
            const rate = response.data.rates[to];
            const converted = (amount * rate).toFixed(2);
            return `${amount} ${from} = ${converted} ${to}\nExchange rate: 1 ${from} = ${rate} ${to}\nData from European Central Bank (ECB)`;
        }
        return null;
    } catch (error) {
        console.log("Currency API error:", error.message);
        return null;
    }
}

// ========== TIME ZONE INFO (Built-in Node.js) ==========
function getTimeZoneInfo() {
    const now = new Date();
    const salzburgTime = now.toLocaleString('en-US', { timeZone: 'Europe/Vienna' });
    const isDST = isDaylightSavingTime(now);
    
    return `Current time in Salzburg: ${salzburgTime}\nTime zone: Central European Time (CET/CEST)\nDaylight Saving Time: ${isDST ? 'Active (UTC+2)' : 'Not active (UTC+1)'}\nSalzburg is 1 hour ahead of London, 6 hours ahead of New York.`;
}

function isDaylightSavingTime(date) {
    const jan = new Date(date.getFullYear(), 0, 1);
    const jul = new Date(date.getFullYear(), 6, 1);
    const stdTimezoneOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    return date.getTimezoneOffset() < stdTimezoneOffset;
}

// ========== RESTAURANTS NEAR HOTEL (ACCURATE) ==========
function getNearbyRestaurants() {
    return `Restaurants near Hotel Vogelweiderhof:

BESIDE THE HOTEL (1-3 min walk):

Smash to Go (Food Truck)
Location: Beside the hotel building on Vogelweiderstraße
Cuisine: Burgers
Special: 15% discount for hotel guests!

Mr. Cevap
Location: Next to the hotel, 1 min walk
Cuisine: Balkan grill
Note: Small inside but highly recommendable

Gasthaus Turnerwirt
Location: Opposite side of the main street
Distance: 3 min walk
Cuisine: Traditional Austrian

ALONG VOGELWEIDERSTRASSE (20 min walk or short bus ride):

Restaurant Fuxn
Location: Vogelweiderstraße
Cuisine: Austrian
Take Bus 120 or 121 to Pauernfeindstraße (direction Hauptbahnhof or Pelting)

CITY CENTER (15 min by Bus 21 - FREE with Guest Mobility Ticket):

Sternbräu
Cuisine: Traditional Austrian
Located in the heart of Salzburg's Old Town

St. Peter
Cuisine: Traditional Austrian
The oldest restaurant in Europe! Located at St. Peter's Abbey

Stieglkeller
Cuisine: Austrian with Stiegl beer
Located near the Old Town with views of the fortress

Augustinerbräu (Müllnerbräu)
Cuisine: Traditional Austrian, monastery brewery
Take Bus 21 to Landeskrankenhaus stop (just opposite the brewery)

HOW TO GET THERE:
From hotel: Bus 21 from Baron Schwarz Park (30m from hotel)
Direction to city center: Fürstenbrunn
Your Guest Mobility Ticket makes the bus FREE

Would you like Bus 21 departure times from the hotel?`;
}

// ========== SIGHTS & ATTRACTIONS ==========
function getSights() {
    return `Sights and Attractions in Salzburg:

There are no major sightseeing attractions within walking distance of Hotel Vogelweiderhof.

However, the city center is just 15 minutes away by Bus 21.

Take Bus 21 from Baron Schwarz Park bus stop (30 meters from the hotel).
Direction to look for: Fürstenbrunn

Your Guest Mobility Ticket makes this bus ride FREE for your entire stay.

TOP SIGHTS IN SALZBURG CITY CENTER:

Hohensalzburg Fortress (Festung Hohensalzburg)
One of the largest preserved castles in Central Europe. Take the FestungsBahn cable car from the Old Town.

Mirabell Palace & Gardens (Schloss Mirabell)
Beautiful baroque palace with stunning gardens. Free entry to gardens.

Mozart's Birthplace (Mozarts Geburtshaus)
Getreidegasse 9 - where Mozart was born in 1756.

Salzburg Cathedral (Salzburger Dom)
Stunning baroque cathedral at Domplatz.

Getreidegasse
Famous shopping street with traditional wrought-iron signs.

Hellbrunn Palace (Schloss Hellbrunn)
Famous for trick fountains. Take Bus 25 from Markartplatz.

Untersberg Mountain
At 1,853m with cable car. Take Bus 25 from Markartplatz to Untersbergbahn.

Gaisberg Mountain
At 1,287m with panoramic views. Take Bus 151 from Mirabellplatz.

HOW TO RETURN TO HOTEL:
Take Bus 21 from city center with direction Bergheim
Get off at Baron Schwarz Park

Would you like Bus 21 departure times from the hotel?`;
}

// ========== EVENTS CALENDAR ==========
function getEvents() {
    return `Upcoming Events in Salzburg (from official Salzburg Tourism):

Mozart Week
When: Late January (around Mozart's birthday, Jan 27)
One of the major musical highlights in Salzburg.

Salzburg Easter Festival (Osterfestspiele)
When: Saturday before Palm Sunday through Easter Monday
Founded by Herbert von Karajan in 1967.

Salzburg Whitsun Festival (Pfingstfestspiele)
When: Whit Saturday to Whit Monday (May/June)
Classical music festival featuring international orchestras.

Sommerszene Festival
When: Summer
Contemporary dance, theatre, performance, and installations.

Salzburg Festival (Salzburger Festspiele)
When: 5 weeks from late July to August
World-renowned celebration of music and drama.

Jazz & The City
When: 5 days festival
Jazz and electronic music at unusual venues.

Winterfest
When: End of November to early January
One of the biggest modern circus festivals.

Salzburg Advent Singing & Christmas Markets
When: Advent season (November-December)
Christkindlmarkt on Cathedral and Residenzplatz squares.

For exact dates and tickets, please visit www.salzburg.info/en/events.`;
}

// ========== HOTEL BUS KNOWLEDGE BASE ==========
const BUS_KNOWLEDGE = {
    fromHotel: {
        "21": {
            direction: "Fürstenbrunn",
            destination: "City Center",
            description: "Goes directly to Salzburg City Center. Your Guest Mobility Ticket makes this FREE!",
            tips: "Direction to look for: Fürstenbrunn. Bus stop is 30 meters from hotel."
        },
        "120": {
            direction: "Hauptbahnhof",
            destination: "Salzburg Main Train Station",
            description: "Goes to the main train station. Also passes Restaurant Fuxn (get off at Pauernfeindstraße)",
            tips: "Wave to the driver to stop! Direction: Hauptbahnhof"
        },
        "121": {
            direction: "Hauptbahnhof",
            destination: "Salzburg Main Train Station",
            description: "Goes to the main train station (same route as 120)",
            tips: "Wave to the driver to stop! Direction: Hauptbahnhof"
        }
    },
    fromCityCenter: {
        "21": {
            direction: "Bergheim",
            destination: "Hotel Vogelweiderhof",
            description: "Returns to the hotel area",
            tips: "Direction to look for: Bergheim. Get off at Baron Schwarz Park"
        }
    },
    fromTrainStation: {
        "120": {
            direction: "Pelting",
            destination: "Hotel Vogelweiderhof",
            description: "Stops at Baron Schwarz Park (your hotel)",
            tips: "Direction: Pelting. Get off at Baron Schwarz Park"
        },
        "121": {
            direction: "Pelting",
            destination: "Hotel Vogelweiderhof",
            description: "Stops at Baron Schwarz Park (your hotel)",
            tips: "Direction: Pelting. Get off at Baron Schwarz Park"
        },
        "150": {
            direction: "Bad Ischl",
            destination: "Hallstatt Connection",
            description: "Important bus for Hallstatt",
            tips: "Take Bus 150 to Bad Ischl, then Bus 541 to Bus 543 to Hallstatt Lahn"
        },
        "840": {
            direction: "Jennerbahn",
            destination: "Königssee (Germany)",
            description: "Goes to Königssee in Bavaria, Germany",
            tips: "Perfect for visiting Königssee lake. Bring your passport!"
        },
        "151": {
            direction: "Gaisberg",
            destination: "Gaisberg Mountain",
            description: "Goes to Gaisberg viewpoint",
            tips: "Great for hiking. Departs from Mirabellplatz. Limited service on weekends!"
        }
    },
    fromMarkartplatz: {
        "25": {
            direction: "Untersbergbahn",
            destination: "Untersberg Cable Car",
            description: "Goes to Schloss Hellbrunn, Salzburg Zoo, and Untersbergbahn",
            tips: "Stops at Hellbrunn Palace (trick fountains), Zoo Salzburg, Untersbergbahn cable car"
        }
    }
};

// ========== DESTINATION INFO ==========
function getDestinationInfo(destination) {
    const info = {
        "hallstatt": "Take Bus 150 from Salzburg Hbf to Bad Ischl, then Bus 541 to Bus 543 to Hallstatt Lahn (directly at the lake). Train alternative: Train to Attnang-Puchheim to Hallstatt train to ferry. Guest Mobility Ticket valid only until Bad Ischl.",
        "königssee": "Take Bus 840 from Salzburg Hbf to Jennerbahn. Journey takes about 1 hour. Bring your passport as it crosses into Germany. The lake is stunning with emerald-green water.",
        "gaisberg": "Take Bus 151 from Mirabellplatz to Gaisbergspitze. At 1,287m, it offers amazing views of Salzburg and the Alps. Limited service on weekends.",
        "untersberg": "Take Bus 25 from Markartplatz to Untersbergbahn. The cable car takes you to 1,853m with a 360° view.",
        "hellbrunn": "Take Bus 25 from Markartplatz to Schloss Hellbrunn. Famous for trick fountains - a must-see!",
        "zoo": "Take Bus 25 from Markartplatz to Zoo Salzburg. Home to over 150 species."
    };
    return info[destination] || null;
}

// ========== VAO/HAFAS API ==========
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
            console.log(`Station "${stationName}" not found`);
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

// ========== GENERATE BUS RESPONSE ==========
async function generateBusResponse(busNumber, context = "hotel") {
    const isWeekend = isWeekendOrHoliday();
    const dayType = isWeekend ? " (Weekend/Holiday Schedule)" : " (Weekday Schedule)";
    
    let stationToQuery = "";
    let busInfo = null;
    let location = "";
    
    if (context === "hotel") {
        stationToQuery = "Baron Schwarz Park";
        if (busNumber === "21") busInfo = BUS_KNOWLEDGE.fromHotel["21"];
        else if (busNumber === "120") busInfo = BUS_KNOWLEDGE.fromHotel["120"];
        else if (busNumber === "121") busInfo = BUS_KNOWLEDGE.fromHotel["121"];
        location = "Baron Schwarz Park (your hotel bus stop, 30m from hotel)";
    } else if (context === "trainstation") {
        stationToQuery = "Salzburg Hbf";
        if (busNumber === "150") busInfo = BUS_KNOWLEDGE.fromTrainStation["150"];
        else if (busNumber === "840") busInfo = BUS_KNOWLEDGE.fromTrainStation["840"];
        else if (busNumber === "151") busInfo = BUS_KNOWLEDGE.fromTrainStation["151"];
        else if (busNumber === "120") busInfo = BUS_KNOWLEDGE.fromTrainStation["120"];
        else if (busNumber === "121") busInfo = BUS_KNOWLEDGE.fromTrainStation["121"];
        location = "Salzburg Hauptbahnhof (Main Train Station)";
    } else if (context === "citycenter") {
        stationToQuery = "Hanuschplatz";
        if (busNumber === "21") busInfo = BUS_KNOWLEDGE.fromCityCenter["21"];
        location = "City Center (e.g., Hanuschplatz)";
    } else if (context === "markartplatz") {
        stationToQuery = "Markartplatz";
        if (busNumber === "25") busInfo = BUS_KNOWLEDGE.fromMarkartplatz["25"];
        location = "Markartplatz";
    }
    
    const departures = await getRealTimeDepartures(stationToQuery, 15, busNumber);
    
    let response = "";
    
    if (isWeekend) {
        response += "Note: Today is a weekend or public holiday. Buses run less frequently than weekdays.\n\n";
    }
    
    if (busInfo) {
        response += `Bus ${busNumber} from ${location}${dayType}\n\n`;
        response += `Destination: ${busInfo.destination}\n`;
        response += `Direction: ${busInfo.direction}\n`;
        response += `${busInfo.description}\n`;
        response += `Tip: ${busInfo.tips}\n\n`;
    }
    
    if (departures && departures.length > 0) {
        response += `Live departures today:\n`;
        for (const dep of departures.slice(0, 8)) {
            const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : '';
            response += `${dep.departureTime}${delayText}\n`;
        }
        response += `\nFor real-time updates, check www.oebb.at or Google Maps.\n`;
    } else {
        response += `No live departures found in the next hour. Please check www.oebb.at for schedule information.\n`;
    }
    
    if (isWeekend) {
        response += `\nWeekend/Holiday Reminder: Buses may have reduced service. Always check live departures above.`;
    }
    
    return response;
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
    return 'english';
}

// ========== INTENT DETECTION ==========
function detectIntent(question) {
    const lower = question.toLowerCase();
    
    // WiFi detection
    if (lower.includes('wifi') || lower.includes('password') || lower.includes('internet') || lower.includes('network')) {
        return 'wifi';
    }
    
    // Weather detection
    if (/(wetter|weather|temp|temperatur|forecast|rain|snow|sun|cloud)/i.test(question)) return 'weather';
    
    // Currency detection
    if (/(currency|euro|dollar|exchange|convert|wechselkurs|umrechnen|usd|eur|gbp|chf|jpy|cny)/i.test(question)) return 'currency';
    
    // Time zone detection
    if (/(time zone|what time is it|current time|local time|zeitzone|wie spät|uhrzeit)/i.test(question)) return 'timezone';
    
    // Restaurant detection
    if (lower.includes('restaurant') || lower.includes('eatery') || lower.includes('food') || 
        lower.includes('eat') || lower.includes('dinner') || lower.includes('lunch') || 
        lower.includes('breakfast') || lower.includes('gastronomy') || lower.includes('cuisine')) {
        return 'restaurants';
    }
    
    // Sightseeing detection
    if (lower.includes('sightseeing') || lower.includes('sehenswürdigkeiten') || 
        lower.includes('attraction') || lower.includes('what to see') || 
        (lower.includes('visit') && (lower.includes('salzburg') || lower.includes('city'))) ||
        lower.includes('fortress') || lower.includes('festung') || lower.includes('mirabell') ||
        lower.includes('mozart') || lower.includes('cathedral') || lower.includes('dom')) {
        return 'sights';
    }
    
    // Events detection
    if (lower.includes('event') || lower.includes('festival') || lower.includes('konzert') || 
        lower.includes('concert') || lower.includes('mozart week') || lower.includes('easter festival') || 
        lower.includes('whitsun') || lower.includes('summer festival') || lower.includes('christmas market')) {
        return 'events';
    }
    
    // Destination detection
    if (lower.includes('hallstatt') || lower.includes('königssee') || lower.includes('koenigssee') || 
        lower.includes('gaisberg') || lower.includes('untersberg') || lower.includes('hellbrunn') || lower.includes('zoo')) {
        return 'destination';
    }
    
    // Bus detection
    if (lower.includes('bus 150') || lower.includes('bus150')) return 'bus150_trainstation';
    if (lower.includes('bus 840') || lower.includes('bus840')) return 'bus840_trainstation';
    if (lower.includes('bus 151') || lower.includes('bus151')) return 'bus151_trainstation';
    if (lower.includes('bus 25') || lower.includes('bus25')) return 'bus25_markartplatz';
    
    if (lower.includes('bus 21') || lower.includes('bus21')) {
        if (lower.includes('from city') || lower.includes('from hanusch') || lower.includes('back to hotel')) {
            return 'bus21_citycenter';
        }
        return 'bus21_hotel';
    }
    
    if (lower.includes('bus 120') || lower.includes('bus120')) {
        if (lower.includes('from train') || lower.includes('from hbf')) {
            return 'bus120_trainstation';
        }
        return 'bus120_hotel';
    }
    
    if (lower.includes('bus 121') || lower.includes('bus121')) {
        if (lower.includes('from train') || lower.includes('from hbf')) {
            return 'bus121_trainstation';
        }
        return 'bus121_hotel';
    }
    
    return 'general';
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
    const lowerQuestion = userQuestion.toLowerCase();
    
    // ========== HARDCODED WIFI RESPONSE ==========
    if (intent === 'wifi') {
        const wifiReply = getWifiResponse();
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: wifiReply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: wifiReply });
    }
    
    // ========== WEATHER ==========
    if (intent === 'weather') {
        let weatherReply = await getWeather("Salzburg");
        if (!weatherReply) {
            weatherReply = "Weather information is currently unavailable. Please check a weather app for Salzburg forecast.";
        }
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: weatherReply.substring(0, 500) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: weatherReply });
    }
    
    // ========== CURRENCY CONVERSION ==========
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
        } else if (lowerQuestion.includes('to usd')) {
            from = "EUR";
            to = "USD";
        } else if (lowerQuestion.includes('to eur')) {
            from = "USD";
            to = "EUR";
        }
        
        let currencyReply = await convertCurrency(amount, from, to);
        if (!currencyReply) {
            currencyReply = `Currency conversion is currently unavailable. Please try asking like "convert 50 EUR to USD" or check www.xe.com.`;
        }
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: currencyReply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: currencyReply });
    }
    
    // ========== TIME ZONE ==========
    if (intent === 'timezone') {
        const timezoneReply = getTimeZoneInfo();
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: timezoneReply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: timezoneReply });
    }
    
    // ========== RESTAURANTS ==========
    if (intent === 'restaurants') {
        const reply = getNearbyRestaurants();
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    // ========== SIGHTS ==========
    if (intent === 'sights') {
        const reply = getSights();
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    // ========== EVENTS ==========
    if (intent === 'events') {
        const reply = getEvents();
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    // ========== DESTINATION INFO ==========
    if (intent === 'destination') {
        let info = null;
        if (lowerQuestion.includes('hallstatt')) info = getDestinationInfo('hallstatt');
        else if (lowerQuestion.includes('königssee') || lowerQuestion.includes('koenigssee')) info = getDestinationInfo('königssee');
        else if (lowerQuestion.includes('gaisberg')) info = getDestinationInfo('gaisberg');
        else if (lowerQuestion.includes('untersberg')) info = getDestinationInfo('untersberg');
        else if (lowerQuestion.includes('hellbrunn')) info = getDestinationInfo('hellbrunn');
        else if (lowerQuestion.includes('zoo')) info = getDestinationInfo('zoo');
        
        if (info) {
            const response = `Travel Information:\n\n${info}`;
            history.push({ role: "user", content: userQuestion.substring(0, 150) });
            history.push({ role: "assistant", content: response.substring(0, 300) });
            if (history.length > 10) history.splice(0, 2);
            conversationMemory.set(clientIp, history);
            return res.json({ reply: response });
        }
    }
    
    // ========== BUS QUERIES ==========
    if (intent === 'bus21_hotel') {
        const response = await generateBusResponse("21", "hotel");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus21_citycenter') {
        const response = await generateBusResponse("21", "citycenter");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus120_hotel') {
        const response = await generateBusResponse("120", "hotel");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus120_trainstation') {
        const response = await generateBusResponse("120", "trainstation");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus121_hotel') {
        const response = await generateBusResponse("121", "hotel");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus121_trainstation') {
        const response = await generateBusResponse("121", "trainstation");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus150_trainstation') {
        const response = await generateBusResponse("150", "trainstation");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus840_trainstation') {
        const response = await generateBusResponse("840", "trainstation");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus151_trainstation') {
        const response = await generateBusResponse("151", "trainstation");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    if (intent === 'bus25_markartplatz') {
        const response = await generateBusResponse("25", "markartplatz");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: response.substring(0, 300) });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: response });
    }
    
    // ========== USE DEEPSEEK AI FOR GENERAL QUESTIONS ==========
    const languageInstructions = {
        english: "RESPOND IN ENGLISH. Be direct and helpful. Never end with questions. Do not use markdown formatting like **bold** or *italics*. Use plain text only with line breaks.",
        german: "ANTWORTE AUF DEUTSCH. Seien Sie direkt und hilfreich. Beenden Sie Antworten niemals mit Fragen. Verwenden Sie keine Markdown-Formatierung.",
        chinese: "用中文回复。简洁直接。永远不要以问题结束。不要使用markdown格式。"
    };
    
    const isWeekend = isWeekendOrHoliday();
    const weekendNote = isWeekend ? "\n\nNote: Today is a weekend or public holiday. Bus schedules may have reduced service." : "";
    
    const systemPrompt = `You are a hotel assistant at Hotel Vogelweiderhof (Vogelweiderstraße 93/B, 5020 Salzburg).

HOTEL FAQ:
${faqContent}

IMPORTANT BUS INFORMATION:
- From hotel (Baron Schwarz Park, 30m from hotel): Bus 21 to City Center (direction Fürstenbrunn). Your Guest Mobility Ticket makes this FREE!
- Bus 120/121 from hotel to Train Station (direction Hauptbahnhof). Also passes Restaurant Fuxn (get off at Pauernfeindstraße)
- From Train Station: Bus 120/121 to hotel (direction Pelting), Bus 150 to Hallstatt (direction Bad Ischl), Bus 840 to Königssee (direction Jennerbahn)
- From City Center back to hotel: Bus 21 (direction Bergheim)
- From Markartplatz: Bus 25 to Hellbrunn, Zoo, Untersbergbahn
- Hallstatt route: Bus 150 to Bad Ischl, then Bus 541 to Bus 543 to Hallstatt Lahn

NEARBY RESTAURANTS (from hotel):
- Smash to Go (food truck beside hotel, 15% discount for hotel guests)
- Mr. Cevap (1 min walk, Balkan grill)
- Gasthaus Turnerwirt (3 min walk, Austrian)
- Restaurant Fuxn (20 min walk or Bus 120/121 to Pauernfeindstraße)

CITY CENTER RESTAURANTS (via Bus 21, FREE with Guest Mobility Ticket):
- Sternbräu, St. Peter (oldest restaurant in Europe), Stieglkeller, Augustinerbräu (Bus 21 to Landeskrankenhaus)

CRITICAL RULES:
- Never end responses with questions
- Never say "feel free to ask" or "would you like more details"
- Be warm and helpful, then stop
- Do not use any markdown formatting like asterisks, bold, or italics
- Give plain text responses only with line breaks
${weekendNote}

${languageInstructions[detectedLang] || languageInstructions.english}

PREVIOUS CONVERSATION:
${historyText || "None"}

GUEST: ${userQuestion}`;

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
    console.log(`\nHotel Chat Bot running on port ${PORT}`);
    console.log(`Hotel: Vogelweiderstraße 93/B, 5020 Salzburg`);
    console.log(`VAO/HAFAS API: ENABLED (real-time bus/train departures)`);
    console.log(`Weather API: ENABLED (Open-Meteo)`);
    console.log(`Currency API: ENABLED (Frankfurter/ECB)`);
    console.log(`Restaurants: Hardcoded with accurate locations`);
    console.log(`Sights: Via Bus 21 to city center`);
    console.log(`Weekend/holiday detection: ENABLED`);
    console.log(`FAQ loaded: ${loadFAQs() !== "No FAQ loaded" ? "YES" : "NO"}\n`);
});
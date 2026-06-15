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

function isWeekendOrHoliday() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    return (dayOfWeek === 0 || dayOfWeek === 6);
}

// ========== LANGUAGE DETECTION ==========
function detectLanguage(text) {
    analytics.totalQuestions++;
    
    if (/[äöüß]/i.test(text)) return 'german';
    if (/(wie|was|wo|wann|warum|ich|du|sie|wir|mir|dich|kann|mag|möchte|bitte|danke|guten|tag|morgen|abend|hallo|tschüss|straße|platz|bahn|bus|hotel|zimmer|preis|kosten|reservierung|frühstück|check-in|check-out|welche|welcher|welches|dem|den|der|die|das|eine|einen|einem|einer|kein|keine|wann|kommt|nächste|nächsten|abfahrtszeiten)/i.test(text)) return 'german';
    if (/[\u4e00-\u9fff]/.test(text)) return 'chinese';
    
    return 'english';
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

async function getRealTimeDepartures(stationName, maxResults = 20, filterLine = null) {
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
            
            // Extract bus number from various formats
            let busNumber = null;
            const numberMatch = productName.match(/\b(\d{2,3})\b/);
            if (numberMatch) busNumber = numberMatch[1];
            const lineMatch = line.match(/\b(\d{2,3})\b/);
            if (lineMatch && !busNumber) busNumber = lineMatch[1];
            
            return {
                line: line,
                busNumber: busNumber,
                direction: jny.dirTxt || "",
                departureTime: depTime ? `${depTime.slice(0,2)}:${depTime.slice(2,4)}` : "--:--",
                delay: delay
            };
        });
        
        // Filter by specific bus number if requested
        if (filterLine) {
            const filterNum = filterLine.toString();
            results = results.filter(r => r.busNumber === filterNum);
        }
        
        return results;
        
    } catch (error) {
        console.error('VAO API error:', error.message);
        return null;
    }
}

// ========== FILTERED BUS RESPONSES ==========

async function getBus21Schedule(lang = 'english') {
    const station = "Baron Schwarz Park";
    const allDepartures = await getRealTimeDepartures(station, 30, "21");
    
    if (!allDepartures || allDepartures.length === 0) {
        if (lang === 'german') {
            return `Keine live Abfahrten für Bus 21 in der nächsten Stunde gefunden. Bitte besuchen Sie www.oebb.at für den Fahrplan.`;
        }
        return `No live departures for Bus 21 found in the next hour. Please check www.oebb.at for schedule information.`;
    }
    
    // Split departures by direction
    const cityCenterBuses = [];
    const otherBuses = [];
    
    for (const dep of allDepartures) {
        const dir = dep.direction.toLowerCase();
        // Fürstenbrunn is city center direction from hotel
        if (dir.includes('fürstenbrunn')) {
            cityCenterBuses.push(dep);
        } else {
            otherBuses.push(dep);
        }
    }
    
    if (lang === 'german') {
        let response = `Bus 21 - Nächste Abfahrten von Baron Schwarz Park (Ihr Hotel):\n\n`;
        
        response += `🚍 Richtung Stadtzentrum (Fürstenbrunn):\n`;
        if (cityCenterBuses.length > 0) {
            for (const dep of cityCenterBuses.slice(0, 6)) {
                const delayText = dep.delay > 0 ? ` (${dep.delay} Min Verspätung)` : '';
                response += `   ${dep.departureTime}${delayText}\n`;
            }
        } else {
            response += `   Keine Abfahrten in der nächsten Stunde\n`;
        }
        
        response += `\n🚍 Andere Richtungen:\n`;
        if (otherBuses.length > 0) {
            for (const dep of otherBuses.slice(0, 4)) {
                const delayText = dep.delay > 0 ? ` (${dep.delay} Min Verspätung)` : '';
                // Clean up direction names
                let direction = dep.direction;
                if (direction.includes('Bergheim')) direction = 'Bergheim (zurück zum Hotel)';
                if (direction.includes('Hauptbahnhof')) direction = 'Hauptbahnhof';
                response += `   ${dep.departureTime}${delayText} - ${direction}\n`;
            }
        } else {
            response += `   Keine weiteren Abfahrten in der nächsten Stunde\n`;
        }
        
        response += `\nIhre Gästekarte macht die Fahrt KOSTENLOS.\n`;
        response += `Für Bus 21 Richtung Stadtzentrum: Richtung Fürstenbrunn`;
        return response;
    }
    
    // English version
    let response = `Bus 21 - Next departures from Baron Schwarz Park (your hotel):\n\n`;
    
    response += `🚍 Towards City Center (Fürstenbrunn):\n`;
    if (cityCenterBuses.length > 0) {
        for (const dep of cityCenterBuses.slice(0, 6)) {
            const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : '';
            response += `   ${dep.departureTime}${delayText}\n`;
        }
    } else {
        response += `   No departures in the next hour\n`;
    }
    
    response += `\n🚍 Other directions:\n`;
    if (otherBuses.length > 0) {
        for (const dep of otherBuses.slice(0, 4)) {
            const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : '';
            let direction = dep.direction;
            if (direction.includes('Bergheim')) direction = 'Bergheim (back to hotel)';
            if (direction.includes('Hauptbahnhof')) direction = 'Hauptbahnhof';
            response += `   ${dep.departureTime}${delayText} - ${direction}\n`;
        }
    } else {
        response += `   No other departures in the next hour\n`;
    }
    
    response += `\nYour Guest Mobility Ticket makes the ride FREE.\n`;
    response += `For Bus 21 towards city center: look for direction Fürstenbrunn`;
    return response;
}

async function getBus120Schedule(lang = 'english') {
    const station = "Baron Schwarz Park";
    const allDepartures = await getRealTimeDepartures(station, 20, "120");
    
    if (!allDepartures || allDepartures.length === 0) {
        if (lang === 'german') {
            return `Keine live Abfahrten für Bus 120 in der nächsten Stunde gefunden. Bitte besuchen Sie www.oebb.at für den Fahrplan.`;
        }
        return `No live departures for Bus 120 found in the next hour. Please check www.oebb.at for schedule information.`;
    }
    
    // Filter for train station direction (Hauptbahnhof)
    const trainStationBuses = [];
    const otherBuses = [];
    
    for (const dep of allDepartures) {
        const dir = dep.direction.toLowerCase();
        if (dir.includes('hauptbahnhof') || dir.includes('hbf')) {
            trainStationBuses.push(dep);
        } else {
            otherBuses.push(dep);
        }
    }
    
    if (lang === 'german') {
        let response = `Bus 120 - Nächste Abfahrten von Baron Schwarz Park (Ihr Hotel):\n\n`;
        
        response += `🚍 Richtung Hauptbahnhof (Train Station):\n`;
        if (trainStationBuses.length > 0) {
            for (const dep of trainStationBuses.slice(0, 6)) {
                const delayText = dep.delay > 0 ? ` (${dep.delay} Min Verspätung)` : '';
                response += `   ${dep.departureTime}${delayText}\n`;
            }
        } else {
            response += `   Keine Abfahrten in der nächsten Stunde\n`;
        }
        
        if (otherBuses.length > 0) {
            response += `\n🚍 Andere Richtungen:\n`;
            for (const dep of otherBuses.slice(0, 3)) {
                const delayText = dep.delay > 0 ? ` (${dep.delay} Min Verspätung)` : '';
                response += `   ${dep.departureTime}${delayText} - ${dep.direction}\n`;
            }
        }
        
        response += `\n⚠️ Wichtig: Winken Sie dem Bus zu, da er nicht automatisch an jeder Haltestelle hält.\n`;
        response += `Ihre Gästekarte macht die Fahrt KOSTENLOS.`;
        return response;
    }
    
    // English version
    let response = `Bus 120 - Next departures from Baron Schwarz Park (your hotel):\n\n`;
    
    response += `🚍 Towards Hauptbahnhof (Train Station):\n`;
    if (trainStationBuses.length > 0) {
        for (const dep of trainStationBuses.slice(0, 6)) {
            const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : '';
            response += `   ${dep.departureTime}${delayText}\n`;
        }
    } else {
        response += `   No departures in the next hour\n`;
    }
    
    if (otherBuses.length > 0) {
        response += `\n🚍 Other directions:\n`;
        for (const dep of otherBuses.slice(0, 3)) {
            const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : '';
            response += `   ${dep.departureTime}${delayText} - ${dep.direction}\n`;
        }
    }
    
    response += `\n⚠️ Important: Wave to the driver as the bus does not stop automatically.\n`;
    response += `Your Guest Mobility Ticket makes the ride FREE.`;
    return response;
}

function getBus121Schedule(lang = 'english') {
    // Bus 121 has same route as 120
    return getBus120Schedule(lang);
}

// ========== WEATHER API ==========
async function getWeather(city = "Salzburg", lang = 'english') {
    try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
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
        
        if (lang === 'german') {
            let response = `Aktuelles Wetter in ${location.name}:\n`;
            response += `${current.temperature}°C, ${weatherCodes[current.weathercode] || "Unbekannt"}\n`;
            response += `Wind: ${current.windspeed} km/h\n\n`;
            response += `3-Tage-Vorhersage:\n`;
            for (let i = 0; i < daily.time.length && i < 3; i++) {
                const day = new Date(daily.time[i]);
                const dayName = day.toLocaleDateString('de-DE', { weekday: 'short' });
                response += `${dayName}: Max ${daily.temperature_2m_max[i]}°C / Min ${daily.temperature_2m_min[i]}°C\n`;
            }
            return response;
        }
        
        let response = `Current weather in ${location.name}:\n`;
        response += `${current.temperature}°C, ${weatherCodes[current.weathercode] || "Unknown"}\n`;
        response += `Wind: ${current.windspeed} km/h\n\n`;
        response += `3-Day Forecast:\n`;
        for (let i = 0; i < daily.time.length && i < 3; i++) {
            const day = new Date(daily.time[i]);
            const dayName = day.toLocaleDateString('en-US', { weekday: 'short' });
            response += `${dayName}: High ${daily.temperature_2m_max[i]}°C / Low ${daily.temperature_2m_min[i]}°C\n`;
        }
        return response;
    } catch (error) {
        console.log("Weather API error:", error.message);
        return null;
    }
}

// ========== STATIC RESPONSES ==========
function getCityCenterRoute(lang) {
    if (lang === 'german') {
        return `So erreichen Sie das Stadtzentrum vom Hotel Vogelweiderhof:

Mit dem Bus (empfohlen):
Nehmen Sie den Bus 21 ab der Haltestelle Baron Schwarz Park (30 Meter vom Hotel)
Richtung: Fürstenbrunn
Fahrzeit: 15 Minuten
Kosten: KOSTENLOS mit Ihrer Gästekarte

Zu Fuß:
Entfernung: 2-2,5 km
Zeit: 30-45 Minuten
Route: Folgen Sie der Vogelweiderstraße Richtung Stadtzentrum, am Ende biegen Sie rechts ab.

Für live Abfahrtszeiten des Bus 21 fragen Sie einfach nach "Bus 21 Fahrplan".`;
    }
    
    return `To reach the city center from Hotel Vogelweiderhof:

By Bus (recommended):
Take Bus 21 from Baron Schwarz Park bus stop (30 meters from the hotel)
Direction: Fürstenbrunn
Travel time: 15 minutes
Cost: FREE with your Guest Mobility Ticket

By Walking:
Distance: 2-2.5 km
Time: 30-45 minutes
Route: Follow Vogelweiderstraße towards the city center, at the end turn right.

For live Bus 21 departure times, just ask for "Bus 21 schedule".`;
}

function getWifiResponse(lang) {
    if (lang === 'german') {
        return "Das WLAN-Passwort lautet: internet (alles kleingeschrieben). Der Netzwerkname ist Vogelweiderhof.";
    }
    return "The WiFi password is: internet (all lowercase). The network name is Vogelweiderhof.";
}

function getRestaurants(lang) {
    if (lang === 'german') {
        return `Restaurants in der Nähe des Hotel Vogelweiderhof:

DIREKT BEIM HOTEL (1-3 Gehminuten):
Smash to Go - Food Truck neben dem Hotel, 15% Rabatt für Hotelgäste
Mr. Cevap - 1 Gehminute, Osteuropäische Grillrestaurant
Gasthaus Turnerwirt - 3 Gehminuten, traditionelle österreichische Küche

STADTZENTRUM (15 Minuten mit Bus 21, KOSTENLOS mit Gästekarte):
Sternbräu, St. Peter (ältestes Restaurant Europas), Stieglkeller, Augustinerbräu`;
    }
    return `Restaurants near Hotel Vogelweiderhof:

BESIDE THE HOTEL (1-3 min walk):
Smash to Go - Food truck beside hotel, 15% discount for hotel guests
Mr. Cevap - 1 min walk, Balkan grill
Gasthaus Turnerwirt - 3 min walk, traditional Austrian cuisine

CITY CENTER (15 minutes by Bus 21, FREE with Guest Mobility Ticket):
Sternbräu, St. Peter (oldest restaurant in Europe), Stieglkeller, Augustinerbräu`;
}

function getSights(lang) {
    if (lang === 'german') {
        return `Sehenswürdigkeiten in Salzburg (15 Minuten mit Bus 21 vom Hotel, KOSTENLOS mit Gästekarte):

Festung Hohensalzburg - größte erhaltene Burg Mitteleuropas
Schloss Mirabell & Mirabellgarten - barocker Palast, Eintritt frei
Mozarts Geburtshaus - Getreidegasse 9
Salzburger Dom - barocke Kathedrale
Schloss Hellbrunn - Wasserspiele (Bus 25 ab Markartplatz)
Untersberg - 1.853m mit Seilbahn (Bus 25 ab Markartplatz)

Rückfahrt zum Hotel: Bus 21 Richtung Bergheim bis Baron Schwarz Park`;
    }
    return `Top Sights in Salzburg (15 minutes by Bus 21 from hotel, FREE with Guest Ticket):

Hohensalzburg Fortress - largest preserved castle in Central Europe
Mirabell Palace & Gardens - baroque palace, free gardens
Mozart's Birthplace - Getreidegasse 9
Salzburg Cathedral - baroque cathedral
Hellbrunn Palace - trick fountains (Bus 25 from Markartplatz)
Untersberg Mountain - 1,853m cable car (Bus 25 from Markartplatz)

Return to hotel: Bus 21 direction Bergheim to Baron Schwarz Park`;
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

// ========== INTENT DETECTION ==========
function detectIntent(question) {
    const lower = question.toLowerCase();
    
    if (lower.includes('wifi') || lower.includes('password') || lower.includes('internet')) return 'wifi';
    if (/(route|weg|anfahrt|stadtzentrum|city center|zentrum|centre|wie komme ich)/i.test(question)) return 'route';
    if (/(bus 21|bus21|21er|linie 21|abfahrtszeiten.*21)/i.test(question)) return 'bus21';
    if (/(bus 120|bus120|120er|linie 120)/i.test(question)) return 'bus120';
    if (/(bus 121|bus121|121er|linie 121)/i.test(question)) return 'bus121';
    if (lower.includes('restaurant') || lower.includes('essen') || lower.includes('food')) return 'restaurants';
    if (lower.includes('sehenswürdigkeiten') || lower.includes('sightseeing') || lower.includes('attractions')) return 'sights';
    if (/(wetter|weather|temp|temperatur)/i.test(question)) return 'weather';
    
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
    
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) return res.json({ reply: rateCheck.message });
    const topicCheck = isQuestionAllowed(userQuestion);
    if (!topicCheck.allowed) return res.json({ reply: topicCheck.reason });
    
    const faqContent = loadFAQs();
    let history = conversationMemory.get(clientIp) || [];
    
    // Detect language from the question - ALWAYS use detected language
    let detectedLang = detectLanguage(userQuestion);
    userLanguagePreference.set(clientIp, detectedLang);
    
    const intent = detectIntent(userQuestion);
    let reply = "";
    
    try {
        // ========== HANDLE INTENTS WITH FILTERED API RESPONSES ==========
        
        if (intent === 'wifi') {
            reply = getWifiResponse(detectedLang);
        }
        else if (intent === 'route') {
            reply = getCityCenterRoute(detectedLang);
        }
        else if (intent === 'bus21') {
            reply = await getBus21Schedule(detectedLang);
        }
        else if (intent === 'bus120') {
            reply = await getBus120Schedule(detectedLang);
        }
        else if (intent === 'bus121') {
            reply = await getBus121Schedule(detectedLang);
        }
        else if (intent === 'restaurants') {
            reply = getRestaurants(detectedLang);
        }
        else if (intent === 'sights') {
            reply = getSights(detectedLang);
        }
        else if (intent === 'weather') {
            const weatherData = await getWeather("Salzburg", detectedLang);
            if (weatherData) {
                reply = weatherData;
            } else if (detectedLang === 'german') {
                reply = "Wetterinformationen sind gerade nicht verfügbar. Bitte besuchen Sie www.wetter.at für die aktuelle Vorhersage.";
            } else {
                reply = "Weather information is currently unavailable. Please check a weather app for the forecast.";
            }
        }
        else {
            // Use DeepSeek for general questions
            const historyText = history.slice(-6).map(msg => `${msg.role}: ${msg.content}`).join('\n');
            
            const languageInstruction = detectedLang === 'german' 
                ? "Du MUSST auf Deutsch antworten. Verwende KEIN Englisch."
                : "You MUST respond in English. Do not use German.";
            
            const systemPrompt = `${languageInstruction}

You are a hotel assistant at Hotel Vogelweiderhof in Salzburg.

HOTEL FAQ:
${faqContent}

CRITICAL RULE: NEVER end your response with a question. Do not ask "Would you like...", "Can I help you...", or any other question. Just state the information and stop.

CONVERSATION HISTORY:
${historyText}

GUEST: ${userQuestion}

ASSISTANT:`;

            const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: "deepseek-chat",
                messages: [{ role: "user", content: systemPrompt }],
                temperature: 0.5,
                max_tokens: limitsConfig.maxTokensPerResponse
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                timeout: 25000
            });
            
            reply = response.data.choices[0].message.content;
            reply = reply.replace(/\?$/, '.');
            
            if (response.data.usage) {
                updateTokenAnalytics(response.data.usage);
            }
        }
        
        // Final safety: ensure no question at the end
        reply = reply.replace(/\?$/, '.');
        
    } catch (error) {
        console.error('Chat error:', error.message);
        reply = detectedLang === 'german' 
            ? "Ich habe gerade technische Probleme. Bitte versuchen Sie es später noch einmal."
            : "I'm having technical difficulties. Please try again later.";
    }
    
    history.push({ role: "user", content: userQuestion.substring(0, 150) });
    history.push({ role: "assistant", content: reply.substring(0, 500) });
    if (history.length > 12) history.splice(0, 2);
    conversationMemory.set(clientIp, history);
    
    res.json({ reply: reply });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Hotel Chat Bot running on port ${PORT}`);
    console.log(`📍 Hotel: Vogelweiderstraße 93/B, 5020 Salzburg`);
    console.log(`🚆 VAO/HAFAS API: ENABLED (LIVE real-time filtered departures)`);
    console.log(`🌤️ Weather API: ENABLED (Open-Meteo)`);
    console.log(`🌍 Language detection: AUTO - responds in guest's language`);
    console.log(`📋 FAQ loaded: ${loadFAQs() !== "No FAQ loaded" ? "YES" : "NO"}`);
    console.log(`\n✅ Bus 21: Shows ONLY Bus 21 - separates city center vs other directions`);
    console.log(`✅ Bus 120: Shows ONLY Bus 120 - highlights train station direction`);
    console.log(`✅ Bot NEVER ends responses with questions\n`);
});
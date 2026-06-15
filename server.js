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

// ========== IMPROVED LANGUAGE DETECTION ==========
function detectLanguage(text) {
    analytics.totalQuestions++;
    const normalizedQuestion = text.toLowerCase().replace(/[^\w\s]/g, '').substring(0, 100);
    analytics.mostAskedQuestions.set(normalizedQuestion, (analytics.mostAskedQuestions.get(normalizedQuestion) || 0) + 1);
    
    // German detection - expanded
    if (/[äöüß]/i.test(text)) return 'german';
    if (/(wie|was|wo|wann|warum|ich|du|sie|wir|euch|mir|dich|kann|mag|möchte|bitte|danke|guten|tag|morgen|abend|nacht|hallo|tschüss|auf wiedersehen|straße|platz|bahn|bus|zug|hotel|zimmer|preis|kosten|reservierung|buchung|frühstück|check-in|check-out)/i.test(text)) return 'german';
    
    // Chinese detection
    if (/[\u4e00-\u9fff]/.test(text)) return 'chinese';
    
    // Spanish detection
    if (/[áéíóúñ¿¡]/i.test(text)) return 'spanish';
    if (/(cómo|qué|dónde|cuándo|por qué|quién|hola|adiós|gracias|por favor|buenos días|buenas tardes|buenas noches|hotel|habitación|precio|costo|reserva|desayuno)/i.test(text)) return 'spanish';
    
    // French detection
    if (/[àâçéèêëîïôûùüÿ]/i.test(text)) return 'french';
    if (/(comment|quoi|où|quand|pourquoi|qui|bonjour|au revoir|merci|s'il vous plaît|hôtel|chambre|prix|réservation|petit-déjeuner)/i.test(text)) return 'french';
    
    // Italian detection
    if (/(come|cosa|dove|quando|perché|chi|ciao|arrivederci|grazie|per favore|hotel|camera|prezzo|prenotazione|colazione)/i.test(text)) return 'italian';
    
    return 'english';
}

// ========== MULTILINGUAL RESPONSE FUNCTIONS ==========

function getWifiResponse(lang) {
    if (lang === 'german') return "Das WLAN-Passwort lautet: internet (alles kleingeschrieben). Der Netzwerkname ist Vogelweiderhof.";
    if (lang === 'chinese') return "WiFi密码是：internet（全部小写）。网络名称是Vogelweiderhof。";
    if (lang === 'spanish') return "La contraseña de WiFi es: internet (todas minúsculas). El nombre de la red es Vogelweiderhof.";
    if (lang === 'french') return "Le mot de passe WiFi est : internet (tout en minuscules). Le nom du réseau est Vogelweiderhof.";
    if (lang === 'italian') return "La password WiFi è: internet (tutto minuscolo). Il nome della rete è Vogelweiderhof.";
    return "The WiFi password is: internet (all lowercase). The network name is Vogelweiderhof.";
}

function getCityCenterRoute(lang) {
    const routes = {
        english: `To reach the city center from Hotel Vogelweiderhof:

By Bus (recommended):
Take Bus 21 from Baron Schwarz Park bus stop (30 meters from the hotel)
Direction: Fürstenbrunn
Travel time: 15 minutes
Cost: FREE with your Guest Mobility Ticket

By Walking:
Distance: 2-2.5 km
Time: 30-45 minutes
Route: Follow Vogelweiderstraße towards the city center, at the end turn right.

Would you like Bus 21 departure times?`,
        
        german: `So erreichen Sie das Stadtzentrum vom Hotel Vogelweiderhof:

Mit dem Bus (empfohlen):
Nehmen Sie den Bus 21 ab der Haltestelle Baron Schwarz Park (30 Meter vom Hotel)
Richtung: Fürstenbrunn
Fahrzeit: 15 Minuten
Kosten: KOSTENLOS mit Ihrer Gästekarte

Zu Fuß:
Entfernung: 2-2,5 km
Zeit: 30-45 Minuten
Route: Folgen Sie der Vogelweiderstraße Richtung Stadtzentrum, am Ende biegen Sie rechts ab.

Möchten Sie die Abfahrtszeiten des Bus 21?`,
        
        chinese: `从Hotel Vogelweiderhof前往市中心：

乘坐巴士（推荐）：
在Baron Schwarz Park巴士站乘坐21路巴士（距离酒店30米）
方向：Fürstenbrunn
行程时间：15分钟
费用：凭客人卡免费

步行：
距离：2-2.5公里
时间：30-45分钟
路线：沿着Vogelweiderstraße向市中心方向走，在尽头右转。

需要21路巴士的发车时间吗？`,
        
        spanish: `Para llegar al centro de la ciudad desde Hotel Vogelweiderhof:

En autobús (recomendado):
Tome el autobús 21 en la parada Baron Schwarz Park (30 metros del hotel)
Dirección: Fürstenbrunn
Duración: 15 minutos
Costo: GRATIS con su Guest Mobility Ticket

Caminando:
Distancia: 2-2,5 km
Tiempo: 30-45 minutos
Ruta: Siga Vogelweiderstraße hacia el centro de la ciudad, al final gire a la derecha.

¿Le gustaría ver los horarios del autobús 21?`,
        
        french: `Pour rejoindre le centre-ville depuis l'hôtel Vogelweiderhof:

En bus (recommandé):
Prenez le bus 21 à l'arrêt Baron Schwarz Park (30 mètres de l'hôtel)
Direction: Fürstenbrunn
Durée: 15 minutes
Coût: GRATUIT avec votre Guest Mobility Ticket

À pied:
Distance: 2-2,5 km
Temps: 30-45 minutes
Itinéraire: Suivez Vogelweiderstraße vers le centre-ville, au bout tournez à droite.

Souhaitez-vous les horaires du bus 21?`,
        
        italian: `Per raggiungere il centro città da Hotel Vogelweiderhof:

In autobus (consigliato):
Prenda l'autobus 21 alla fermata Baron Schwarz Park (30 metri dall'hotel)
Direzione: Fürstenbrunn
Durata: 15 minuti
Costo: GRATUITO con il vostro Guest Mobility Ticket

A piedi:
Distanza: 2-2,5 km
Tempo: 30-45 minuti
Percorso: Segua Vogelweiderstraße verso il centro città, alla fine giri a destra.

Vuole gli orari di partenza dell'autobus 21?`
    };
    return routes[lang] || routes.english;
}

function getNearbyRestaurants(lang) {
    const restaurants = {
        english: `Restaurants near Hotel Vogelweiderhof:

BESIDE THE HOTEL (1-3 min walk):
- Smash to Go (Food truck beside hotel, 15% discount for hotel guests)
- Mr. Cevap (1 min walk, Balkan grill)
- Gasthaus Turnerwirt (3 min walk, across street, traditional Austrian)

CITY CENTER (15 min by Bus 21 - FREE with Guest Ticket):
- Sternbräu, St. Peter (oldest restaurant in Europe), Stieglkeller, Augustinerbräu`,
        
        german: `Restaurants in der Nähe des Hotel Vogelweiderhof:

DIREKT BEIM HOTEL (1-3 Gehminuten):
- Smash to Go (Food Truck neben dem Hotel, 15% Rabatt für Hotelgäste)
- Mr. Cevap (1 Gehminute, Balkan Grill)
- Gasthaus Turnerwirt (3 Gehminuten, gegenüber, traditionelle österreichische Küche)

STADTZENTRUM (15 Minuten mit Bus 21 - KOSTENLOS mit Gästekarte):
- Sternbräu, St. Peter (ältestes Restaurant Europas), Stieglkeller, Augustinerbräu`,
        
        chinese: `Hotel Vogelweiderhof 附近餐厅：

酒店旁边 (1-3分钟步行):
- Smash to Go (酒店旁边的餐车，酒店客人15%折扣)
- Mr. Cevap (步行1分钟，巴尔干烤肉)
- Gasthaus Turnerwirt (步行3分钟，街对面，传统奥地利菜)

市中心 (乘坐21路巴士15分钟 - 凭客人卡免费):
- Sternbräu, St. Peter (欧洲最古老餐厅), Stieglkeller, Augustinerbräu`,
        
        spanish: `Restaurantes cerca de Hotel Vogelweiderhof:

JUNTO AL HOTEL (1-3 min a pie):
- Smash to Go (Camión de comida junto al hotel, 15% descuento para huéspedes)
- Mr. Cevap (1 min a pie, cocina balcánica)
- Gasthaus Turnerwirt (3 min a pie, al otro lado de la calle, austriaco tradicional)

CENTRO DE LA CIUDAD (15 min en autobús 21 - GRATIS con Guest Ticket):
- Sternbräu, St. Peter (restaurante más antiguo de Europa), Stieglkeller, Augustinerbräu`,
        
        french: `Restaurants près de l'hôtel Vogelweiderhof:

À CÔTÉ DE L'HÔTEL (1-3 min à pied):
- Smash to Go (Camion-restaurant à côté de l'hôtel, 15% de réduction)
- Mr. Cevap (1 min à pied, grill balkanique)
- Gasthaus Turnerwirt (3 min à pied, en face, cuisine autrichienne traditionnelle)

CENTRE-VILLE (15 min en bus 21 - GRATUIT avec Guest Ticket):
- Sternbräu, St. Peter (plus ancien restaurant d'Europe), Stieglkeller, Augustinerbräu`,
        
        italian: `Ristoranti vicino a Hotel Vogelweiderhof:

VICINO ALL'HOTEL (1-3 min a piedi):
- Smash to Go (Food truck accanto all'hotel, 15% di sconto per gli ospiti)
- Mr. Cevap (1 min a piedi, cucina balcanica)
- Gasthaus Turnerwirt (3 min a piedi, dall'altra parte della strada, cucina austriaca tradizionale)

CENTRO CITTÀ (15 min in autobus 21 - GRATUITO con Guest Ticket):
- Sternbräu, St. Peter (il ristorante più antico d'Europa), Stieglkeller, Augustinerbräu`
    };
    return restaurants[lang] || restaurants.english;
}

function getSights(lang) {
    const sights = {
        english: `Top Sights in Salzburg (15 min by Bus 21 from hotel, FREE with Guest Ticket):

- Hohensalzburg Fortress (largest preserved castle in Central Europe)
- Mirabell Palace & Gardens (baroque palace, free gardens)
- Mozart's Birthplace (Getreidegasse 9)
- Salzburg Cathedral (baroque cathedral)
- Hellbrunn Palace (trick fountains) - Bus 25 from Markartplatz
- Untersberg Mountain (1,853m cable car) - Bus 25 from Markartplatz
- Gaisberg Mountain (1,287m views) - Bus 151 from Mirabellplatz

Return to hotel: Bus 21 direction Bergheim to Baron Schwarz Park`,
        
        german: `Top Sehenswürdigkeiten in Salzburg (15 Minuten mit Bus 21 vom Hotel, KOSTENLOS mit Gästekarte):

- Festung Hohensalzburg (größte erhaltene Burg Mitteleuropas)
- Schloss Mirabell & Mirabellgarten (barocker Palast, Eintritt frei)
- Mozarts Geburtshaus (Getreidegasse 9)
- Salzburger Dom (barocke Kathedrale)
- Schloss Hellbrunn (Wasserspiele) - Bus 25 ab Markartplatz
- Untersberg (1.853m mit Seilbahn) - Bus 25 ab Markartplatz
- Gaisberg (1.287m mit Panoramablick) - Bus 151 ab Mirabellplatz

Rückfahrt zum Hotel: Bus 21 Richtung Bergheim bis Baron Schwarz Park`,
        
        chinese: `萨尔茨堡顶级景点（从酒店乘坐21路巴士15分钟，凭客人卡免费）:

- 霍亨萨尔茨堡城堡（中欧最大的保存完好的城堡）
- 米拉贝尔宫及花园（巴洛克式宫殿，花园免费）
- 莫扎特出生地（Getreidegasse 9）
- 萨尔茨堡大教堂（巴洛克式大教堂）
- 海尔布伦宫（trick fountains）- 从Markartplatz乘25路巴士
- 翁特斯贝格山（1,853米缆车）- 从Markartplatz乘25路巴士
- 盖斯贝格山（1,287米全景）- 从Mirabellplatz乘151路巴士

返回酒店: 乘坐21路巴士方向Bergheim到Baron Schwarz Park`,
        
        spanish: `Principales atracciones en Salzburgo (15 min en autobús 21 desde el hotel, GRATIS con Guest Ticket):

- Fortaleza Hohensalzburg (castillo más grande conservado de Europa central)
- Palacio Mirabell y Jardines (palacio barroco, jardines gratuitos)
- Casa natal de Mozart (Getreidegasse 9)
- Catedral de Salzburgo (catedral barroca)
- Palacio Hellbrunn (fuentes ornamentales) - Autobús 25 desde Markartplatz
- Monte Untersberg (teleférico a 1.853m) - Autobús 25 desde Markartplatz
- Monte Gaisberg (vistas a 1.287m) - Autobús 151 desde Mirabellplatz

Regreso al hotel: Autobús 21 dirección Bergheim hasta Baron Schwarz Park`,
        
        french: `Principales attractions à Salzbourg (15 min en bus 21 depuis l'hôtel, GRATUIT avec Guest Ticket):

- Forteresse Hohensalzburg (plus grand château préservé d'Europe centrale)
- Palais Mirabell et Jardins (palais baroque, jardins gratuits)
- Maison natale de Mozart (Getreidegasse 9)
- Cathédrale de Salzbourg (cathédrale baroque)
- Palais Hellbrunn (jeux d'eau) - Bus 25 depuis Markartplatz
- Mont Untersberg (téléphérique à 1.853m) - Bus 25 depuis Markartplatz
- Mont Gaisberg (vues à 1.287m) - Bus 151 depuis Mirabellplatz

Retour à l'hôtel: Bus 21 direction Bergheim jusqu'à Baron Schwarz Park`,
        
        italian: `Principali attrazioni di Salisburgo (15 min in autobus 21 dall'hotel, GRATUITO con Guest Ticket):

- Fortezza Hohensalzburg (più grande castello conservato dell'Europa centrale)
- Palazzo Mirabell e Giardini (palazzo barocco, giardini gratuiti)
- Casa natale di Mozart (Getreidegasse 9)
- Duomo di Salisburgo (cattedrale barocca)
- Palazzo Hellbrunn (giochi d'acqua) - Autobus 25 da Markartplatz
- Monte Untersberg (funivia a 1.853m) - Autobus 25 da Markartplatz
- Monte Gaisberg (viste a 1.287m) - Autobus 151 da Mirabellplatz

Ritorno in hotel: Autobus 21 direzione Bergheim fino a Baron Schwarz Park`
    };
    return sights[lang] || sights.english;
}

function getEvents(lang) {
    const events = {
        english: `Upcoming Events in Salzburg:
- Mozart Week (late January)
- Easter Festival (March/April)
- Whitsun Festival (May/June)
- Salzburg Festival (July/August)
- Christmas Markets (November/December)
Details: www.salzburg.info/en/events`,
        
        german: `Veranstaltungen in Salzburg:
- Mozartwoche (Ende Januar)
- Osterfestspiele (März/April)
- Pfingstfestspiele (Mai/Juni)
- Salzburger Festspiele (Juli/August)
- Christkindlmärkte (November/Dezember)
Details: www.salzburg.info/de/veranstaltungen`,
        
        chinese: `萨尔茨堡即将举办的活动:
- 莫扎特周（一月底）
- 复活节音乐节（三月/四月）
- 圣灵降临节音乐节（五月/六月）
- 萨尔茨堡艺术节（七月/八月）
- 圣诞市场（十一月/十二月）
详情：www.salzburg.info/zh/events`,
        
        spanish: `Próximos eventos en Salzburgo:
- Semana de Mozart (finales de enero)
- Festival de Pascua (marzo/abril)
- Festival de Pentecostés (mayo/junio)
- Festival de Salzburgo (julio/agosto)
- Mercados navideños (noviembre/diciembre)
Detalles: www.salzburg.info/es/events`,
        
        french: `Événements à venir à Salzbourg:
- Semaine Mozart (fin janvier)
- Festival de Pâques (mars/avril)
- Festival de la Pentecôte (mai/juin)
- Festival de Salzbourg (juillet/août)
- Marchés de Noël (novembre/décembre)
Détails: www.salzburg.info/fr/events`,
        
        italian: `Prossimi eventi a Salisburgo:
- Settimana Mozart (fine gennaio)
- Festival di Pasqua (marzo/aprile)
- Festival di Pentecoste (maggio/giugno)
- Festival di Salisburgo (luglio/agosto)
- Mercatini di Natale (novembre/dicembre)
Dettagli: www.salzburg.info/it/events`
    };
    return events[lang] || events.english;
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

async function getRealTimeDepartures(stationName, maxResults = 10, filterLine = null) {
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

async function getBusSchedule(busNumber, lang = 'english') {
    const station = "Baron Schwarz Park";
    const departures = await getRealTimeDepartures(station, 10, busNumber);
    
    if (!departures || departures.length === 0) {
        const messages = {
            english: `No live departures for Bus ${busNumber} found. Please check www.oebb.at for schedule information.`,
            german: `Keine aktuellen Abfahrten für Bus ${busNumber} gefunden. Bitte besuchen Sie www.oebb.at für Fahrplaninformationen.`,
            chinese: `未找到${busNumber}路巴士的实时班次。请访问www.oebb.at查看时刻表信息。`,
            spanish: `No se encontraron salidas en vivo para el autobús ${busNumber}. Por favor, consulte www.oebb.at para información de horarios.`,
            french: `Aucun départ en direct trouvé pour le bus ${busNumber}. Veuillez consulter www.oebb.at pour les horaires.`,
            italian: `Nessuna partenza in tempo reale trovata per l'autobus ${busNumber}. Controlla www.oebb.at per gli orari.`
        };
        return messages[lang] || messages.english;
    }
    
    let response = "";
    const headers = {
        english: `Bus ${busNumber} departure times from Baron Schwarz Park (your hotel):\n`,
        german: `Bus ${busNumber} Abfahrtszeiten ab Baron Schwarz Park (Ihrem Hotel):\n`,
        chinese: `${busNumber}路巴士从Baron Schwarz Park（您的酒店）的发车时间：\n`,
        spanish: `Horarios de salida del autobús ${busNumber} desde Baron Schwarz Park (su hotel):\n`,
        french: `Horaires de départ du bus ${busNumber} depuis Baron Schwarz Park (votre hôtel):\n`,
        italian: `Orari di partenza dell'autobus ${busNumber} da Baron Schwarz Park (il tuo hotel):\n`
    };
    
    response += headers[lang] || headers.english;
    
    for (const dep of departures.slice(0, 6)) {
        const delayText = dep.delay > 0 ? ` (${dep.delay} min delay)` : '';
        response += `${dep.departureTime}${delayText}\n`;
    }
    
    return response;
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
        
        const labels = {
            english: { current: "Current", wind: "Wind", forecast: "3-Day Forecast", high: "High", low: "Low" },
            german: { current: "Aktuell", wind: "Wind", forecast: "3-Tage-Vorhersage", high: "Max", low: "Min" },
            chinese: { current: "当前", wind: "风速", forecast: "3天预报", high: "最高", low: "最低" },
            spanish: { current: "Actual", wind: "Viento", forecast: "Pronóstico 3 días", high: "Máx", low: "Mín" },
            french: { current: "Actuel", wind: "Vent", forecast: "Prévisions 3 jours", high: "Max", low: "Min" },
            italian: { current: "Attuale", wind: "Vento", forecast: "Previsioni 3 giorni", high: "Max", low: "Min" }
        };
        
        const l = labels[lang] || labels.english;
        
        let response = `${l.current} weather in ${location.name}: ${current.temperature}°C, ${weatherCodes[current.weathercode] || "Unknown"}\n`;
        response += `${l.wind}: ${current.windspeed} km/h\n\n`;
        response += `${l.forecast}:\n`;
        
        for (let i = 0; i < daily.time.length && i < 3; i++) {
            const day = new Date(daily.time[i]);
            const dayName = day.toLocaleDateString(lang === 'german' ? 'de-DE' : lang === 'chinese' ? 'zh-CN' : 'en-US', { weekday: 'short' });
            response += `${dayName}: ${l.high} ${daily.temperature_2m_max[i]}°C / ${l.low} ${daily.temperature_2m_min[i]}°C\n`;
        }
        
        return response;
    } catch (error) {
        console.log("Weather API error:", error.message);
        return null;
    }
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
    
    if (lower.includes('wifi') || lower.includes('password') || lower.includes('internet') || lower.includes('network')) return 'wifi';
    if (/(wetter|weather|temp|temperatur|forecast|rain|snow|sun|cloud)/i.test(question)) return 'weather';
    if (/(route|weg|anfahrt|anreise|how to get|come to|reach|city center|stadtzentrum|zentrum|centre)/i.test(question)) return 'route_citycenter';
    if (lower.includes('restaurant') || lower.includes('eatery') || lower.includes('food') || lower.includes('eat')) return 'restaurants';
    if (lower.includes('sightseeing') || lower.includes('sehenswürdigkeiten') || lower.includes('attraction')) return 'sights';
    if (lower.includes('event') || lower.includes('festival') || lower.includes('konzert') || lower.includes('concert')) return 'events';
    if (lower.includes('bus 21') || lower.includes('bus21')) return 'bus_schedule';
    
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
    
    // Detect language from the question
    let detectedLang = userLanguagePreference.get(clientIp);
    if (!detectedLang) {
        detectedLang = detectLanguage(userQuestion);
        userLanguagePreference.set(clientIp, detectedLang);
    }
    
    const intent = detectIntent(userQuestion);
    
    // ========== HARDCODED RESPONSES WITH PROPER LANGUAGE ==========
    
    if (intent === 'wifi') {
        const reply = getWifiResponse(detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'route_citycenter') {
        const reply = getCityCenterRoute(detectedLang);
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
    
    if (intent === 'bus_schedule') {
        const reply = await getBusSchedule("21", detectedLang);
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    if (intent === 'weather') {
        const weatherData = await getWeather("Salzburg", detectedLang);
        const reply = weatherData || (detectedLang === 'german' ? "Wetterinformationen sind gerade nicht verfügbar." :
                       detectedLang === 'chinese' ? "天气信息暂时不可用。" :
                       "Weather information is currently unavailable.");
        history.push({ role: "user", content: userQuestion.substring(0, 150) });
        history.push({ role: "assistant", content: reply });
        if (history.length > 10) history.splice(0, 2);
        conversationMemory.set(clientIp, history);
        return res.json({ reply: reply });
    }
    
    // ========== USE DEEPSEEK FOR GENERAL QUESTIONS ==========
    const historyText = history.slice(-8).map(msg => `${msg.role}: ${msg.content}`).join('\n');
    const isWeekend = isWeekendOrHoliday();
    const weekendNote = isWeekend ? "\n\nNote: Today is a weekend or public holiday. Bus schedules may have reduced service." : "";
    
    // Force the language instruction strongly
    const languageInstruction = {
        english: "IMPORTANT: You MUST respond in English. Do not use German or any other language. Respond in English only.",
        german: "WICHTIG: Du MUSST auf Deutsch antworten. Verwende kein Englisch oder andere Sprachen. Antworte nur auf Deutsch.",
        chinese: "重要：你必须用中文回复。不要使用英语或其他语言。只使用中文回复。",
        spanish: "IMPORTANTE: Debes responder en español. No uses inglés ni otros idiomas. Responde solo en español.",
        french: "IMPORTANT: Vous devez répondre en français. N'utilisez pas l'anglais ou d'autres langues. Répondez uniquement en français.",
        italian: "IMPORTANTE: Devi rispondere in italiano. Non usare l'inglese o altre lingue. Rispondi solo in italiano."
    };
    
    const systemPrompt = `You are a helpful hotel assistant at Hotel Vogelweiderhof in Salzburg.

${languageInstruction[detectedLang] || languageInstruction.english}

HOTEL INFORMATION:
- Check-in: 3:00 PM, Check-out: 11:00 AM
- WiFi password: internet (lowercase), network: Vogelweiderhof
- Guest Mobility Ticket: FREE public transport with online check-in

BUS INFORMATION:
- From hotel (Baron Schwarz Park, 30m): Bus 21 to City Center (direction Fürstenbrunn) - FREE with Guest Ticket
- Bus 120/121 from hotel to Train Station (direction Hauptbahnhof)

CONVERSATION HISTORY (use this to understand context):
${historyText}

GUEST: ${userQuestion}

RULES:
- Respond in the language specified above
- Be helpful and warm
- Never end responses with questions
- Use plain text only${weekendNote}`;

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
    console.log(`🌍 Multi-language: English, German, Chinese, Spanish, French, Italian`);
    console.log(`💾 Conversation memory: ENABLED`);
    console.log(`📋 FAQ loaded: ${loadFAQs() !== "No FAQ loaded" ? "YES" : "NO"}\n`);
});
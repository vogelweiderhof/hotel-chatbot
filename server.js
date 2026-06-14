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

let botConfig = {
    personality: "You are a friendly hotel front desk agent named Alex.",
    safetyRules: "Never swear. Stay child-friendly. Avoid controversial topics.",
    styleRules: "Be concise. Answer in 1-2 sentences. Be helpful.",
    websiteContent: "",
    customRules: [],
    bookingLink: "https://direct-book.com/properties/hotelvogelweiderhof",
    webSearchEnabled: true
};

// Simple language detection function
function detectLanguage(text) {
    const langPatterns = {
        german: /^(german|deutsch|auf deutsch|wie sagt man)/i,
        germanWords: /[äöüß]/i,
        spanish: /^(español|spanish|hablas español)/i,
        french: /^(français|french|parlez-vous français)/i,
        italian: /^(italiano|italian|parli italiano)/i,
        dutch: /^(nederlands|dutch|spreek je nederlands)/i
    };
    
    // Check if user explicitly asks for a language
    if (langPatterns.german.test(text)) return 'german';
    if (langPatterns.spanish.test(text)) return 'spanish';
    if (langPatterns.french.test(text)) return 'french';
    if (langPatterns.italian.test(text)) return 'italian';
    if (langPatterns.dutch.test(text)) return 'dutch';
    
    // Check for German characters (common in German text)
    if (langPatterns.germanWords.test(text)) return 'german';
    
    return 'auto'; // Let AI detect
}

// Function to load FAQs from text file (runs on every request)
function loadFAQs() {
    try {
        const faqPath = path.join(__dirname, 'hotel-faqs.txt');
        if (!fs.existsSync(faqPath)) {
            console.log('⚠️ hotel-faqs.txt not found');
            return null;
        }
        
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
        
        console.log(`✅ Loaded ${Object.keys(faqMap).length} FAQ entries`);
        
        let faqText = "=== OFFICIAL HOTEL INFORMATION (PRIORITY) ===\n\n";
        for (const [q, a] of Object.entries(faqMap)) {
            faqText += `• ${q.toUpperCase()}: ${a}\n`;
        }
        
        return { faqMap, faqText };
        
    } catch (error) {
        console.error('Error loading FAQs:', error.message);
        return null;
    }
}

// Setup endpoint
app.post('/api/setup', async (req, res) => {
    const { websiteUrl, personality, safetyRules, styleRules } = req.body;
    
    if (personality) botConfig.personality = personality;
    if (safetyRules) botConfig.safetyRules = safetyRules;
    if (styleRules) botConfig.styleRules = styleRules;
    
    if (websiteUrl && websiteUrl !== '') {
        try {
            console.log(`📖 Reading: ${websiteUrl}`);
            const response = await axios.get(websiteUrl, { 
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const $ = cheerio.load(response.data);
            const text = $('body').text().replace(/\s+/g, ' ').trim();
            botConfig.websiteContent = text.substring(0, 2000);
            console.log(`✅ Loaded ${botConfig.websiteContent.length} chars from website`);
        } catch (error) {
            console.log('⚠️ Website scrape failed, but FAQ will still work');
            botConfig.websiteContent = "";
        }
    }
    
    res.json({ success: true, message: "Setup complete! Bot can answer in multiple languages." });
});

// Update rules
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

// MAIN CHAT ENDPOINT - Multi-lingual
app.post('/api/chat', async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const userQuestion = req.body.userMessage;
    
    if (!apiKey) {
        return res.json({ reply: "❌ API key missing. Check your .env file." });
    }
    
    // Load FAQs
    const faqData = loadFAQs();
    const faqText = faqData ? faqData.faqText : "No FAQ file loaded.";
    
    // Detect language
    const detectedLang = detectLanguage(userQuestion);
    let languageInstruction = "";
    
    switch(detectedLang) {
        case 'german':
            languageInstruction = "IMPORTANT: The user is writing in GERMAN. You MUST respond in GERMAN (Deutsch). Use 'Sie' form (formal) unless guest uses 'du'.";
            break;
        case 'spanish':
            languageInstruction = "IMPORTANT: The user is writing in SPANISH. You MUST respond in SPANISH (Español). Use 'usted' form.";
            break;
        case 'french':
            languageInstruction = "IMPORTANT: The user is writing in FRENCH. You MUST respond in FRENCH (Français). Use 'vous' form.";
            break;
        case 'italian':
            languageInstruction = "IMPORTANT: The user is writing in ITALIAN. You MUST respond in ITALIAN (Italiano). Use 'lei' form.";
            break;
        case 'dutch':
            languageInstruction = "IMPORTANT: The user is writing in DUTCH. You MUST respond in DUTCH (Nederlands). Use 'u' form.";
            break;
        default:
            languageInstruction = "IMPORTANT: Respond in the SAME LANGUAGE as the user's question. If user writes in German, answer in German. If Spanish, answer in Spanish. If English, answer in English. Match their language exactly.";
            break;
    }
    
    // Detect question types
    const isBookingQuestion = /availability|available|book|booking|price|cost|rate|check in|check out|room for|dates?|how much|what.*price|buchen|verfügbarkeit|preis/i.test(userQuestion);
    const isLocalInfoQuestion = /weather|restaurant|bar|cafe|attraction|museum|transport|taxi|bus|train|airport|directions|nearby|around here|local|sightseeing|thing to do|wetter|restaurant|sehenswürdigkeiten/i.test(userQuestion);
    
    // Build search instructions
    let searchInstructions = "";
    if (botConfig.webSearchEnabled && isLocalInfoQuestion) {
        searchInstructions = `
You HAVE the ability to search the web. For questions about LOCAL INFO (weather, restaurants, attractions, transport), you MUST search the web to provide current information.
`;
    }
    
    const systemPrompt = `You are a helpful hotel chatbot for Hotel Vogelweiderhof.

PERSONALITY: ${botConfig.personality}
SAFETY RULES: ${botConfig.safetyRules}
STYLE RULES: ${botConfig.styleRules}

${languageInstruction}

${faqText}

WEBSITE INFO (limited): ${botConfig.websiteContent || "No website content"}

${searchInstructions}

SPECIAL RULES:
1. For BOOKING/AVAILABILITY questions → Respond with the booking link: ${botConfig.bookingLink}
2. For HOTEL POLICY questions → Answer ONLY from the FAQ above
3. For LOCAL INFO questions → Use web search to find current information
4. MATCH THE USER'S LANGUAGE in your response

GUEST QUESTION: ${userQuestion}

Provide a helpful, concise answer in the SAME LANGUAGE as the question.`;

    try {
        const apiRequest = {
            model: "deepseek-chat",
            messages: [
                { 
                    role: "system", 
                    content: "You are a multi-lingual hotel concierge. You can answer in German, English, Spanish, French, Italian, and Dutch. Always respond in the same language the guest uses." 
                },
                { role: "user", content: systemPrompt }
            ],
            temperature: 0.7,
            max_tokens: 500
        };
        
        if (botConfig.webSearchEnabled && isLocalInfoQuestion) {
            apiRequest.search_enabled = true;
            console.log('🔍 Web search enabled');
        }
        
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', apiRequest, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });
        
        let reply = response.data.choices[0].message.content;
        
        if (isBookingQuestion && !reply.includes('direct-book.com')) {
            reply += `\n\n🔗 ${detectedLang === 'german' ? 'Hier buchen:' : 'Book here:'} ${botConfig.bookingLink}`;
        }
        
        res.json({ reply: reply });
        
    } catch (error) {
        console.error('Chat error:', error.message);
        res.json({ reply: "I'm having trouble right now. Please try again. / Entschuldigung, bitte versuchen Sie es später erneut." });
    }
});

app.post('/api/toggle-search', (req, res) => {
    const { enabled } = req.body;
    botConfig.webSearchEnabled = enabled;
    console.log(`🔍 Web search ${enabled ? 'enabled' : 'disabled'}`);
    res.json({ success: true, webSearchEnabled: botConfig.webSearchEnabled });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n✅ MULTI-LINGUAL Hotel Chat Bot running at http://localhost:${PORT}`);
    console.log(`🔑 API Key: ${process.env.DEEPSEEK_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`📝 FAQ file: ${fs.existsSync(path.join(__dirname, 'hotel-faqs.txt')) ? '✅ Found' : '❌ Not found'}`);
    console.log(`🔍 Web Search: ${botConfig.webSearchEnabled ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`🌍 Languages: German, English, Spanish, French, Italian, Dutch (auto-detects)\n`);
});
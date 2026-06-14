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
    webSearchEnabled: true  // NEW: Enable web search
};

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
            // Skip comments and empty lines
            if (line.trim().startsWith('#') || line.trim() === '') continue;
            
            // Parse "QUESTION | ANSWER" format
            const pipeIndex = line.indexOf('|');
            if (pipeIndex > 0) {
                const question = line.substring(0, pipeIndex).trim().toLowerCase();
                const answer = line.substring(pipeIndex + 1).trim();
                faqMap[question] = answer;
            }
        }
        
        console.log(`✅ Loaded ${Object.keys(faqMap).length} FAQ entries`);
        
        // Convert to readable text for the bot
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

// Setup endpoint (website optional)
app.post('/api/setup', async (req, res) => {
    const { websiteUrl, personality, safetyRules, styleRules } = req.body;
    
    if (personality) botConfig.personality = personality;
    if (safetyRules) botConfig.safetyRules = safetyRules;
    if (styleRules) botConfig.styleRules = styleRules;
    
    // Try to scrape website (optional - won't break if fails)
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
    
    res.json({ success: true, message: "Setup complete! Bot can answer hotel questions and search the web for local info." });
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

// MAIN CHAT ENDPOINT - With Smart FAQ + Web Search
app.post('/api/chat', async (req, res) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const userQuestion = req.body.userMessage;
    
    if (!apiKey) {
        return res.json({ reply: "❌ API key missing. Check your .env file." });
    }
    
    // Load fresh FAQs on every request
    const faqData = loadFAQs();
    const faqText = faqData ? faqData.faqText : "No FAQ file loaded.";
    
    // Detect question types
    const isBookingQuestion = /availability|available|book|booking|price|cost|rate|check in|check out|room for|dates?|how much|what.*price/i.test(userQuestion);
    const isHotelPolicyQuestion = /check[-\s]?in|check[-\s]?out|wifi|breakfast|parking|pool|pet|cancellation|reception|room service|laundry|smoking|shuttle|tax/i.test(userQuestion);
    const isLocalInfoQuestion = /weather|restaurant|bar|cafe|attraction|museum|transport|taxi|bus|train|airport|directions|nearby|around here|local|sightseeing|thing to do/i.test(userQuestion);
    
    // Build smart instructions based on question type
    let searchInstructions = "";
    if (botConfig.webSearchEnabled && isLocalInfoQuestion) {
        searchInstructions = `
You HAVE the ability to search the web. For questions about LOCAL INFO (weather, restaurants, attractions, transport, directions, events), you MUST search the web to provide current, accurate information.

When you search, be specific and helpful. For restaurant questions, include type of cuisine and price range if found.
`;
    } else if (isHotelPolicyQuestion) {
        searchInstructions = `
DO NOT search the web for hotel policy questions. Answer ONLY using the FAQ below.
`;
    } else if (isBookingQuestion) {
        searchInstructions = `
For booking/availability questions, do NOT search. Simply direct the guest to the booking link.
`;
    }
    
    const systemPrompt = `You are a helpful hotel chatbot for Hotel Vogelweiderhof.

PERSONALITY: ${botConfig.personality}
SAFETY RULES: ${botConfig.safetyRules}
STYLE RULES: ${botConfig.styleRules}

${faqText}

WEBSITE INFO (limited): ${botConfig.websiteContent || "No website content"}

${searchInstructions}

SPECIAL RULES:
1. For BOOKING/AVAILABILITY questions → Respond with: "Please check real-time availability here: ${botConfig.bookingLink}"
2. For HOTEL POLICY questions → Answer ONLY from the FAQ above
3. For LOCAL INFO questions → Use web search to find current information
4. For anything else → Use your best judgment

GUEST QUESTION: ${userQuestion}

Provide a helpful, concise answer.`;

    try {
        // Build API request with optional web search
        const apiRequest = {
            model: "deepseek-chat",
            messages: [
                { 
                    role: "system", 
                    content: "You are a hotel concierge. You can search the web for local information like weather, restaurants, and attractions." 
                },
                { role: "user", content: systemPrompt }
            ],
            temperature: 0.7,
            max_tokens: 500
        };
        
        // Add web search ONLY for local info questions
        if (botConfig.webSearchEnabled && isLocalInfoQuestion) {
            apiRequest.search_enabled = true;
            console.log('🔍 Web search enabled for this question');
        }
        
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', apiRequest, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000  // Longer timeout for web search
        });
        
        let reply = response.data.choices[0].message.content;
        
        // Add booking link if missing on booking questions
        if (isBookingQuestion && !reply.includes('direct-book.com') && !reply.includes('booking')) {
            reply += `\n\n🔗 Check availability and book here: ${botConfig.bookingLink}`;
        }
        
        // Small note when web search was used
        if (isLocalInfoQuestion && botConfig.webSearchEnabled && !reply.includes('I searched')) {
            // Optional: add a subtle indicator
            console.log('✅ Web search response sent');
        }
        
        res.json({ reply: reply });
        
    } catch (error) {
        console.error('Chat error:', error.message);
        if (error.response) {
            console.error('API Response:', error.response.data);
        }
        res.json({ reply: "I'm having trouble answering right now. Please try again in a moment." });
    }
});

// Toggle web search endpoint
app.post('/api/toggle-search', (req, res) => {
    const { enabled } = req.body;
    botConfig.webSearchEnabled = enabled;
    console.log(`🔍 Web search ${enabled ? 'enabled' : 'disabled'}`);
    res.json({ success: true, webSearchEnabled: botConfig.webSearchEnabled });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n✅ SMART Hotel Chat Bot running at http://localhost:${PORT}`);
    console.log(`🔑 API Key: ${process.env.DEEPSEEK_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log(`📝 FAQ file: ${fs.existsSync(path.join(__dirname, 'hotel-faqs.txt')) ? '✅ Found' : '❌ Not found'}`);
    console.log(`🔍 Web Search: ${botConfig.webSearchEnabled ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`\n💡 Bot can now answer hotel questions AND search the web for local info!\n`);
});
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// WordPress API credentials
const WP_API_URL = process.env.WP_API_URL;
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

// Function to generate content using Ollama
async function generateWithOllama(prompt) {
    try {
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: 'mistral',
            prompt: prompt,
            stream: false
        });
        return response.data.response;
    } catch (error) {
        console.error('Ollama Error:', error);
        throw new Error('Failed to generate content with Ollama');
    }
}

app.post('/generate-post', async (req, res) => {
    try {
        const { topic } = req.body;

        // Enhanced blog prompt for longer content
        const blogPrompt = `Write a comprehensive, SEO-optimized blog post about ${topic}. 
            Requirements:
            1. Title: Create an engaging H1 title
            2. Meta Description: Write a compelling meta description (150-160 characters)
            3. Introduction: A strong opening paragraph that hooks the reader
            4. Main Content: Create 5-6 detailed sections with H2 headings
            5. Each section should be at least 150-200 words
            6. Include relevant examples and explanations
            7. Add bullet points or numbered lists where appropriate
            8. Conclusion: A thorough summary paragraph
            9. Total word count should be at least 800 words
            
            Format the response in HTML using proper heading tags (h1, h2) and paragraph tags.
            Use <ul> and <li> for bullet points.
            Make the content engaging and informative for the reader.`;

        let blogContent = await generateWithOllama(blogPrompt);

        // Process the content
        blogContent = blogContent
            .replace(/\*\*/g, '')
            .replace(/Meta Description:.*?\n/g, '')
            .replace(/Keywords:.*$/s, '')
            .replace(/\n\n/g, '</p><p>')
            .replace(/###\s(.*?)\n/g, '<h2>$1</h2>')
            .replace(/^\s+/, '')
            .replace(/\s+$/, '')
            .replace(/>\s+</g, '><')
            .trim();

        if (!blogContent.startsWith('<')) {
            blogContent = `<p>${blogContent.trim()}</p>`;
        }

        // Create the post without featured image
        const wpResponse = await axios.post(`${WP_API_URL}/wp-json/wp/v2/posts`, {
            title: topic,
            content: blogContent,
            status: 'publish'
        }, {
            auth: {
                username: WP_USERNAME,
                password: WP_APP_PASSWORD
            }
        });

        res.json({ success: true, post: wpResponse.data });
    } catch (error) {
        console.error('Error details:', {
            message: error.message,
            response: error.response?.data
        });
        res.status(500).json({ 
            success: false, 
            error: error.response?.data || error.message 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

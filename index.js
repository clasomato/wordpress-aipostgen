require('dotenv').config();
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const upload = multer();
const { EventEmitter } = require('events');
const statusEmitter = new EventEmitter();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// WordPress API credentials
const WP_API_URL = process.env.WP_API_URL;
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

// Unsplash API credentials
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

// Function to generate content using Ollama
async function generateWithOllama(prompt, model = 'mistral') {
    try {
        // Ensure correct model name for llama3.2
        const modelName = model === 'llama3.2' ? 'llama3.2' : 'mistral';
        
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: modelName,
            prompt: prompt,
            stream: false
        });
        return response.data.response;
    } catch (error) {
        console.error('Ollama Error:', error);
        throw new Error('Failed to generate content with Ollama');
    }
}

// Helper function to get or create category
async function getOrCreateCategory(categoryName) {
    try {
        // First, try to find existing category
        const categoriesResponse = await axios.get(`${WP_API_URL}/wp-json/wp/v2/categories`, {
            params: { search: categoryName },
            auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }
        });

        if (categoriesResponse.data.length > 0) {
            return categoriesResponse.data[0].id;
        }

        // If not found, create new category
        const newCategory = await axios.post(`${WP_API_URL}/wp-json/wp/v2/categories`, {
            name: categoryName
        }, {
            auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }
        });

        return newCategory.data.id;
    } catch (error) {
        console.error('Category creation error:', error);
        return 1; // Return default category ID if there's an error
    }
}

// Helper function to get or create tags
async function getOrCreateTags(tagNames) {
    try {
        const tagIds = [];
        for (const tagName of tagNames) {
            const tagsResponse = await axios.get(`${WP_API_URL}/wp-json/wp/v2/tags`, {
                params: { search: tagName },
                auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }
            });

            if (tagsResponse.data.length > 0) {
                tagIds.push(tagsResponse.data[0].id);
            } else {
                const newTag = await axios.post(`${WP_API_URL}/wp-json/wp/v2/tags`, {
                    name: tagName
                }, {
                    auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }
                });
                tagIds.push(newTag.data.id);
            }
        }
        return tagIds;
    } catch (error) {
        console.error('Tag creation error:', error);
        return [];
    }
}

// Helper function to capitalize title
function capitalizeTitle(title) {
    const articles = ['a', 'an', 'the'];
    const conjunctions = ['and', 'but', 'or', 'nor', 'for', 'yet', 'so'];
    const prepositions = ['in', 'to', 'for', 'with', 'on', 'at', 'from', 'by', 'about', 'as', 'into', 'like', 'through', 'after', 'over', 'between', 'out', 'against', 'during', 'without', 'before', 'under', 'around', 'among'];
    
    return title.split(' ').map((word, index) => {
        const lower = word.toLowerCase();
        // Always capitalize first and last word
        if (index === 0 || index === title.split(' ').length - 1) {
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        }
        // Don't capitalize articles, conjunctions, or prepositions unless they're the first word
        if (articles.includes(lower) || conjunctions.includes(lower) || prepositions.includes(lower)) {
            return lower;
        }
        // Capitalize other words
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
}

// Helper function to compress image
async function compressImage(buffer) {
    try {
        const sharp = require('sharp');
        let quality = 80;
        let compressedImage;
        
        do {
            compressedImage = await sharp(buffer)
                .webp({ quality }) // Convert to WebP
                .resize(1600, 900, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .toBuffer();
            
            // Reduce quality if image is still too large
            if (compressedImage.length > 102400) {
                quality -= 10;
            }
        } while (compressedImage.length > 102400 && quality > 20);

        // If still too large after maximum compression, resize further
        if (compressedImage.length > 102400) {
            compressedImage = await sharp(compressedImage)
                .resize(1200, 675) // Reduce dimensions
                .webp({ quality: 60 })
                .toBuffer();
        }

        return compressedImage;
    } catch (error) {
        console.error('Image compression error:', error);
        throw error;
    }
}

// Helper function to set featured image from Unsplash
async function setFeaturedImage(imagePrompt) {
    try {
        // Search Unsplash for image using the prompt
        const searchResponse = await axios.get('https://api.unsplash.com/search/photos', {
            params: {
                query: imagePrompt,
                orientation: 'landscape',
                per_page: 1
            },
            headers: {
                Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`
            }
        });

        if (!searchResponse.data.results || searchResponse.data.results.length === 0) {
            console.error('No images found on Unsplash');
            return 0;
        }

        // Get the first image URL
        const imageUrl = searchResponse.data.results[0].urls.raw + '&w=1600&h=900&fit=crop';
        
        // Download the image
        const imageResponse = await axios.get(imageUrl, { 
            responseType: 'arraybuffer'
        });

        // Compress image
        const compressedImage = await compressImage(imageResponse.data);
        
        const formData = new FormData();
        formData.append('file', compressedImage, {
            filename: 'featured-image.webp',
            contentType: 'image/webp'
        });

        const mediaResponse = await axios.post(`${WP_API_URL}/wp-json/wp/v2/media`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Content-Type': 'multipart/form-data',
            },
            auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }
        });

        return mediaResponse.data.id;
    } catch (error) {
        console.error('Featured image error:', error.message);
        return 0;
    }
}

// Helper function to generate image search keywords from title
function generateImageKeywords(title) {
    // List of connecting words to remove
    const connectingWords = [
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
        'by', 'about', 'like', 'through', 'over', 'between', 'after', 'since', 'before',
        'is', 'are', 'was', 'were', 'be', 'been'
    ];

    // Split title into words and filter out connecting words
    const keywords = title
        .toLowerCase()
        .split(' ')
        .filter(word => !connectingWords.includes(word));

    return keywords.join(' ');
}

app.get('/rewrite-status', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendStatus = (status) => {
        res.write(`data: ${status}\n\n`);
    };

    statusEmitter.on('status', sendStatus);

    req.on('close', () => {
        statusEmitter.removeListener('status', sendStatus);
    });
});

app.post('/generate-post', upload.single('image'), async (req, res) => {
    try {
        const { topic } = req.body;
        const uploadedImage = req.file;
        const capitalizedTopic = capitalizeTitle(topic);

        // Enhanced blog prompt for longer content
        const blogPrompt = `Write a comprehensive, SEO-optimized blog post about ${capitalizedTopic}. 

Requirements:
1. Create an engaging title (do not use any markdown or special characters)
2. Meta Description: Write a compelling meta description (150-160 characters)
3. Introduction: A strong opening paragraph that hooks the reader
4. Main Content: Create 5-6 detailed sections with H2 headings
5. Each section should be at least 150-200 words
6. Include relevant examples and explanations
7. Add bullet points or numbered lists where appropriate
8. Conclusion: A thorough summary paragraph
9. Total word count should be at least 1000 words (do not include word count in the output)
10. Suggest one main category for the post
11. Suggest 5-7 relevant tags for the post

Format the response with:
CATEGORY: [category]
TAGS: [tag1, tag2, tag3, tag4, tag5]

Then format the content in clean HTML using proper heading tags (h1, h2) and paragraph tags.
Use <ul> and <li> for bullet points.
Do not include any metadata, word counts, or notes in the final content.
Do not use any markdown formatting like **, ##, or other special characters.`;

        let blogContent = await generateWithOllama(blogPrompt);

        // Extract metadata from the content
        let category = '';
        let tags = [];

        const categoryMatch = blogContent.match(/CATEGORY:\s*(.+?)\n/);
        const tagsMatch = blogContent.match(/TAGS:\s*(.+?)\n/);

        if (categoryMatch) category = categoryMatch[1].trim();
        if (tagsMatch) tags = tagsMatch[1].split(',').map(tag => tag.trim());

        // Process the content
        blogContent = blogContent
            .replace(/^[`\s*#]+|[`\s*#]+$/g, '') // Remove backticks, asterisks, and hashes at start/end
            .replace(/\*\*|__/g, '') // Remove all bold markdown
            .replace(/#+\s/g, '') // Remove any remaining header markdown
            .replace(/CATEGORY:.*\n/, '')
            .replace(/TAGS:.*\n/, '')
            .replace(/TITLE:.*\n/, '')
            .replace(/Meta Description:.*?\n/g, '')
            .replace(/Keywords:.*$/s, '')
            .replace(/\n\n/g, '</p><p>')
            .replace(/###?\s*(.*?)\n/g, '<h2>$1</h2>')
            .replace(/^\s*["`'*]+|["`'*]+\s*$/g, '') // Remove quotes and asterisks
            .replace(/^\s+/, '')
            .replace(/\s+$/, '')
            .replace(/>\s+</g, '><')
            .replace(/Tags:.*$/, '')
            .trim();

        if (!blogContent.startsWith('<')) {
            blogContent = `<p>${blogContent.trim()}</p>`;
        }

        // Handle featured image
        let featuredMediaId = 0;
        if (uploadedImage) {
            // Use uploaded image
            const compressedImage = await compressImage(uploadedImage.buffer);
            
            const formData = new FormData();
            formData.append('file', compressedImage, {
                filename: 'featured-image.webp',
                contentType: 'image/webp'
            });

            const mediaResponse = await axios.post(`${WP_API_URL}/wp-json/wp/v2/media`, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Content-Type': 'multipart/form-data',
                },
                auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }
            });
            featuredMediaId = mediaResponse.data.id;
        } else {
            // Use the simplified keywords for Unsplash search
            const imageKeywords = generateImageKeywords(topic); // Use original topic, not capitalized
            featuredMediaId = await setFeaturedImage(imageKeywords);
        }

        // Create the post
        const wpResponse = await axios.post(`${WP_API_URL}/wp-json/wp/v2/posts`, {
            title: capitalizedTopic,
            content: blogContent,
            status: 'publish',
            categories: [await getOrCreateCategory(category)],
            tags: await getOrCreateTags(tags),
            featured_media: featuredMediaId
        }, {
            auth: {
                username: WP_USERNAME,
                password: WP_APP_PASSWORD
            }
        });

        res.json({ success: true, post: wpResponse.data });
    } catch (error) {
        console.error('Error details:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/rewrite-post', upload.single('image'), async (req, res) => {
    try {
        statusEmitter.emit('status', 'Processing request data...');
        const { title, content, category, tags, model } = req.body;
        const uploadedImage = req.file;
        const parsedTags = JSON.parse(tags);
        const capitalizedTitle = capitalizeTitle(title);

        // Enhanced rewrite prompt
        const rewritePrompt = `Enhance and optimize this blog post while maintaining its core message:

        Original Title: ${capitalizedTitle}
        Content: ${content}
        
        Requirements:
        1. Create a new SEO-optimized title (do not use any markdown or special characters)
        2. Keep the main topic and key points
        3. Enhance SEO optimization
        4. Add any missing sections that would improve completeness
        5. Use clean HTML formatting with h1, h2, and p tags
        6. Add bullet points or numbered lists where appropriate
        7. Total word count should be at least 1000 words (do not include word count in the output)
        
        Format the response with:
        TITLE: [Your new optimized title - no special characters or markdown]
        CATEGORY: ${category || '[suggest category]'}
        TAGS: ${parsedTags.length > 0 ? parsedTags.join(', ') : '[suggest tags]'}
        
        [Rest of the enhanced content in clean HTML - no markdown]`;

        statusEmitter.emit('status', 'Generating enhanced content with AI...');
        let enhancedContent = await generateWithOllama(rewritePrompt, model || 'mistral');

        // Extract metadata from the content
        let finalCategory = category;
        let finalTags = parsedTags;
        let finalTitle = capitalizedTitle;

        const titleMatch = enhancedContent.match(/TITLE:\s*(.+?)\n/);
        const categoryMatch = enhancedContent.match(/CATEGORY:\s*(.+?)\n/);
        const tagsMatch = enhancedContent.match(/TAGS:\s*(.+?)\n/);

        if (titleMatch) finalTitle = capitalizeTitle(titleMatch[1].trim());
        if (!category && categoryMatch) finalCategory = categoryMatch[1].trim();
        if (parsedTags.length === 0 && tagsMatch) {
            finalTags = tagsMatch[1].split(',').map(tag => tag.trim());
        }

        // Process the content
        enhancedContent = enhancedContent
            .replace(/^[`\s*#]+|[`\s*#]+$/g, '') // Remove backticks, asterisks, and hashes at start/end
            .replace(/\*\*|__/g, '') // Remove all bold markdown
            .replace(/#+\s/g, '') // Remove any remaining header markdown
            .replace(/CATEGORY:.*\n/, '')
            .replace(/TAGS:.*\n/, '')
            .replace(/TITLE:.*\n/, '')
            .replace(/Meta Description:.*?\n/g, '')
            .replace(/Keywords:.*$/s, '')
            .replace(/\n\n/g, '</p><p>')
            .replace(/###?\s*(.*?)\n/g, '<h2>$1</h2>')
            .replace(/^\s*["`'*]+|["`'*]+\s*$/g, '') // Remove quotes and asterisks
            .replace(/^\s+/, '')
            .replace(/\s+$/, '')
            .replace(/>\s+</g, '><')
            .replace(/Tags:.*$/, '')
            .trim();

        if (!enhancedContent.startsWith('<')) {
            enhancedContent = `<p>${enhancedContent.trim()}</p>`;
        }

        // Handle featured image
        let featuredMediaId = 0;
        if (uploadedImage) {
            statusEmitter.emit('status', 'Processing uploaded image...');
            const compressedImage = await compressImage(uploadedImage.buffer);
            
            const formData = new FormData();
            formData.append('file', compressedImage, {
                filename: 'featured-image.webp',
                contentType: 'image/webp'
            });

            const mediaResponse = await axios.post(`${WP_API_URL}/wp-json/wp/v2/media`, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Content-Type': 'multipart/form-data',
                },
                auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }
            });
            featuredMediaId = mediaResponse.data.id;
        } else {
            statusEmitter.emit('status', 'Fetching image from Unsplash...');
            const imageKeywords = generateImageKeywords(title);
            featuredMediaId = await setFeaturedImage(imageKeywords);
        }

        // Create WordPress post
        statusEmitter.emit('status', 'Creating WordPress post...');
        const wpResponse = await axios.post(`${WP_API_URL}/wp-json/wp/v2/posts`, {
            title: finalTitle,
            content: enhancedContent,
            status: 'publish',
            categories: [await getOrCreateCategory(finalCategory)],
            tags: await getOrCreateTags(finalTags),
            featured_media: featuredMediaId
        }, {
            auth: {
                username: WP_USERNAME,
                password: WP_APP_PASSWORD
            }
        });

        statusEmitter.emit('status', 'Post published successfully!');
        res.json({ success: true, post: wpResponse.data });
    } catch (error) {
        statusEmitter.emit('status', `Error: ${error.message}`);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/categories', async (req, res) => {
    try {
        const response = await axios.get(`${WP_API_URL}/wp-json/wp/v2/categories`, {
            params: { 
                per_page: 100,
                search: req.query.search || ''
            },
            auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

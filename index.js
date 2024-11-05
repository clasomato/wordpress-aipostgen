require('dotenv').config();
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const upload = multer();

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
        // Simplify the image prompt to basic keywords
        const keywords = imagePrompt.split(' ').slice(0, 3).join(',');
        const imageUrl = `https://source.unsplash.com/featured/1600x900/?${encodeURIComponent(keywords)}`;
        
        const imageResponse = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            maxRedirects: 5,
            validateStatus: function (status) {
                return status >= 200 && status < 500;
            }
        });

        if (imageResponse.status !== 200) {
            console.error('Failed to fetch image:', imageResponse.status);
            return 0;
        }

        // Compress image
        const compressedImage = await compressImage(imageResponse.data);
        
        // Check file size (100KB = 102400 bytes)
        if (compressedImage.length > 102400) {
            console.log('Image still too large after compression, attempting further compression');
            const furtherCompressed = await compressImage(compressedImage);
            if (furtherCompressed.length > 102400) {
                console.error('Unable to compress image to target size');
                return 0;
            }
            compressedImage = furtherCompressed;
        }

        const formData = new FormData();
        formData.append('file', new Blob([compressedImage]), 'featured-image.webp');

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

app.post('/generate-post', upload.single('image'), async (req, res) => {
    try {
        const { topic } = req.body;
        const uploadedImage = req.file;
        const capitalizedTopic = capitalizeTitle(topic);

        // Enhanced blog prompt for longer content
        const blogPrompt = `Write a comprehensive, SEO-optimized blog post/news article about ${capitalizedTopic}. 
            Requirements:
            1. Title: Create an engaging H1 title
            2. Meta Description: Write a compelling meta description (150-160 characters)
            3. Introduction: A strong opening paragraph that hooks the reader
            4. Main Content: Create 5-6 detailed sections with H2 headings
            5. Each section should be at least 150-200 words
            6. Include relevant examples and explanations
            7. Add bullet points or numbered lists where appropriate
            8. Conclusion: A thorough summary paragraph
            9. Total word count should be at least 1000 words
            10. Suggest one main category for the post
            11. Suggest 5-7 relevant tags for the post
            12. Suggest a detailed image prompt for a featured image
            
            Format the response with:
            CATEGORY: [category]
            TAGS: [tag1, tag2, tag3, tag4, tag5]
            IMAGE_PROMPT: [detailed image description]
            
            Then format the content in HTML using proper heading tags (h1, h2) and paragraph tags.
            Use <ul> and <li> for bullet points.
            Make the content engaging and informative for the reader.`;

        let blogContent = await generateWithOllama(blogPrompt);

        // Update the content processing to extract metadata
        let category = '';
        let tags = [];
        let imagePrompt = '';

        // Extract metadata from the content
        const categoryMatch = blogContent.match(/CATEGORY:\s*(.+?)\n/);
        const tagsMatch = blogContent.match(/TAGS:\s*(.+?)\n/);
        const imageMatch = blogContent.match(/IMAGE_PROMPT:\s*(.+?)\n/);

        if (categoryMatch) category = categoryMatch[1].trim();
        if (tagsMatch) tags = tagsMatch[1].split(',').map(tag => tag.trim());
        if (imageMatch) imagePrompt = imageMatch[1].trim();

        // Process the content
        blogContent = blogContent
            .replace(/CATEGORY:.*\n/, '')
            .replace(/TAGS:.*\n/, '')
            .replace(/IMAGE_PROMPT:.*\n/, '')
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

        // If an image was uploaded, use it instead of fetching from Unsplash
        let featuredMediaId = 0;
        if (uploadedImage) {
            // Compress and convert uploaded image
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
                auth: { username: WP_USERNAME, password: WP_APP_PASSWORD },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
            featuredMediaId = mediaResponse.data.id;
        } else {
            featuredMediaId = await setFeaturedImage(imagePrompt || capitalizedTopic);
        }

        // Create the post with metadata and uploaded image
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

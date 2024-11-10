# 1. Install dependencies
npm install

# 2. Create .env file in the root directory
touch .env

# 3. Add required environment variables to .env
echo "WP_API_URL=your_wordpress_site_url
WP_USERNAME=your_wordpress_username
WP_APP_PASSWORD=your_wordpress_application_password
UNSPLASH_ACCESS_KEY=your_unsplash_access_key" > .env

# 4. Install Ollama (if not already installed)
# For macOS:
curl https://ollama.ai/install.sh | sh

# For Linux:
curl https://ollama.ai/install.sh | sh

# 5. Pull required Ollama models
ollama pull mistral
ollama pull llama2

# 6. Start the server
npm start

# 8. Access the application
# Open http://localhost:3000 in your browser
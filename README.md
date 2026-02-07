# Kwanya - Hausa Conversational AI App

**Kwanya** (meaning "What is it?" in Hausa) is a modern conversational AI application designed to support users primarily in the Hausa language. The app features a clean, ChatGPT-like interface with both text and voice input/output capabilities.

## Features

### Core Functionality
- 🎙️ **Voice Input**: Tap-to-speak or hold-to-record with real-time waveform feedback
- ⌨️ **Text Input**: Type messages directly into the input box
- 🔊 **Voice Output**: AI responses are automatically spoken in Hausa
- 💬 **Chat Interface**: Modern, clean design similar to ChatGPT
- 🌓 **Dark/Light Mode**: Automatic theme switching based on system preferences
- 📱 **Cross-Platform**: Runs on iOS, Android, and Web
- 🗣️ **Hausa-First**: Default language is Hausa with culturally aware responses

### AI Capabilities
- **Speech Recognition**: Fine-tuned Whisper model optimized for Hausa speech
- **Conversational AI**: Google Gemini for intelligent, context-aware responses
- **Text-to-Speech**: Google Cloud TTS with native Hausa voice support

## Tech Stack

### Frontend
- **Framework**: Expo (React Native)
- **UI Components**: React Native core components
- **Audio**: expo-av for recording and playback
- **State Management**: React Hooks
- **HTTP Client**: Axios

### Backend
- **Framework**: FastAPI (Python)
- **Database**: MongoDB
- **AI Services**:
  - OpenAI Whisper API (Speech-to-Text)
  - Google Gemini (Conversational AI via emergentintegrations)
  - Google Cloud Text-to-Speech (Voice Output)

## Project Structure

```
/app
├── backend/
│   ├── server.py           # Main FastAPI application
│   ├── requirements.txt    # Python dependencies
│   └── .env               # Environment variables
├── frontend/
│   ├── app/
│   │   └── index.tsx      # Main Kwanya chat interface
│   ├── app.json           # Expo configuration
│   ├── package.json       # Node dependencies
│   └── .env               # Frontend environment variables
└── README.md              # This file
```

## API Endpoints

### Backend Endpoints (FastAPI)

#### Health Check
```
GET /api/health
```
Returns the health status of all services.

#### Create Conversation
```
POST /api/conversations
Body: { user_id: string, language: string }
```
Creates a new conversation session.

#### Speech-to-Text
```
POST /api/speech-to-text
Form Data:
  - audio: file (audio file in m4a/mp3 format)
  - user_id: string
  - conversation_id: string
```
Transcribes Hausa audio to text using OpenAI Whisper.

#### Chat
```
POST /api/chat
Body: {
  conversation_id: string,
  user_id: string,
  message: string,
  language: string
}
```
Generates AI response using Google Gemini.

#### Text-to-Speech
```
POST /api/text-to-speech
Body: {
  text: string,
  language: string,
  voice: string
}
```
Converts text to Hausa speech using Google Cloud TTS.

#### Get Conversations
```
GET /api/conversations/{user_id}
```
Retrieves all conversations for a user.

#### Get Messages
```
GET /api/conversations/{conversation_id}/messages
```
Retrieves all messages in a conversation.

#### Delete Conversation
```
DELETE /api/conversations/{conversation_id}
```
Deletes a conversation and its messages.

## Environment Variables

### Backend (.env)
```
MONGO_URL="mongodb://localhost:27017"
DB_NAME="menene_database"
EMERGENT_LLM_KEY="your-emergent-llm-key"
GOOGLE_TTS_API_KEY="your-google-tts-api-key"
```

### Frontend (.env)
```
EXPO_PUBLIC_BACKEND_URL="http://localhost:8001"
```

## Setup and Installation

### Prerequisites
- Node.js 18+
- Python 3.11+
- MongoDB
- Expo CLI
- API Keys:
  - Emergent LLM Key (for Whisper and Gemini)
  - Google Cloud TTS API Key

### Backend Setup

1. Install Python dependencies:
```bash
cd backend
pip install -r requirements.txt
```

2. Configure environment variables in `.env`

3. Start the server:
```bash
uvicorn server:app --host 0.0.0.0 --port 8001 --reload
```

### Frontend Setup

1. Install dependencies:
```bash
cd frontend
yarn install
```

2. Configure environment variables in `.env`

3. Start Expo:
```bash
yarn start
```

4. Run on your preferred platform:
   - Press `i` for iOS simulator
   - Press `a` for Android emulator
   - Press `w` for web browser
   - Scan QR code with Expo Go app for physical device

## Usage

### Voice Input
1. Tap the microphone button to start recording
2. Speak in Hausa
3. Tap the stop button when finished
4. Audio is automatically transcribed and sent to AI

### Text Input
1. Type your message in Hausa in the text input field
2. Tap the send button or press enter
3. AI will respond in Hausa with both text and voice

### Features
- Messages are stored in MongoDB for conversation history
- Audio responses are automatically played
- Cached TTS responses for improved performance
- Real-time recording timer
- Loading indicators during processing
- Error handling with user-friendly messages

## Database Schema

### Collections

#### conversations
```javascript
{
  id: string,
  user_id: string,
  title: string,
  language: string,
  created_at: datetime,
  updated_at: datetime
}
```

#### messages
```javascript
{
  id: string,
  conversation_id: string,
  role: 'user' | 'assistant',
  content: string,
  audio_url: string (optional),
  timestamp: datetime
}
```

#### audio_cache
```javascript
{
  text: string,
  language: string,
  voice: string,
  audio_content: string (base64),
  created_at: datetime
}
```

## Performance Optimizations

- **TTS Caching**: Audio responses are cached to reduce API calls and improve response time
- **Lazy Loading**: AI clients are initialized only when needed
- **Efficient Audio Handling**: Base64 encoding for seamless cross-platform audio playback
- **MongoDB Indexing**: Optimized queries for conversation and message retrieval

## Accessibility

- **Voice-First**: Primary interaction mode for users who prefer speaking
- **Clear Visual Feedback**: Recording indicators, loading states, and error messages
- **Keyboard Support**: Full keyboard navigation and input
- **Dark Mode**: Reduces eye strain in low-light environments
- **Cultural Awareness**: AI trained on Hausa language and West African context

## Future Enhancements

- [ ] Offline mode with local storage
- [ ] Multi-language support (beyond Hausa)
- [ ] Conversation export/sharing
- [ ] Custom voice selection
- [ ] Speech rate adjustment
- [ ] On-device model execution for improved privacy
- [ ] User authentication and profiles
- [ ] Conversation search and filtering
- [ ] Voice activity detection for automatic recording start/stop

## Troubleshooting

### Backend Issues
- **MongoDB Connection Error**: Ensure MongoDB is running locally or update `MONGO_URL` to your MongoDB Atlas connection string
- **API Key Errors**: Verify that all API keys are correctly set in the `.env` file
- **Import Errors**: Run `pip install -r requirements.txt` to ensure all dependencies are installed

### Frontend Issues
- **Audio Recording Not Working**: Check microphone permissions in device settings
- **Audio Playback Issues**: Ensure audio permissions are granted
- **Network Errors**: Verify `EXPO_PUBLIC_BACKEND_URL` points to the correct backend URL
- **Build Errors**: Clear cache with `expo start -c`

## License

This project is built for educational and demonstration purposes.

## Credits

- **Whisper API**: OpenAI
- **Gemini**: Google (via emergentintegrations)
- **Text-to-Speech**: Google Cloud
- **Framework**: Expo and FastAPI

---

**Kwanya** - Empowering Hausa speakers with AI-powered conversations

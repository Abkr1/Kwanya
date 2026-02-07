from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, Depends, Security
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import subprocess
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone
import aiofiles
import tempfile
import asyncio
from collections import defaultdict
import time
from concurrent.futures import ThreadPoolExecutor

# Hausa ASR (NCAIR1/Hausa-ASR) - Fine-tuned Whisper for Hausa
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
import soundfile as sf
import torchaudio
import torch

# Emergent integrations for Gemini
from emergentintegrations.llm.chat import LlmChat, UserMessage

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Thread pool for ASR processing
asr_executor = ThreadPoolExecutor(max_workers=2)

# ==================== HAUSA ASR MODEL (Abkrs1/Hausa-ASR-copy) ====================
# Fine-tuned Whisper model specifically for Hausa language
hausa_asr_pipe = None

def load_hausa_asr():
    """Load Abkrs1/Hausa-ASR-copy model for Hausa speech recognition"""
    global hausa_asr_pipe
    
    logger.info("Loading Hausa ASR model (Abkrs1/Hausa-ASR-copy)...")
    
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    
    model_id = "Abkrs1/Hausa-ASR-copy"
    
    hausa_asr_pipe = pipeline(
        "automatic-speech-recognition",
        model=model_id,
        torch_dtype=torch_dtype,
        device=device,
    )
    
    logger.info("Hausa ASR model loaded successfully!")
    return hausa_asr_pipe

def get_hausa_asr():
    """Get or load Hausa ASR pipeline"""
    global hausa_asr_pipe
    if hausa_asr_pipe is None:
        hausa_asr_pipe = load_hausa_asr()
    return hausa_asr_pipe

def transcribe_hausa_audio_sync(audio_path: str) -> str:
    """Synchronous Hausa audio transcription"""
    pipe = get_hausa_asr()
    
    # Load and resample audio to 16kHz if needed
    audio, sample_rate = sf.read(audio_path)
    
    if sample_rate != 16000:
        # Resample to 16kHz
        audio_tensor = torch.tensor(audio).float()
        if len(audio_tensor.shape) == 1:
            audio_tensor = audio_tensor.unsqueeze(0)
        resampler = torchaudio.transforms.Resample(orig_freq=sample_rate, new_freq=16000)
        audio_resampled = resampler(audio_tensor)
        audio = audio_resampled.squeeze().numpy()
    
    # Transcribe
    result = pipe(audio, generate_kwargs={"language": "ha", "task": "transcribe"})
    return result["text"]

# ==================== LIFESPAN ====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage startup and shutdown lifecycle"""
    yield

    # Shutdown
    client.close()
    asr_executor.shutdown(wait=False)


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# ==================== RATE LIMITING ====================

class RateLimiter:
    """Simple in-memory rate limiter per IP address"""
    def __init__(self, max_requests: int = 60, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._requests: dict[str, list[float]] = defaultdict(list)

    def is_allowed(self, key: str) -> bool:
        now = time.time()
        window_start = now - self.window_seconds
        # Remove expired entries
        self._requests[key] = [t for t in self._requests[key] if t > window_start]
        if len(self._requests[key]) >= self.max_requests:
            return False
        self._requests[key].append(now)
        return True

rate_limiter = RateLimiter(max_requests=60, window_seconds=60)


# ==================== AUTHENTICATION ====================

API_KEY = os.environ.get("API_KEY")
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

async def verify_api_key(api_key: Optional[str] = Security(api_key_header)):
    """Verify API key if one is configured in environment"""
    if not API_KEY:
        # No API key configured, allow all requests (development mode)
        return None
    if api_key != API_KEY:
        raise HTTPException(status_code=403, detail="Invalid or missing API key")
    return api_key


# Create the main app
app = FastAPI(
    title="Kwanya - Hausa Conversational AI",
    lifespan=lifespan,
)

# Create a router with the /api prefix and API key auth
api_router = APIRouter(prefix="/api", dependencies=[Depends(verify_api_key)])


# ==================== MODELS ====================

class Message(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    conversation_id: str
    role: str  # 'user' or 'assistant'
    content: str
    audio_url: Optional[str] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Conversation(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    title: str = "New Conversation"
    language: str = "ha"  # Hausa by default
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class TranscriptionRequest(BaseModel):
    user_id: str
    conversation_id: str


class ChatRequest(BaseModel):
    conversation_id: str
    user_id: str
    message: str
    language: str = "ha"


class ConversationCreate(BaseModel):
    user_id: str
    language: str = "ha"


# ==================== SPEECH TO TEXT ENDPOINT (Abkrs1/Hausa-ASR-copy) ====================

@api_router.post("/speech-to-text")
async def transcribe_audio(
    audio: UploadFile = File(...),
    user_id: str = File(...),
    conversation_id: str = File(...)
):
    """Transcribe Hausa audio using Abkrs1/Hausa-ASR-copy (fine-tuned Whisper for Hausa)"""
    try:
        logger.info(f"Received audio file: {audio.filename}, size: {audio.size}")
        
        # Save uploaded file temporarily
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".m4a")
        temp_path = temp_file.name
        
        async with aiofiles.open(temp_path, 'wb') as f:
            content = await audio.read()
            await f.write(content)
        
        # Convert M4A to WAV using ffmpeg (16kHz mono)
        wav_temp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        wav_path = wav_temp.name
        wav_temp.close()
        
        try:
            # Use ffmpeg to convert M4A to 16kHz mono WAV
            result = subprocess.run([
                'ffmpeg', '-y', '-i', temp_path,
                '-ar', '16000',  # Sample rate 16kHz
                '-ac', '1',      # Mono
                '-f', 'wav',     # Output format
                wav_path
            ], capture_output=True, text=True, timeout=30)
            
            if result.returncode != 0:
                logger.error(f"FFmpeg error: {result.stderr}")
                raise Exception(f"Audio conversion failed: {result.stderr}")
                
            logger.info("Audio converted to WAV successfully")
        except subprocess.TimeoutExpired:
            raise Exception("Audio conversion timed out")
        except FileNotFoundError:
            raise Exception("FFmpeg not found. Please install ffmpeg.")
        
        # Transcribe using Hausa ASR in thread pool
        loop = asyncio.get_running_loop()
        transcribed_text = await loop.run_in_executor(
            asr_executor,
            transcribe_hausa_audio_sync,
            wav_path
        )
        
        # Clean up temp files
        try:
            os.unlink(temp_path)
            os.unlink(wav_path)
        except OSError:
            pass
        
        # Save message to database
        message = Message(
            conversation_id=conversation_id,
            role="user",
            content=transcribed_text
        )
        
        await db.messages.insert_one(message.model_dump())
        
        # Update conversation timestamp
        await db.conversations.update_one(
            {"id": conversation_id},
            {"$set": {"updated_at": datetime.now(timezone.utc)}}
        )
        
        logger.info(f"Transcription successful: {transcribed_text[:50]}...")
        
        return {
            "success": True,
            "transcription": transcribed_text,
            "message_id": message.id
        }
        
    except Exception as e:
        logger.error(f"Transcription error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


# ==================== CHAT ENDPOINT ====================

@api_router.post("/chat")
async def chat(request: ChatRequest):
    """Generate conversational AI response using Google Gemini"""
    try:
        logger.info(f"Chat request for conversation: {request.conversation_id}")

        # Save user message to database
        user_msg = Message(
            conversation_id=request.conversation_id,
            role="user",
            content=request.message
        )
        await db.messages.insert_one(user_msg.model_dump())

        # Get conversation history
        messages = await db.messages.find(
            {"conversation_id": request.conversation_id}
        ).sort("timestamp", 1).to_list(100)

        # Initialize Gemini chat
        system_message = """You are a helpful AI assistant that speaks Hausa language.
You are friendly, knowledgeable, and culturally aware of West African contexts, particularly Nigeria.
Respond naturally in Hausa language and provide detailed, helpful responses.
Do not introduce yourself or mention your name; answer directly."""
        
        chat_session = LlmChat(
            api_key=os.environ.get('EMERGENT_LLM_KEY'),
            session_id=request.conversation_id,
            system_message=system_message
        )
        
        # Configure to use Gemini
        chat_session.with_model("gemini", "gemini-3-flash-preview")
        
        # Create user message
        user_message = UserMessage(text=request.message)
        
        # Get response from Gemini
        response = await chat_session.send_message(user_message)
        
        # Save assistant message to database
        assistant_message = Message(
            conversation_id=request.conversation_id,
            role="assistant",
            content=response
        )
        
        await db.messages.insert_one(assistant_message.model_dump())
        
        # Update conversation
        await db.conversations.update_one(
            {"id": request.conversation_id},
            {"$set": {"updated_at": datetime.now(timezone.utc)}}
        )
        
        logger.info(f"Chat response generated: {response[:50]}...")
        
        return {
            "success": True,
            "response": response,
            "message_id": assistant_message.id,
            "user_message_id": user_msg.id
        }

    except Exception as e:
        logger.error(f"Chat error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Chat failed: {str(e)}")


# ==================== CONVERSATION MANAGEMENT ====================

@api_router.post("/conversations", response_model=Conversation)
async def create_conversation(input: ConversationCreate):
    """Create a new conversation"""
    conversation = Conversation(
        user_id=input.user_id,
        language=input.language
    )
    await db.conversations.insert_one(conversation.model_dump())
    return conversation


@api_router.get("/conversations/{user_id}")
async def get_conversations(user_id: str):
    """Get all conversations for a user"""
    conversations = await db.conversations.find(
        {"user_id": user_id}, {"_id": 0}
    ).sort("updated_at", -1).to_list(100)
    
    return {"success": True, "conversations": conversations}


class ConversationUpdate(BaseModel):
    title: Optional[str] = None


@api_router.patch("/conversations/{conversation_id}")
async def update_conversation(conversation_id: str, update: ConversationUpdate):
    """Update a conversation (e.g., rename title)"""
    update_data = {"updated_at": datetime.now(timezone.utc)}
    if update.title:
        update_data["title"] = update.title
    
    await db.conversations.update_one(
        {"id": conversation_id},
        {"$set": update_data}
    )
    
    return {"success": True, "message": "Conversation updated"}


@api_router.get("/conversations/{conversation_id}/messages")
async def get_messages(conversation_id: str):
    """Get all messages in a conversation"""
    messages = await db.messages.find(
        {"conversation_id": conversation_id}, {"_id": 0}
    ).sort("timestamp", 1).to_list(1000)
    
    return {"success": True, "messages": messages}


@api_router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    """Delete a conversation and its messages"""
    await db.conversations.delete_one({"id": conversation_id})
    await db.messages.delete_many({"conversation_id": conversation_id})
    
    return {"success": True, "message": "Conversation deleted"}


# ==================== HEALTH CHECK ====================

@api_router.get("/health")
async def health_check():
    """Health check endpoint"""
    # Actually ping MongoDB to verify connectivity
    mongo_status = "disconnected"
    try:
        await client.admin.command("ping")
        mongo_status = "connected"
    except Exception:
        mongo_status = "disconnected"

    return {
        "status": "healthy" if mongo_status == "connected" else "degraded",
        "services": {
            "mongodb": mongo_status,
            "asr": "Abkrs1/Hausa-ASR-copy (fine-tuned Whisper for Hausa)",
            "gemini": "configured" if os.environ.get('EMERGENT_LLM_KEY') else "not configured",
        },
        "asr_engine": "Abkrs1/Hausa-ASR-copy (Fine-tuned Whisper Small)",
    }


# Include the router in the main app
app.include_router(api_router)

# CORS - restrict to known origins (allow all in development via env var)
allowed_origins = os.environ.get("ALLOWED_ORIGINS", "").split(",")
if not allowed_origins or allowed_origins == [""]:
    allowed_origins = ["http://localhost:8081", "http://localhost:19006"]

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

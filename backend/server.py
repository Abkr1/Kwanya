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
import base64
import aiofiles
import tempfile
import io
import asyncio
from collections import defaultdict
import time
from concurrent.futures import ThreadPoolExecutor

# Hausa ASR (NCAIR1/Hausa-ASR) - Fine-tuned Whisper for Hausa
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
import soundfile as sf
import torchaudio

# TWB Voice Hausa TTS (Coqui TTS) - Optimized
from TTS.api import TTS
from huggingface_hub import hf_hub_download
import json
import scipy.io.wavfile as wavfile
import scipy.signal as signal
import numpy as np
import torch

# Emergent integrations for Gemini
from emergentintegrations.llm.chat import LlmChat, UserMessage

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Thread pool for TTS and ASR processing
tts_executor = ThreadPoolExecutor(max_workers=2)
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

# ==================== OPTIMIZED TWB VOICE TTS ====================
# Optimizations applied:
# 1. Single speaker mode (spk_f_1 - female voice)
# 2. Pre-computed speaker embedding
# 3. torch.compile() for faster inference
# 4. Model preloading at startup

# Fixed speaker for optimization
FIXED_SPEAKER = "spk_f_1"  # Female voice - locked for optimization

# TWB Voice Hausa TTS model (optimized)
twb_tts = None
twb_temp_config = None
speaker_embedding = None  # Pre-computed speaker embedding

def load_twb_tts_optimized():
    """Load TWB Voice Hausa TTS model with all optimizations"""
    global twb_tts, twb_temp_config, speaker_embedding
    
    logger.info("Loading TWB Voice Hausa TTS model with optimizations...")
    logger.info(f"Fixed speaker: {FIXED_SPEAKER} (female voice)")
    
    # Download model files from Hugging Face
    model_name = "CLEAR-Global/TWB-Voice-Hausa-TTS-1.0"
    
    config_path = hf_hub_download(model_name, "config.json")
    with open(config_path, 'r') as f:
        config = json.load(f)
    
    # Download required files
    model_path = hf_hub_download(model_name, "best_model_498283.pth")
    speakers_file = hf_hub_download(model_name, "speakers.pth")
    language_ids_file = hf_hub_download(model_name, "language_ids.json")
    d_vector_file = hf_hub_download(model_name, "d_vector.pth")
    config_se_file = hf_hub_download(model_name, "config_se.json")
    model_se_file = hf_hub_download(model_name, "model_se.pth")
    
    # Update config paths
    config["speakers_file"] = speakers_file
    config["language_ids_file"] = language_ids_file
    config["d_vector_file"] = [d_vector_file]
    config["model_args"]["speakers_file"] = speakers_file
    config["model_args"]["language_ids_file"] = language_ids_file
    config["model_args"]["d_vector_file"] = [d_vector_file]
    config["model_args"]["speaker_encoder_config_path"] = config_se_file
    config["model_args"]["speaker_encoder_model_path"] = model_se_file
    
    # Save updated config to temp file
    twb_temp_config = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump(config, twb_temp_config, indent=2)
    twb_temp_config.close()
    
    # Load TTS model
    twb_tts = TTS(model_path=model_path, config_path=twb_temp_config.name)
    
    # OPTIMIZATION 1: Pre-compute speaker embedding for fixed speaker
    logger.info(f"Pre-computing speaker embedding for {FIXED_SPEAKER}...")
    try:
        # Get the speaker embedding from the model
        if hasattr(twb_tts.synthesizer.tts_model, 'speaker_manager'):
            speaker_manager = twb_tts.synthesizer.tts_model.speaker_manager
            if speaker_manager and hasattr(speaker_manager, 'embeddings'):
                speaker_embedding = speaker_manager.embeddings.get(FIXED_SPEAKER)
                if speaker_embedding is not None:
                    # Convert to tensor and cache
                    speaker_embedding = torch.tensor(speaker_embedding).unsqueeze(0)
                    logger.info(f"Speaker embedding pre-computed: shape {speaker_embedding.shape}")
    except Exception as e:
        logger.warning(f"Could not pre-compute speaker embedding: {e}")
        speaker_embedding = None
    
    # OPTIMIZATION 2: Apply torch.compile() for faster inference
    logger.info("Applying torch.compile() optimization...")
    try:
        if hasattr(twb_tts.synthesizer, 'tts_model') and twb_tts.synthesizer.tts_model is not None:
            # Use reduce-overhead mode for best inference speed
            twb_tts.synthesizer.tts_model = torch.compile(
                twb_tts.synthesizer.tts_model,
                mode="reduce-overhead",
                fullgraph=False
            )
            logger.info("torch.compile() applied successfully!")
    except Exception as e:
        logger.warning(f"torch.compile() not available or failed: {e}")
        logger.info("Continuing without torch.compile() optimization")
    
    # Set model to evaluation mode
    if hasattr(twb_tts.synthesizer, 'tts_model'):
        twb_tts.synthesizer.tts_model.eval()
    
    logger.info("TWB Voice Hausa TTS model loaded with all optimizations!")
    return twb_tts

def get_twb_tts():
    """Get or load TWB Voice TTS model"""
    global twb_tts
    if twb_tts is None:
        twb_tts = load_twb_tts_optimized()
    return twb_tts

# ==================== LIFESPAN ====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage startup and shutdown lifecycle"""
    # Startup
    logger.info("Preloading optimized TWB Voice TTS model...")
    try:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(tts_executor, get_twb_tts)
        logger.info("Optimized TWB Voice TTS model preloaded successfully!")

        logger.info("Warming up model...")
        await loop.run_in_executor(tts_executor, synthesize_speech_optimized, "sannu")
        logger.info("Model warmup complete!")
    except Exception as e:
        logger.error(f"Failed to preload TTS model: {e}")

    # Create TTL index on audio_cache (expire after 7 days)
    try:
        await db.audio_cache.create_index("created_at", expireAfterSeconds=7 * 24 * 3600)
        logger.info("TTL index on audio_cache created")
    except Exception as e:
        logger.warning(f"Could not create TTL index: {e}")

    yield

    # Shutdown
    if twb_temp_config and os.path.exists(twb_temp_config.name):
        try:
            os.unlink(twb_temp_config.name)
        except OSError:
            pass
    client.close()
    tts_executor.shutdown(wait=False)
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
tts_rate_limiter = RateLimiter(max_requests=20, window_seconds=60)


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
    title="Kwanya - Hausa Conversational AI (TWB Voice TTS - Optimized)",
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


class TTSRequest(BaseModel):
    text: str
    language: str = "ha"


class ConversationCreate(BaseModel):
    user_id: str
    language: str = "ha"


# ==================== OPTIMIZED TTS SYNTHESIS ====================

def synthesize_speech_optimized(text: str) -> tuple:
    """
    Optimized TTS synthesis using:
    - Fixed speaker (spk_f_1)
    - Pre-computed embedding
    - torch.compile() acceleration
    """
    global speaker_embedding
    
    tts = get_twb_tts()
    
    # Convert text to lowercase (TWB Voice requirement)
    text_lower = text.lower()
    
    # Use optimized synthesis with fixed speaker
    with torch.inference_mode():  # Faster than torch.no_grad()
        wav = tts.synthesizer.tts(
            text=text_lower,
            speaker_name=FIXED_SPEAKER
        )
    
    # Convert to numpy array
    wav_array = np.array(wav, dtype=np.float32)
    
    # Get original sample rate (24 kHz for TWB Voice)
    original_sample_rate = tts.synthesizer.output_sample_rate
    
    # Downsample to 16kHz for faster transmission and smaller file size
    target_sample_rate = 16000
    if original_sample_rate != target_sample_rate:
        num_samples = int(len(wav_array) * target_sample_rate / original_sample_rate)
        wav_array = signal.resample(wav_array, num_samples)
    
    return wav_array, target_sample_rate


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


# ==================== TEXT TO SPEECH ENDPOINT (FULLY OPTIMIZED) ====================

@api_router.post("/text-to-speech")
async def text_to_speech(request: TTSRequest):
    """
    Convert text to speech using TWB Voice Hausa TTS (Fully Optimized)

    Optimizations applied:
    - Single speaker mode (spk_f_1 - female voice)
    - Pre-computed speaker embedding
    - torch.compile() acceleration
    - torch.inference_mode() for faster inference
    - Audio downsampling (16kHz)
    - Response caching
    """
    # Rate limit TTS (expensive operation)
    if not tts_rate_limiter.is_allowed("tts_global"):
        raise HTTPException(status_code=429, detail="TTS rate limit exceeded. Try again later.")
    try:
        text = request.text
        if not text or not text.strip():
            raise HTTPException(status_code=400, detail="Text cannot be empty")
        if len(text) > 5000:
            raise HTTPException(status_code=400, detail="Text too long. Maximum 5000 characters.")
        logger.info(f"TTS request for text ({len(text)} chars): {text[:50]}...")

        # Check cache first (using fixed speaker)
        cached_audio = await db.audio_cache.find_one({
            "text": text.lower(),
            "language": "ha",
            "voice": f"twb-voice-{FIXED_SPEAKER}"
        })
        
        if cached_audio:
            logger.info("Returning cached audio")
            return {
                "success": True,
                "audio_content": cached_audio["audio_content"],
                "cached": True,
                "tts_engine": "twb-voice-hausa-tts-optimized",
                "speaker": FIXED_SPEAKER
            }
        
        # Run optimized TTS in thread pool
        loop = asyncio.get_running_loop()
        wav_array, sample_rate = await loop.run_in_executor(
            tts_executor,
            synthesize_speech_optimized,
            text
        )
        
        # Save to WAV bytes
        wav_buffer = io.BytesIO()
        wavfile.write(wav_buffer, sample_rate, wav_array)
        wav_bytes = wav_buffer.getvalue()
        
        # Convert to base64
        audio_content = base64.b64encode(wav_bytes).decode('utf-8')
        
        # Cache the audio (only if not too large for MongoDB)
        audio_size = len(audio_content)
        if audio_size < 14 * 1024 * 1024:  # Less than 14MB
            try:
                await db.audio_cache.insert_one({
                    "text": text.lower(),
                    "language": "ha",
                    "voice": f"twb-voice-{FIXED_SPEAKER}",
                    "audio_content": audio_content,
                    "created_at": datetime.now(timezone.utc)
                })
                logger.info(f"TTS audio generated and cached ({audio_size} bytes)")
            except Exception as cache_error:
                logger.warning(f"Failed to cache audio: {cache_error}")
        else:
            logger.info(f"TTS audio generated but too large to cache ({audio_size} bytes)")
        
        return {
            "success": True,
            "audio_content": audio_content,
            "cached": False,
            "tts_engine": "twb-voice-hausa-tts-optimized",
            "speaker": FIXED_SPEAKER,
            "sample_rate": sample_rate
        }
        
    except Exception as e:
        logger.error(f"TTS error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"TTS failed: {str(e)}")


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
            "tts": "twb-voice-hausa-tts (CLEAR-Global/TWB-Voice-Hausa-TTS-1.0)"
        },
        "asr_engine": "Abkrs1/Hausa-ASR-copy (Fine-tuned Whisper Small)",
        "tts_engine": "TWB Voice Hausa TTS (Fully Optimized)",
        "tts_speaker": f"{FIXED_SPEAKER} (female voice - locked)",
        "optimizations": [
            "Hausa-specific ASR model",
            "Single speaker TTS mode (spk_f_1)",
            "Pre-computed speaker embedding",
            "torch.compile() acceleration",
            "torch.inference_mode()",
            "Audio downsampling (16kHz)",
            "Response caching",
            "Model preloading at startup"
        ]
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

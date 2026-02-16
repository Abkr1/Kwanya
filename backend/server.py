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
import shutil
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone, timedelta
import aiofiles
import tempfile
import asyncio
from collections import defaultdict
import time
from concurrent.futures import ThreadPoolExecutor
import bcrypt
from jose import jwt as jose_jwt, JWTError
import re
import secrets

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

# JWT Configuration
JWT_SECRET = os.environ.get("JWT_SECRET", "kwanya-dev-secret-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24 * 30  # 30 days

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

HAS_FFMPEG = shutil.which("ffmpeg") is not None


def convert_audio_to_wav(input_path: str, output_path: str) -> None:
    """Convert audio file to 16kHz mono WAV. Uses ffmpeg if available, otherwise torchaudio."""
    if HAS_FFMPEG:
        result = subprocess.run([
            'ffmpeg', '-y', '-i', input_path,
            '-ar', '16000', '-ac', '1', '-f', 'wav', output_path
        ], capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise Exception(f"FFmpeg conversion failed: {result.stderr}")
    else:
        # Fallback: use torchaudio to load and convert
        waveform, sample_rate = torchaudio.load(input_path)
        # Convert to mono if stereo
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        # Resample to 16kHz
        if sample_rate != 16000:
            resampler = torchaudio.transforms.Resample(orig_freq=sample_rate, new_freq=16000)
            waveform = resampler(waveform)
        torchaudio.save(output_path, waveform, 16000)


def transcribe_hausa_audio_sync(audio_path: str) -> str:
    """Synchronous Hausa audio transcription"""
    pipe = get_hausa_asr()

    # Load and resample audio to 16kHz if needed
    audio, sample_rate = sf.read(audio_path)

    if sample_rate != 16000:
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
    # Log audio conversion backend
    logger.info(f"Audio conversion: {'ffmpeg' if HAS_FFMPEG else 'torchaudio (ffmpeg not found)'}")

    # Preload Hausa ASR model in background thread so first request isn't slow
    loop = asyncio.get_running_loop()
    loop.run_in_executor(asr_executor, load_hausa_asr)

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


# ==================== USER & AUTH MODELS ====================

class User(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    phone: Optional[str] = None
    email: str
    display_name: Optional[str] = None
    auth_provider: str  # "phone", "email", "google"
    password_hash: Optional[str] = None
    google_id: Optional[str] = None
    is_phone_verified: bool = False
    is_email_verified: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PhoneSignupRequest(BaseModel):
    phone: str
    password: str
    display_name: Optional[str] = None


class EmailSignupRequest(BaseModel):
    email: str
    password: str
    display_name: Optional[str] = None


class GoogleSignupRequest(BaseModel):
    google_token: str
    display_name: Optional[str] = None


class SigninRequest(BaseModel):
    identifier: str  # phone or email
    password: str


class GoogleSigninRequest(BaseModel):
    google_token: str


class VerifyOTPRequest(BaseModel):
    phone: str
    otp: str


class VerifyEmailCodeRequest(BaseModel):
    email: str
    code: str


class ResendOTPRequest(BaseModel):
    phone: str


class ResendEmailCodeRequest(BaseModel):
    email: str


class UpdateProfileRequest(BaseModel):
    display_name: Optional[str] = None


# ==================== AUTH HELPERS ====================

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))


def create_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jose_jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_current_user(authorization: Optional[str] = None):
    """Extract and verify current user from JWT token"""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[7:]
    try:
        payload = jose_jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            return None
        user = await db.users.find_one({"id": user_id}, {"_id": 0})
        return user
    except JWTError:
        return None


def generate_email_from_phone(phone: str) -> str:
    """Generate an email address from phone number using trulib.com domain"""
    clean_phone = re.sub(r'[^\d]', '', phone)
    return f"{clean_phone}@trulib.com"


def generate_otp() -> str:
    """Generate a 6-digit OTP"""
    return f"{secrets.randbelow(1000000):06d}"


def sanitize_user(user: dict) -> dict:
    """Return safe user data (no password hash)"""
    return {
        "id": user["id"],
        "phone": user.get("phone"),
        "email": user["email"],
        "display_name": user.get("display_name"),
        "auth_provider": user["auth_provider"],
        "is_phone_verified": user.get("is_phone_verified", False),
        "is_email_verified": user.get("is_email_verified", False),
        "created_at": user.get("created_at"),
    }


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
        
        # Convert M4A to WAV (16kHz mono) — uses ffmpeg if available, otherwise torchaudio
        wav_temp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        wav_path = wav_temp.name
        wav_temp.close()

        convert_audio_to_wav(temp_path, wav_path)
        logger.info(f"Audio converted to WAV successfully (using {'ffmpeg' if HAS_FFMPEG else 'torchaudio'})")
        
        # Transcribe using Hausa ASR in thread pool (90s timeout to avoid Cloudflare 520)
        loop = asyncio.get_running_loop()
        try:
            transcribed_text = await asyncio.wait_for(
                loop.run_in_executor(
                    asr_executor,
                    transcribe_hausa_audio_sync,
                    wav_path
                ),
                timeout=90
            )
        except asyncio.TimeoutError:
            raise Exception("Transcription timed out. The ASR model may still be loading — please try again.")
        
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
    """Get all conversations for a user that have at least one message"""
    pipeline = [
        {"$match": {"user_id": user_id}},
        {"$lookup": {
            "from": "messages",
            "localField": "id",
            "foreignField": "conversation_id",
            "as": "msgs",
        }},
        {"$match": {"msgs": {"$ne": []}}},
        {"$project": {"msgs": 0, "_id": 0}},
        {"$sort": {"updated_at": -1}},
        {"$limit": 100},
    ]
    conversations = await db.conversations.aggregate(pipeline).to_list(100)

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


# ==================== AUTH ENDPOINTS ====================

auth_router = APIRouter(prefix="/api/auth")


@auth_router.post("/signup/phone")
async def signup_with_phone(request: PhoneSignupRequest):
    """Sign up with phone number - auto-generates email at trulib.com"""
    # Validate phone format (basic check)
    clean_phone = re.sub(r'[^\d+]', '', request.phone)
    if len(clean_phone) < 10:
        raise HTTPException(status_code=400, detail="Invalid phone number")

    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    # Check if phone already exists
    existing = await db.users.find_one({"phone": clean_phone})
    if existing:
        raise HTTPException(status_code=400, detail="Phone number already registered")

    # Generate email from phone number
    email = generate_email_from_phone(clean_phone)

    user = User(
        phone=clean_phone,
        email=email,
        display_name=request.display_name or clean_phone,
        auth_provider="phone",
        password_hash=hash_password(request.password),
    )

    await db.users.insert_one(user.model_dump())

    # Generate OTP for phone verification
    otp = generate_otp()
    await db.otps.insert_one({
        "phone": clean_phone,
        "otp": otp,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
    })

    logger.info(f"OTP for {clean_phone}: {otp}")  # In production, send via SMS

    token = create_token(user.id)

    return {
        "success": True,
        "token": token,
        "user": sanitize_user(user.model_dump()),
        "otp_sent": True,
    }


@auth_router.post("/signup/email")
async def signup_with_email(request: EmailSignupRequest):
    """Sign up with email and password"""
    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    # Check if email already exists
    existing = await db.users.find_one({"email": request.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        email=request.email.lower(),
        display_name=request.display_name or request.email.split("@")[0],
        auth_provider="email",
        password_hash=hash_password(request.password),
    )

    await db.users.insert_one(user.model_dump())

    # Generate email verification code
    code = generate_otp()
    await db.email_codes.insert_one({
        "email": request.email.lower(),
        "code": code,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
    })

    logger.info(f"Email verification code for {request.email.lower()}: {code}")  # In production, send via email

    token = create_token(user.id)

    return {
        "success": True,
        "token": token,
        "user": sanitize_user(user.model_dump()),
        "verification_sent": True,
    }


@auth_router.post("/signup/google")
async def signup_with_google(request: GoogleSignupRequest):
    """Sign up with Google OAuth token"""
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests

        GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
        if not GOOGLE_CLIENT_ID:
            raise HTTPException(status_code=500, detail="Google sign-in not configured")

        idinfo = id_token.verify_oauth2_token(
            request.google_token, google_requests.Request(), GOOGLE_CLIENT_ID
        )

        google_id = idinfo["sub"]
        email = idinfo.get("email", "")
        name = idinfo.get("name", "")

        # Check if Google account already linked
        existing = await db.users.find_one({"google_id": google_id})
        if existing:
            raise HTTPException(status_code=400, detail="Google account already registered. Please sign in.")

        existing_email = await db.users.find_one({"email": email})
        if existing_email:
            raise HTTPException(status_code=400, detail="Email already registered with another method")

        user = User(
            email=email,
            display_name=name or request.display_name,
            auth_provider="google",
            google_id=google_id,
            is_email_verified=True,  # Google already verifies email
        )

        await db.users.insert_one(user.model_dump())
        token = create_token(user.id)

        return {
            "success": True,
            "token": token,
            "user": sanitize_user(user.model_dump()),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Google signup error: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Google authentication failed: {str(e)}")


@auth_router.post("/signin")
async def signin(request: SigninRequest):
    """Sign in with phone or email + password"""
    identifier = request.identifier.strip()

    user = await db.users.find_one({
        "$or": [
            {"phone": identifier},
            {"email": identifier.lower()},
        ]
    })

    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not user.get("password_hash"):
        raise HTTPException(status_code=401, detail="This account uses Google sign-in")

    if not verify_password(request.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_token(user["id"])

    return {
        "success": True,
        "token": token,
        "user": sanitize_user(user),
    }


@auth_router.post("/signin/google")
async def signin_with_google(request: GoogleSigninRequest):
    """Sign in with Google OAuth token"""
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests

        GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
        if not GOOGLE_CLIENT_ID:
            raise HTTPException(status_code=500, detail="Google sign-in not configured")

        idinfo = id_token.verify_oauth2_token(
            request.google_token, google_requests.Request(), GOOGLE_CLIENT_ID
        )

        google_id = idinfo["sub"]

        user = await db.users.find_one({"google_id": google_id})
        if not user:
            raise HTTPException(status_code=401, detail="No account found. Please sign up first.")

        token = create_token(user["id"])

        return {
            "success": True,
            "token": token,
            "user": sanitize_user(user),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Google signin error: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Google authentication failed: {str(e)}")


@auth_router.post("/verify-otp")
async def verify_otp(request: VerifyOTPRequest):
    """Verify phone OTP code"""
    clean_phone = re.sub(r'[^\d+]', '', request.phone)

    otp_record = await db.otps.find_one({
        "phone": clean_phone,
        "otp": request.otp,
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    })

    if not otp_record:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP")

    # Mark phone as verified
    await db.users.update_one(
        {"phone": clean_phone},
        {"$set": {"is_phone_verified": True, "updated_at": datetime.now(timezone.utc)}}
    )

    # Clean up used OTP
    await db.otps.delete_many({"phone": clean_phone})

    return {"success": True, "message": "Phone number verified"}


@auth_router.post("/verify-email")
async def verify_email(request: VerifyEmailCodeRequest):
    """Verify email with 6-digit code"""
    email = request.email.lower()

    code_record = await db.email_codes.find_one({
        "email": email,
        "code": request.code,
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    })

    if not code_record:
        raise HTTPException(status_code=400, detail="Invalid or expired code")

    # Mark email as verified
    await db.users.update_one(
        {"email": email},
        {"$set": {"is_email_verified": True, "updated_at": datetime.now(timezone.utc)}}
    )

    # Clean up used codes
    await db.email_codes.delete_many({"email": email})

    return {"success": True, "message": "Email verified"}


@auth_router.post("/resend-otp")
async def resend_otp(request: ResendOTPRequest):
    """Resend phone OTP"""
    clean_phone = re.sub(r'[^\d+]', '', request.phone)

    user = await db.users.find_one({"phone": clean_phone})
    if not user:
        raise HTTPException(status_code=404, detail="Phone number not found")

    if user.get("is_phone_verified"):
        raise HTTPException(status_code=400, detail="Phone already verified")

    # Delete old OTPs and create new one
    await db.otps.delete_many({"phone": clean_phone})
    otp = generate_otp()
    await db.otps.insert_one({
        "phone": clean_phone,
        "otp": otp,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
    })

    logger.info(f"Resent OTP for {clean_phone}: {otp}")  # In production, send via SMS

    return {"success": True, "message": "OTP resent"}


@auth_router.post("/resend-email-code")
async def resend_email_code(request: ResendEmailCodeRequest):
    """Resend email verification code"""
    email = request.email.lower()

    user = await db.users.find_one({"email": email})
    if not user:
        raise HTTPException(status_code=404, detail="Email not found")

    if user.get("is_email_verified"):
        raise HTTPException(status_code=400, detail="Email already verified")

    # Delete old codes and create new one
    await db.email_codes.delete_many({"email": email})
    code = generate_otp()
    await db.email_codes.insert_one({
        "email": email,
        "code": code,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
    })

    logger.info(f"Resent email code for {email}: {code}")  # In production, send via email

    return {"success": True, "message": "Verification code resent"}


@auth_router.get("/me")
async def get_me(authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False))):
    """Get current authenticated user"""
    user = await get_current_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return {
        "success": True,
        "user": sanitize_user(user),
    }


@auth_router.patch("/profile")
async def update_profile(
    update: UpdateProfileRequest,
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Update user profile"""
    user = await get_current_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    update_data = {"updated_at": datetime.now(timezone.utc)}
    if update.display_name:
        update_data["display_name"] = update.display_name

    await db.users.update_one({"id": user["id"]}, {"$set": update_data})

    return {"success": True, "message": "Profile updated"}


@auth_router.post("/signout")
async def signout():
    """Sign out (client-side token removal)"""
    return {"success": True, "message": "Signed out successfully"}


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
            "audio_converter": "ffmpeg" if HAS_FFMPEG else "torchaudio",
        },
        "asr_engine": "Abkrs1/Hausa-ASR-copy (Fine-tuned Whisper Small)",
    }


# Include the routers in the main app
app.include_router(api_router)
app.include_router(auth_router)

# CORS - restrict to known origins (allow all in development via env var)
allowed_origins = os.environ.get("ALLOWED_ORIGINS", "").split(",")
if not allowed_origins or allowed_origins == [""]:
    allowed_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

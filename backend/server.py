from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, Depends, Security, Request, Header
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
import json
import re
import secrets
import httpx
import hashlib
import hmac
import base64

# Hausa ASR (NCAIR1/Hausa-ASR) - Fine-tuned Whisper for Hausa
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
import soundfile as sf
import torchaudio
import torch

# Google Gemini
from google import genai

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

# Termii SMS Configuration
TERMII_API_KEY = os.environ.get("TERMII_API_KEY", "")
TERMII_SENDER_ID = os.environ.get("TERMII_SENDER_ID", "Kwanya")

# Resend Email Configuration
TERMII_EMAIL_CONFIG_ID = os.environ.get("TERMII_EMAIL_CONFIG_ID", "")

# Monnify Configuration
MONNIFY_API_KEY = os.environ.get("MONNIFY_API_KEY", "")
MONNIFY_SECRET_KEY = os.environ.get("MONNIFY_SECRET_KEY", "")
MONNIFY_CONTRACT_CODE = os.environ.get("MONNIFY_CONTRACT_CODE", "")
MONNIFY_BASE_URL = os.environ.get("MONNIFY_BASE_URL", "https://sandbox.monnify.com")

# Monnify token cache
_monnify_token_cache: dict = {"token": None, "expires_at": 0.0}

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
auth_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)


async def check_rate_limit(request: Request):
    """Rate limit dependency for general API endpoints"""
    client_ip = request.client.host if request.client else "unknown"
    if not rate_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=429, detail="Too many requests. Please try again later.")


async def check_auth_rate_limit(request: Request):
    """Stricter rate limit for auth endpoints (10 req/min)"""
    client_ip = request.client.host if request.client else "unknown"
    if not auth_rate_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=429, detail="Too many attempts. Please try again later.")


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
api_router = APIRouter(prefix="/api", dependencies=[Depends(verify_api_key), Depends(check_rate_limit)])


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


# ==================== CREDITS & PAYMENT MODELS ====================

class InitPaymentRequest(BaseModel):
    amount: float
    credits: int


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


class ForgotPasswordRequest(BaseModel):
    identifier: str  # phone or email


class ResetPasswordRequest(BaseModel):
    identifier: str
    code: str
    new_password: str


class UpdateProfileRequest(BaseModel):
    display_name: Optional[str] = None


# ==================== AUTH HELPERS ====================

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))


def is_valid_pin(pin: str) -> bool:
    """Check if PIN is exactly 4 digits"""
    return bool(re.fullmatch(r'\d{4}', pin))


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


def normalize_phone(phone: str) -> str:
    """Normalize phone to local format: 0XXXXXXXXXX.
    Converts +234..., 234... to 0... format."""
    digits = re.sub(r'[^\d]', '', phone.lstrip("+"))
    if digits.startswith("234") and len(digits) > 10:
        digits = "0" + digits[3:]
    if not digits.startswith("0"):
        digits = "0" + digits
    return digits


def phone_to_international(phone: str) -> str:
    """Convert local phone (0XXXXXXXXXX) to international format (234XXXXXXXXXX) for Termii."""
    digits = re.sub(r'[^\d]', '', phone)
    if digits.startswith("0"):
        digits = "234" + digits[1:]
    return digits


def generate_email_from_phone(phone: str) -> str:
    """Generate an email address from phone number using trulib.com domain"""
    clean_phone = re.sub(r'[^\d]', '', phone)
    return f"{clean_phone}@trulib.com"


def generate_otp() -> str:
    """Generate a 6-digit OTP"""
    return f"{secrets.randbelow(1000000):06d}"


async def send_sms_otp(phone: str) -> Optional[str]:
    """Send OTP via Termii Token API. Termii generates and delivers the PIN.
    Returns the pinId on success (needed for verification), or None on failure."""
    if not TERMII_API_KEY or TERMII_API_KEY.startswith("<"):
        logger.warning(f"Termii not configured — cannot send OTP to {phone[-4:]}")
        return None

    # Convert to international format for Termii API
    clean_phone = phone_to_international(phone)

    # Use N-Alert sender ID on DND channel
    sender_options = [
        {"from": "N-Alert", "channel": "dnd"},
    ]

    try:
        async with httpx.AsyncClient(timeout=15) as http:
            for option in sender_options:
                payload = {
                    "api_key": TERMII_API_KEY,
                    "message_type": "NUMERIC",
                    "to": clean_phone,
                    "from": option["from"],
                    "channel": option["channel"],
                    "pin_attempts": 3,
                    "pin_time_to_live": 5,
                    "pin_length": 6,
                    "pin_placeholder": "< 123456 >",
                    "message_text": "Your Kwanya verification code is < 123456 >. It expires in 5 minutes.",
                    "pin_type": "NUMERIC",
                }
                resp = await http.post("https://api.ng.termii.com/api/sms/otp/send", json=payload)
                data = resp.json()
                logger.info(f"Termii Token API ({option['from']}/{option['channel']}) for {clean_phone[-4:]}: status={resp.status_code} body={data}")

                if resp.status_code == 200 and data.get("pinId"):
                    logger.info(f"OTP sent to {clean_phone[-4:]} via {option['from']}/{option['channel']} (pinId={data['pinId']})")
                    return data["pinId"]

                logger.warning(f"Termii {option['from']}/{option['channel']} failed for {clean_phone[-4:]}")

            logger.error(f"All Termii channels failed for {clean_phone[-4:]}")
            return None
    except Exception as e:
        logger.error(f"Termii OTP failed for {phone[-4:]}: {e}")
        return None


async def verify_sms_otp_via_termii(pin_id: str, otp: str) -> bool:
    """Verify OTP via Termii's verify endpoint. Returns True if valid."""
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            resp = await http.post("https://api.ng.termii.com/api/sms/otp/verify", json={
                "api_key": TERMII_API_KEY,
                "pin_id": pin_id,
                "pin": otp,
            })
            data = resp.json()
            logger.info(f"Termii verify response: status={resp.status_code} body={data}")
            return resp.status_code == 200 and data.get("verified") == True
    except Exception as e:
        logger.error(f"Termii verify failed: {e}")
        return False


@api_router.get("/debug/test-sms/{phone}")
async def debug_test_sms(phone: str):
    """Debug endpoint: list sender IDs and test Token OTP API with Termii default."""
    clean_phone = phone_to_international(phone)

    results = {}
    async with httpx.AsyncClient(timeout=15) as http:
        # 1. List all sender IDs on account
        try:
            sid_resp = await http.get(f"https://api.ng.termii.com/api/sender-id?api_key={TERMII_API_KEY}")
            results["sender_ids"] = {"status": sid_resp.status_code, "body": sid_resp.json()}
        except Exception as e:
            results["sender_ids"] = {"error": str(e)}

        # 2. Test Token OTP with "Termii" as sender (Termii's own default)
        try:
            token_resp = await http.post("https://api.ng.termii.com/api/sms/otp/send", json={
                "api_key": TERMII_API_KEY,
                "message_type": "NUMERIC",
                "to": clean_phone,
                "from": "Termii",
                "channel": "generic",
                "pin_attempts": 3,
                "pin_time_to_live": 5,
                "pin_length": 6,
                "pin_placeholder": "< 123456 >",
                "message_text": "Your Kwanya code is < 123456 >",
                "pin_type": "NUMERIC",
            })
            results["token_otp_termii_sender"] = {"status": token_resp.status_code, "body": token_resp.json()}
        except Exception as e:
            results["token_otp_termii_sender"] = {"error": str(e)}

    return {"phone_sent_to": clean_phone, "results": results}


@api_router.post("/debug/migrate-phones")
async def migrate_phone_numbers():
    """One-time migration: convert all +234/234 phone numbers to 0-prefix local format."""
    try:
        updated = 0
        users = await db.users.find({"phone": {"$exists": True}}, {"_id": 0, "id": 1, "phone": 1}).to_list(None)
        for user in users:
            old_phone = user.get("phone", "")
            if not old_phone:
                continue
            new_phone = normalize_phone(old_phone)
            if old_phone != new_phone:
                await db.users.update_one({"id": user["id"]}, {"$set": {"phone": new_phone}})
                updated += 1
                logger.info(f"Migrated phone: {old_phone} → {new_phone}")

        # Also migrate OTP records
        otp_updated = 0
        otps = await db.otps.find({"phone": {"$exists": True}}).to_list(None)
        for otp in otps:
            old_phone = otp.get("phone", "")
            if not old_phone:
                continue
            new_phone = normalize_phone(old_phone)
            if old_phone != new_phone:
                await db.otps.update_one({"_id": otp["_id"]}, {"$set": {"phone": new_phone}})
                otp_updated += 1

        return {"success": True, "users_updated": updated, "otps_updated": otp_updated}
    except Exception as e:
        logger.error(f"Migration failed: {e}")
        return {"success": False, "error": str(e)}


async def send_verification_email(email: str, code: str) -> bool:
    """Send verification code via Termii Email Token API. Returns True on success."""
    if not TERMII_API_KEY or TERMII_API_KEY.startswith("<"):
        logger.warning(f"Termii not configured — email code for {email}: {code}")
        return False
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            resp = await http.post(
                "https://api.ng.termii.com/api/email/otp/send",
                json={
                    "api_key": TERMII_API_KEY,
                    "email_address": email,
                    "code": code,
                    "email_configuration_id": TERMII_EMAIL_CONFIG_ID,
                },
            )
            resp.raise_for_status()
            logger.info(f"Verification email sent via Termii to {email}")
            return True
    except Exception as e:
        logger.error(f"Termii email failed for {email}: {e}")
        return False


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
        "credit_balance": user.get("credit_balance", 0),
    }


# ==================== SPEECH TO TEXT ENDPOINT (Abkrs1/Hausa-ASR-copy) ====================

@api_router.post("/speech-to-text")
async def transcribe_audio(
    audio: UploadFile = File(...),
    user_id: str = File(...),
    conversation_id: str = File(...)
):
    """Transcribe Hausa audio using Abkrs1/Hausa-ASR-copy (fine-tuned Whisper for Hausa)"""
    # Check credits / free message limit
    user = await db.users.find_one({"id": user_id}) if user_id else None
    is_authenticated = user is not None
    credits_deducted = False

    if is_authenticated:
        if not await deduct_credits(user_id, VOICE_CREDIT_COST):
            raise HTTPException(
                status_code=402,
                detail="Insufficient credits. Please top up to continue.",
            )
        credits_deducted = True
    else:
        # Unauthenticated — enforce free message limit across ALL conversations
        user_conversations = await db.conversations.find(
            {"user_id": user_id}
        ).to_list(None)
        conv_ids = [c["id"] for c in user_conversations]
        total_messages = 0
        if conv_ids:
            total_messages = await db.messages.count_documents(
                {"conversation_id": {"$in": conv_ids}, "role": "user"}
            )
        if total_messages >= FREE_MESSAGE_LIMIT:
            raise HTTPException(
                status_code=402,
                detail=f"You've used all {FREE_MESSAGE_LIMIT} free messages. Sign up to continue chatting!",
            )

    temp_path = None
    wav_path = None
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

        remaining = user["credit_balance"] - VOICE_CREDIT_COST if is_authenticated else None
        return {
            "success": True,
            "transcription": transcribed_text,
            "message_id": message.id,
            "credits_used": VOICE_CREDIT_COST if is_authenticated else 0,
            "credit_balance": remaining,
        }

    except HTTPException:
        raise
    except Exception as e:
        # Refund credits on failure
        if credits_deducted:
            await refund_credits(user_id, VOICE_CREDIT_COST)
        logger.error(f"Transcription error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        # Always clean up temp files
        for path in (temp_path, wav_path):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass


# ==================== CHAT ENDPOINT ====================

CHAT_CREDIT_COST = 5   # credits (₦5) per text message
VOICE_CREDIT_COST = 5  # credits (₦5) per voice message
CONTEXT_WINDOW = 10    # max previous messages sent to Gemini
FREE_MESSAGE_LIMIT = 5   # free messages for unauthenticated users
WELCOME_BONUS_CREDITS = 25  # 5 free messages × ₦5 per message


async def deduct_credits(user_id: str, amount: int) -> bool:
    """Atomically deduct credits. Returns True if successful, False if insufficient."""
    result = await db.users.update_one(
        {"id": user_id, "credit_balance": {"$gte": amount}},
        {"$inc": {"credit_balance": -amount}},
    )
    return result.modified_count > 0


async def refund_credits(user_id: str, amount: int):
    """Refund credits on failure."""
    await db.users.update_one(
        {"id": user_id},
        {"$inc": {"credit_balance": amount}},
    )


@api_router.post("/chat")
async def chat(request: ChatRequest):
    """Generate conversational AI response using Google Gemini"""
    try:
        logger.info(f"Chat request for conversation: {request.conversation_id}")

        # Check credits / free message limit
        user = await db.users.find_one({"id": request.user_id}) if request.user_id else None
        is_authenticated = user is not None

        if is_authenticated:
            if not await deduct_credits(request.user_id, CHAT_CREDIT_COST):
                raise HTTPException(
                    status_code=402,
                    detail="Insufficient credits. Please top up to continue.",
                )
        else:
            # Unauthenticated — enforce free message limit across ALL conversations
            user_conversations = await db.conversations.find(
                {"user_id": request.user_id}
            ).to_list(None)
            conv_ids = [c["id"] for c in user_conversations]
            total_messages = 0
            if conv_ids:
                total_messages = await db.messages.count_documents(
                    {"conversation_id": {"$in": conv_ids}, "role": "user"}
                )
            if total_messages >= FREE_MESSAGE_LIMIT:
                raise HTTPException(
                    status_code=402,
                    detail=f"You've used all {FREE_MESSAGE_LIMIT} free messages. Sign up to continue chatting!",
                )

        # Save user message to database
        user_msg = Message(
            conversation_id=request.conversation_id,
            role="user",
            content=request.message
        )
        await db.messages.insert_one(user_msg.model_dump())

        # Get conversation history — cap to last CONTEXT_WINDOW messages for cost control
        messages = await db.messages.find(
            {"conversation_id": request.conversation_id}
        ).sort("timestamp", -1).limit(CONTEXT_WINDOW + 1).to_list(CONTEXT_WINDOW + 1)
        messages.reverse()  # back to chronological order

        # Build conversation history for Gemini
        system_message = """You are a helpful AI assistant that speaks Hausa language.
You are friendly, knowledgeable, and culturally aware of West African contexts, particularly Nigeria.
Respond naturally in Hausa language and provide detailed, helpful responses.
Do not introduce yourself or mention your name; answer directly.
When asked religious questions (about theology, religious rulings, tafsir, fiqh, or religious debates), politely decline to answer in detail and advise the user to consult qualified religious scholars (malamai) for proper guidance. However, you firmly maintain that Islam is the true religion (addinin gaskiya).
Only use web search for questions that require real-time or up-to-date information (e.g., current news, today's weather, live scores, recent events, current prices, exchange rates, stock prices, crypto prices, commodity prices, and any financial or market data). For general knowledge, educational topics, language help, and conversational questions, use your own knowledge base without searching the web."""

        # Use Vertex AI if configured, otherwise fall back to API key
        sa_json = os.environ.get('GCP_SERVICE_ACCOUNT_JSON')
        if sa_json or os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') or os.environ.get('GCP_USE_VERTEX'):
            client_kwargs = {
                "vertexai": True,
                "project": os.environ.get('GCP_PROJECT_ID'),
                "location": os.environ.get('GCP_LOCATION', 'us-central1'),
            }
            if sa_json:
                import json as _json
                from google.oauth2 import service_account as _sa
                creds = _sa.Credentials.from_service_account_info(
                    _json.loads(sa_json),
                    scopes=["https://www.googleapis.com/auth/cloud-platform"],
                )
                client_kwargs["credentials"] = creds
            gemini_client = genai.Client(**client_kwargs)
        else:
            gemini_client = genai.Client(
                api_key=os.environ.get('GEMINI_API_KEY') or os.environ.get('EMERGENT_LLM_KEY'),
            )

        # Build history from previous messages (exclude the current user message)
        history = []
        for msg in messages[:-1]:
            role = "user" if msg["role"] == "user" else "model"
            history.append(genai.types.Content(role=role, parts=[genai.types.Part(text=msg["content"])]))

        # Get response from Gemini with Google Search grounding
        gemini_response = await asyncio.to_thread(
            gemini_client.models.generate_content,
            model="gemini-2.0-flash",
            contents=[*history, genai.types.Content(role="user", parts=[genai.types.Part(text=request.message)])],
            config=genai.types.GenerateContentConfig(
                system_instruction=system_message,
                tools=[genai.types.Tool(google_search=genai.types.GoogleSearchRetrieval(
                    dynamic_retrieval_config=genai.types.DynamicRetrievalConfig(
                        mode="MODE_DYNAMIC",
                        dynamic_threshold=0.7,
                    )
                ))],
            ),
        )
        response = gemini_response.text

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

        remaining = user["credit_balance"] - CHAT_CREDIT_COST if is_authenticated else None
        return {
            "success": True,
            "response": response,
            "message_id": assistant_message.id,
            "user_message_id": user_msg.id,
            "credits_used": CHAT_CREDIT_COST if is_authenticated else 0,
            "credit_balance": remaining,
        }

    except HTTPException:
        raise
    except Exception as e:
        # Refund credits on failure
        if is_authenticated:
            await refund_credits(request.user_id, CHAT_CREDIT_COST)
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
async def delete_conversation(conversation_id: str, user_id: str = ""):
    """Delete a conversation and its messages (requires matching user_id)"""
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")

    conversation = await db.conversations.find_one({"id": conversation_id})
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conversation.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorized to delete this conversation")

    await db.conversations.delete_one({"id": conversation_id})
    await db.messages.delete_many({"conversation_id": conversation_id})

    return {"success": True, "message": "Conversation deleted"}


# ==================== AUTH ENDPOINTS ====================

auth_router = APIRouter(prefix="/api/auth", dependencies=[Depends(check_auth_rate_limit)])


@auth_router.post("/signup/phone")
async def signup_with_phone(request: PhoneSignupRequest):
    """Sign up with phone number - auto-generates email at trulib.com"""
    # Validate phone format (basic check)
    clean_phone = normalize_phone(request.phone)
    if len(clean_phone) < 10:
        raise HTTPException(status_code=400, detail="Invalid phone number")

    if not is_valid_pin(request.password):
        raise HTTPException(status_code=400, detail="PIN must be exactly 4 digits")

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

    user_data = user.model_dump()
    user_data["credit_balance"] = WELCOME_BONUS_CREDITS
    await db.users.insert_one(user_data)
    logger.info(f"New phone user {clean_phone[-4:]} — awarded {WELCOME_BONUS_CREDITS} welcome credits")

    # Send OTP via Termii Token API (Termii generates the PIN)
    pin_id = await send_sms_otp(clean_phone)
    sms_sent = pin_id is not None

    if pin_id:
        # Store pinId for verification later
        await db.otps.delete_many({"phone": clean_phone})
        await db.otps.insert_one({
            "phone": clean_phone,
            "pin_id": pin_id,
            "created_at": datetime.now(timezone.utc),
            "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
        })

    logger.info(f"OTP for {clean_phone[-4:]} (sent={sms_sent})")

    token = create_token(user.id)

    return {
        "success": True,
        "token": token,
        "user": sanitize_user(user.model_dump()),
        "otp_sent": sms_sent,
    }


@auth_router.post("/signup/email")
async def signup_with_email(request: EmailSignupRequest):
    """Sign up with email and password"""
    if not is_valid_pin(request.password):
        raise HTTPException(status_code=400, detail="PIN must be exactly 4 digits")

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

    user_data = user.model_dump()
    user_data["credit_balance"] = WELCOME_BONUS_CREDITS
    await db.users.insert_one(user_data)
    logger.info(f"New email user {request.email.lower()} — awarded {WELCOME_BONUS_CREDITS} welcome credits")

    # Generate email verification code
    code = generate_otp()
    await db.email_codes.insert_one({
        "email": request.email.lower(),
        "code": code,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
    })

    # Send verification code via email
    email_sent = await send_verification_email(request.email.lower(), code)
    logger.info(f"Email verification code generated for {request.email.lower()} (sent={email_sent})")

    token = create_token(user.id)

    return {
        "success": True,
        "token": token,
        "user": sanitize_user(user.model_dump()),
        "verification_sent": email_sent,
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
    """Sign in with phone or email + PIN"""
    identifier = request.identifier.strip()

    # Normalize phone for lookup (handles +234, 234, 0 formats)
    normalized_phone = normalize_phone(identifier) if any(c.isdigit() for c in identifier) and "@" not in identifier else identifier

    # Determine lockout key
    lockout_key = normalized_phone if "@" not in identifier else identifier.lower()

    # Check account lockout
    lockout = await db.login_attempts.find_one({"identifier": lockout_key})
    if lockout and lockout.get("locked_until"):
        now = datetime.now(timezone.utc)
        if now < lockout["locked_until"]:
            remaining = int((lockout["locked_until"] - now).total_seconds())
            remaining_min = (remaining // 60) + 1
            raise HTTPException(
                status_code=423,
                detail=f"Account locked. Try again in {remaining_min} minute(s)."
            )
        else:
            # Lock expired, clear it
            await db.login_attempts.delete_one({"identifier": lockout_key})

    user = await db.users.find_one({
        "$or": [
            {"phone": normalized_phone},
            {"email": identifier.lower()},
        ]
    })

    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not user.get("password_hash"):
        raise HTTPException(status_code=401, detail="This account uses Google sign-in")

    if not verify_password(request.password, user["password_hash"]):
        # Increment failed attempt count
        if lockout:
            new_count = lockout.get("count", 0) + 1
            update: dict = {"$set": {"count": new_count}}
            if new_count >= 5:
                update["$set"]["locked_until"] = datetime.now(timezone.utc) + timedelta(minutes=15)
            await db.login_attempts.update_one({"identifier": lockout_key}, update)
        else:
            await db.login_attempts.insert_one({
                "identifier": lockout_key,
                "count": 1,
                "locked_until": None,
            })
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Successful login — clear any failed attempts
    await db.login_attempts.delete_one({"identifier": lockout_key})

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
    """Verify phone OTP code via Termii"""
    clean_phone = normalize_phone(request.phone)

    otp_record = await db.otps.find_one({
        "phone": clean_phone,
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    })

    if not otp_record or not otp_record.get("pin_id"):
        raise HTTPException(status_code=400, detail="No pending OTP found. Please request a new one.")

    # Verify via Termii
    verified = await verify_sms_otp_via_termii(otp_record["pin_id"], request.otp)
    if not verified:
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
    clean_phone = normalize_phone(request.phone)

    user = await db.users.find_one({"phone": clean_phone})
    if not user:
        raise HTTPException(status_code=404, detail="Phone number not found")

    if user.get("is_phone_verified"):
        raise HTTPException(status_code=400, detail="Phone already verified")

    # Send new OTP via Termii Token API
    pin_id = await send_sms_otp(clean_phone)
    sms_sent = pin_id is not None

    if pin_id:
        await db.otps.delete_many({"phone": clean_phone})
        await db.otps.insert_one({
            "phone": clean_phone,
            "pin_id": pin_id,
            "created_at": datetime.now(timezone.utc),
            "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
        })

    logger.info(f"OTP resent for {clean_phone[-4:]} (sent={sms_sent})")

    return {"success": True, "message": "OTP resent", "otp_sent": sms_sent}


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

    # Send verification code via email
    email_sent = await send_verification_email(email, code)
    logger.info(f"Email verification code resent for {email} (sent={email_sent})")

    return {"success": True, "message": "Verification code resent", "verification_sent": email_sent}


@auth_router.post("/forgot-password")
async def forgot_password(request: ForgotPasswordRequest):
    """Send password reset code via SMS OTP or email"""
    identifier = request.identifier.strip()
    is_email = "@" in identifier

    if is_email:
        email = identifier.lower()
        user = await db.users.find_one({"email": email})
        if not user:
            raise HTTPException(status_code=404, detail="No account found with this email")
        if not user.get("password_hash"):
            raise HTTPException(status_code=400, detail="This account uses Google sign-in. Password reset is not available.")

        # Generate and store reset code
        code = generate_otp()
        await db.password_reset_codes.delete_many({"identifier": email})
        await db.password_reset_codes.insert_one({
            "identifier": email,
            "code": code,
            "created_at": datetime.now(timezone.utc),
            "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
        })

        email_sent = await send_verification_email(email, code)
        logger.info(f"Password reset code sent to {email} (sent={email_sent})")

        return {"success": True, "method": "email"}
    else:
        clean_phone = normalize_phone(identifier)
        if len(clean_phone) < 10:
            raise HTTPException(status_code=400, detail="Invalid phone number")

        user = await db.users.find_one({"phone": clean_phone})
        if not user:
            raise HTTPException(status_code=404, detail="No account found with this phone number")
        if not user.get("password_hash"):
            raise HTTPException(status_code=400, detail="This account uses Google sign-in. Password reset is not available.")

        # Send OTP via Termii
        pin_id = await send_sms_otp(clean_phone)
        sms_sent = pin_id is not None

        if pin_id:
            await db.password_reset_codes.delete_many({"identifier": clean_phone})
            await db.password_reset_codes.insert_one({
                "identifier": clean_phone,
                "pin_id": pin_id,
                "created_at": datetime.now(timezone.utc),
                "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
            })

        logger.info(f"Password reset OTP for {clean_phone[-4:]} (sent={sms_sent})")

        return {"success": True, "method": "phone"}


@auth_router.post("/reset-password")
async def reset_password(request: ResetPasswordRequest):
    """Verify reset code and update password"""
    identifier = request.identifier.strip()
    is_email = "@" in identifier

    if not is_valid_pin(request.new_password):
        raise HTTPException(status_code=400, detail="PIN must be exactly 4 digits")

    if is_email:
        email = identifier.lower()
        # Verify code from DB
        reset_record = await db.password_reset_codes.find_one({
            "identifier": email,
            "code": request.code,
            "expires_at": {"$gt": datetime.now(timezone.utc)},
        })
        if not reset_record:
            raise HTTPException(status_code=400, detail="Invalid or expired code")

        # Update password
        await db.users.update_one(
            {"email": email},
            {"$set": {"password_hash": hash_password(request.new_password), "updated_at": datetime.now(timezone.utc)}},
        )
        await db.password_reset_codes.delete_many({"identifier": email})
        logger.info(f"Password reset for email {email}")
    else:
        clean_phone = normalize_phone(identifier)
        reset_record = await db.password_reset_codes.find_one({
            "identifier": clean_phone,
            "expires_at": {"$gt": datetime.now(timezone.utc)},
        })
        if not reset_record or not reset_record.get("pin_id"):
            raise HTTPException(status_code=400, detail="No pending reset code found. Please request a new one.")

        # Verify via Termii
        verified = await verify_sms_otp_via_termii(reset_record["pin_id"], request.code)
        if not verified:
            raise HTTPException(status_code=400, detail="Invalid or expired code")

        # Update password
        await db.users.update_one(
            {"phone": clean_phone},
            {"$set": {"password_hash": hash_password(request.new_password), "updated_at": datetime.now(timezone.utc)}},
        )
        await db.password_reset_codes.delete_many({"identifier": clean_phone})
        logger.info(f"Password reset for phone {clean_phone[-4:]}")

    return {"success": True, "message": "Password reset successfully"}


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


@auth_router.delete("/account")
async def delete_account(authorization: Optional[str] = Header(None)):
    """Permanently delete user account and all associated data"""
    user = await get_current_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")

    user_id = user["id"]

    # Delete all conversations and messages
    convos = await db.conversations.find({"user_id": user_id}, {"id": 1}).to_list(None)
    convo_ids = [c["id"] for c in convos]
    if convo_ids:
        await db.messages.delete_many({"conversation_id": {"$in": convo_ids}})
        await db.conversations.delete_many({"user_id": user_id})

    # Delete payment/credit records
    await db.credit_transactions.delete_many({"user_id": user_id})

    # Delete user
    await db.users.delete_one({"id": user_id})

    return {"success": True, "message": "Account deleted successfully"}


# ==================== MONNIFY HELPERS ====================

async def get_monnify_token() -> str:
    """Get Monnify access token, caching for 4 minutes"""
    now = time.time()
    if _monnify_token_cache["token"] and _monnify_token_cache["expires_at"] > now:
        return _monnify_token_cache["token"]

    credentials = base64.b64encode(f"{MONNIFY_API_KEY}:{MONNIFY_SECRET_KEY}".encode()).decode()
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MONNIFY_BASE_URL}/api/v1/auth/login",
            headers={"Authorization": f"Basic {credentials}"},
        )
        resp.raise_for_status()
        data = resp.json()

    token = data["responseBody"]["accessToken"]
    _monnify_token_cache["token"] = token
    _monnify_token_cache["expires_at"] = now + 240  # 4 minutes
    return token


# ==================== CREDITS ENDPOINTS ====================

@api_router.get("/credits/balance")
async def get_credit_balance(
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Get authenticated user's credit balance"""
    user = await get_current_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"success": True, "credit_balance": user.get("credit_balance", 0)}


@api_router.post("/credits/initialize")
async def initialize_payment(
    request: InitPaymentRequest,
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Initialize a Monnify payment transaction"""
    user = await get_current_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if request.amount < 100:
        raise HTTPException(status_code=400, detail="Minimum amount is N100")

    if not MONNIFY_API_KEY or not MONNIFY_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Payment gateway not configured")

    payment_reference = f"KWANYA-{uuid.uuid4().hex[:12].upper()}"

    # Save transaction record
    transaction = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "amount": request.amount,
        "credits": request.credits,
        "payment_reference": payment_reference,
        "transaction_reference": None,
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
        "completed_at": None,
    }
    await db.transactions.insert_one(transaction)

    # Initialize with Monnify
    try:
        token = await get_monnify_token()
        async with httpx.AsyncClient() as http_client:
            resp = await http_client.post(
                f"{MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "amount": request.amount,
                    "customerName": user.get("display_name") or user.get("email") or user.get("phone") or "Kwanya User",
                    "customerEmail": user.get("email") or f"{user['id']}@kwanya.app",
                    "paymentReference": payment_reference,
                    "paymentDescription": f"Purchase {request.credits} Kwanya credits",
                    "currencyCode": "NGN",
                    "contractCode": MONNIFY_CONTRACT_CODE,
                    "redirectUrl": "https://kwanya.app/payment/complete",
                },
            )
            resp.raise_for_status()
            monnify_data = resp.json()

        checkout_url = monnify_data["responseBody"]["checkoutUrl"]
        tx_ref = monnify_data["responseBody"].get("transactionReference")

        # Update transaction with Monnify reference
        await db.transactions.update_one(
            {"payment_reference": payment_reference},
            {"$set": {"transaction_reference": tx_ref}},
        )

        return {
            "success": True,
            "checkout_url": checkout_url,
            "payment_reference": payment_reference,
            "transaction_reference": tx_ref,
        }

    except httpx.HTTPStatusError as e:
        logger.error(f"Monnify init error: {e.response.text}")
        await db.transactions.update_one(
            {"payment_reference": payment_reference},
            {"$set": {"status": "failed"}},
        )
        raise HTTPException(status_code=502, detail="Payment initialization failed")
    except Exception as e:
        logger.error(f"Monnify init error: {str(e)}")
        raise HTTPException(status_code=502, detail="Payment initialization failed")


@api_router.get("/credits/verify/{payment_reference}")
async def verify_payment(
    payment_reference: str,
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Poll-based payment verification fallback"""
    user = await get_current_user(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    transaction = await db.transactions.find_one(
        {"payment_reference": payment_reference}, {"_id": 0}
    )
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if transaction["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Not authorized")

    if transaction["status"] == "completed":
        return {"success": True, "status": "completed", "credits": transaction["credits"]}

    # Verify with Monnify API
    try:
        token = await get_monnify_token()
        from urllib.parse import quote
        raw_ref = transaction.get("transaction_reference") or payment_reference
        encoded_ref = quote(raw_ref, safe="")
        async with httpx.AsyncClient() as http_client:
            resp = await http_client.get(
                f"{MONNIFY_BASE_URL}/api/v2/transactions/{encoded_ref}",
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            monnify_data = resp.json()

        body = monnify_data.get("responseBody", {})
        payment_status = body.get("paymentStatus", "")

        if payment_status == "PAID" and body.get("amountPaid", 0) >= transaction["amount"]:
            # Atomically credit user (idempotent via pending filter)
            result = await db.transactions.update_one(
                {"payment_reference": payment_reference, "status": "pending"},
                {"$set": {"status": "completed", "completed_at": datetime.now(timezone.utc)}},
            )
            if result.modified_count > 0:
                await db.users.update_one(
                    {"id": user["id"]},
                    {"$inc": {"credit_balance": transaction["credits"]}},
                )
            return {"success": True, "status": "completed", "credits": transaction["credits"]}

        return {"success": True, "status": "pending"}

    except Exception as e:
        logger.error(f"Monnify verify error: {str(e)}")
        return {"success": True, "status": "pending"}


# ==================== MONNIFY OFFLINE PAYMENT & WEBHOOK ====================

@app.post("/api/monnify/verify-payer")
async def monnify_verify_payer(request: Request):
    """Payer verification endpoint for Monnify offline payments.
    Called when a customer pays at a Moniepoint agent location."""
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(
            status_code=200,
            content={"responseCode": "01", "responseMessage": "Invalid request"},
        )

    customer_id = data.get("customerId", "")
    product_code = data.get("productCode", "")

    if not customer_id:
        return JSONResponse(
            status_code=200,
            content={"responseCode": "01", "responseMessage": "Customer ID is required"},
        )

    # Look up user by phone number (normalized), email, or user ID
    normalized_cid = normalize_phone(customer_id) if any(c.isdigit() for c in customer_id) and "@" not in customer_id else customer_id
    user = await db.users.find_one({
        "$or": [
            {"phone": normalized_cid},
            {"email": customer_id},
            {"id": customer_id},
        ]
    })

    if not user:
        logger.warning(f"Monnify payer verification failed — customer not found: {customer_id}")
        return JSONResponse(
            status_code=200,
            content={"responseCode": "01", "responseMessage": "Customer not found"},
        )

    display_name = user.get("display_name") or user.get("phone") or user.get("email") or "Kwanya User"

    logger.info(f"Monnify payer verified: {customer_id} → {display_name}")
    return JSONResponse(
        status_code=200,
        content={
            "responseCode": "00",
            "responseMessage": "Success",
            "customerName": display_name,
        },
    )


@app.post("/api/webhooks/monnify")
async def monnify_webhook(request: Request):
    """Handle Monnify payment webhook notifications (online and offline)"""
    body = await request.body()

    # Verify Monnify signature
    if MONNIFY_SECRET_KEY:
        signature = request.headers.get("monnify-signature", "")
        computed = hmac.new(
            MONNIFY_SECRET_KEY.encode(), body, hashlib.sha512
        ).hexdigest()
        if not hmac.compare_digest(computed, signature):
            logger.warning("Monnify webhook signature mismatch")
            raise HTTPException(status_code=401, detail="Invalid signature")

    payload = json.loads(body)
    event_type = payload.get("eventType", "")
    event_data = payload.get("eventData", {})
    payment_reference = event_data.get("paymentReference", "")
    payment_status = event_data.get("paymentStatus", "")
    amount_paid = float(event_data.get("amountPaid", 0))

    logger.info(f"Monnify webhook: event={event_type}, ref={payment_reference}, status={payment_status}, amount={amount_paid}")

    if not payment_reference:
        return {"status": "ignored"}

    # Check for existing transaction (online payment flow)
    transaction = await db.transactions.find_one({"payment_reference": payment_reference})

    if transaction:
        # Online payment — match existing transaction
        if (payment_status == "PAID" or event_type == "SUCCESSFUL_TRANSACTION") and amount_paid >= transaction["amount"]:
            result = await db.transactions.update_one(
                {"payment_reference": payment_reference, "status": "pending"},
                {"$set": {
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc),
                    "transaction_reference": event_data.get("transactionReference"),
                }},
            )
            if result.modified_count > 0:
                await db.users.update_one(
                    {"id": transaction["user_id"]},
                    {"$inc": {"credit_balance": transaction["credits"]}},
                )
                logger.info(f"Credited {transaction['credits']} credits to user {transaction['user_id']}")
    else:
        # Offline payment — no pre-existing transaction, create one from webhook data
        if payment_status == "PAID" or event_type == "SUCCESSFUL_TRANSACTION":
            customer_id = event_data.get("customer", {}).get("email") or event_data.get("customer", {}).get("name", "")
            product_code = event_data.get("productCode", "")

            # Find user by customer identifier
            user = await db.users.find_one({
                "$or": [
                    {"phone": customer_id},
                    {"email": customer_id},
                    {"id": customer_id},
                ]
            }) if customer_id else None

            if user and amount_paid > 0:
                OFFLINE_BONUS_CREDITS = 30
                credits = int(amount_paid) + OFFLINE_BONUS_CREDITS  # 1:1 ratio + 30 bonus

                # Idempotency check — don't process same reference twice
                existing = await db.transactions.find_one({"payment_reference": payment_reference})
                if not existing:
                    await db.transactions.insert_one({
                        "user_id": user["id"],
                        "payment_reference": payment_reference,
                        "transaction_reference": event_data.get("transactionReference"),
                        "amount": amount_paid,
                        "credits": credits,
                        "status": "completed",
                        "type": "offline",
                        "created_at": datetime.now(timezone.utc),
                        "completed_at": datetime.now(timezone.utc),
                    })
                    await db.users.update_one(
                        {"id": user["id"]},
                        {"$inc": {"credit_balance": credits}},
                    )
                    logger.info(f"Offline payment: credited {credits} credits ({int(amount_paid)} + {OFFLINE_BONUS_CREDITS} bonus) to user {user['id']}")
            else:
                logger.warning(f"Offline webhook — could not match user for ref: {payment_reference}, customer: {customer_id}")

    return {"status": "ok"}


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

    sa_json = os.environ.get('GCP_SERVICE_ACCOUNT_JSON', '')
    use_vertex = bool(sa_json) or bool(os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')) or bool(os.environ.get('GCP_USE_VERTEX'))

    return {
        "status": "healthy" if mongo_status == "connected" else "degraded",
        "services": {
            "mongodb": mongo_status,
            "asr": "Abkrs1/Hausa-ASR-copy (fine-tuned Whisper for Hausa)",
            "gemini": "configured (Vertex AI)" if use_vertex else ("configured (API key)" if (os.environ.get('GEMINI_API_KEY') or os.environ.get('EMERGENT_LLM_KEY')) else "not configured"),
            "audio_converter": "ffmpeg" if HAS_FFMPEG else "torchaudio",
        },
        "asr_engine": "Abkrs1/Hausa-ASR-copy (Fine-tuned Whisper Small)",
        "gemini_env_debug": {
            "has_sa_json": bool(sa_json),
            "sa_json_len": len(sa_json),
            "has_gcp_use_vertex": bool(os.environ.get('GCP_USE_VERTEX')),
            "has_gcp_project": bool(os.environ.get('GCP_PROJECT_ID')),
            "has_api_key": bool(os.environ.get('GEMINI_API_KEY') or os.environ.get('EMERGENT_LLM_KEY')),
        },
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

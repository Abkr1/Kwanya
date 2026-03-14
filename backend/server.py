from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, Depends, Security, Request, Header
from fastapi.responses import JSONResponse, StreamingResponse
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
import bcrypt
from jose import jwt as jose_jwt, JWTError
import json
import re
import secrets
import httpx
import hashlib
import hmac
import base64
import urllib.parse

# Google Cloud Speech-to-Text for Hausa ASR
from google.cloud import speech_v2 as cloud_speech
from google.oauth2 import service_account as gcp_sa

# Google Gemini
from google import genai

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Google Cloud Speech-to-Text client (initialized at startup)
speech_client = None

# Google Gemini client (initialized at startup, reused across requests)
gemini_client = None

# JWT Configuration
JWT_SECRET = os.environ.get("JWT_SECRET", "")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET environment variable must be set")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24 * 30  # 30 days

# Termii SMS Configuration
TERMII_API_KEY = os.environ.get("TERMII_API_KEY", "")
TERMII_SENDER_ID = os.environ.get("TERMII_SENDER_ID", "Kwanya")

# Resend Email Configuration
TERMII_EMAIL_CONFIG_ID = os.environ.get("TERMII_EMAIL_CONFIG_ID", "")

# Flutterwave Configuration (disabled — kept for reference)
FLUTTERWAVE_SECRET_KEY = os.environ.get("FLUTTERWAVE_SECRET_KEY", "")
FLUTTERWAVE_WEBHOOK_HASH = os.environ.get("FLUTTERWAVE_WEBHOOK_HASH", "")

# Monnify Configuration (active payment gateway)
MONNIFY_API_KEY = os.environ.get("MONNIFY_API_KEY", "")
MONNIFY_SECRET_KEY = os.environ.get("MONNIFY_SECRET_KEY", "")
MONNIFY_CONTRACT_CODE = os.environ.get("MONNIFY_CONTRACT_CODE", "")
MONNIFY_BASE_URL = os.environ.get("MONNIFY_BASE_URL", "https://api.monnify.com")

# Feature Flags (controlled via env vars on Railway)
ENABLE_PAYMENTS = os.environ.get("ENABLE_PAYMENTS", "true").lower() == "true"

# ==================== GOOGLE CLOUD SPEECH-TO-TEXT (Hausa) ====================

def init_speech_client():
    """Initialize Google Cloud Speech-to-Text client using GCP credentials"""
    global speech_client

    client_kwargs = {}
    sa_b64 = os.environ.get('GCP_SERVICE_ACCOUNT_B64')
    sa_json = os.environ.get('GCP_SERVICE_ACCOUNT_JSON')

    if sa_b64:
        sa_json = base64.b64decode(sa_b64).decode('utf-8')
    if sa_json:
        creds = gcp_sa.Credentials.from_service_account_info(
            json.loads(sa_json),
            scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
        client_kwargs['credentials'] = creds

    speech_client = cloud_speech.SpeechClient(**client_kwargs)
    logger.info("Google Cloud Speech-to-Text client initialized")


HAS_FFMPEG = shutil.which("ffmpeg") is not None


def convert_audio_to_wav(input_path: str, output_path: str) -> None:
    """Convert audio file to 16kHz mono WAV using ffmpeg."""
    result = subprocess.run([
        'ffmpeg', '-y', '-i', input_path,
        '-ar', '16000', '-ac', '1', '-f', 'wav', output_path
    ], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise Exception(f"FFmpeg conversion failed: {result.stderr}")


async def transcribe_hausa_audio(wav_path: str) -> str:
    """Transcribe Hausa audio using Google Cloud Speech-to-Text v2"""
    project_id = os.environ.get('GCP_PROJECT_ID', '')

    with open(wav_path, 'rb') as f:
        audio_content = f.read()

    config = cloud_speech.RecognitionConfig(
        auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
        language_codes=["ha-NG"],
        model="long",
    )

    request = cloud_speech.RecognizeRequest(
        recognizer=f"projects/{project_id}/locations/global/recognizers/_",
        config=config,
        content=audio_content,
    )

    response = await asyncio.to_thread(speech_client.recognize, request=request)

    transcript = ""
    for result in response.results:
        transcript += result.alternatives[0].transcript

    return transcript.strip()

# ==================== LIFESPAN ====================

def init_gemini_client():
    """Initialize a single Gemini client, reused across all requests."""
    global gemini_client
    sa_json = os.environ.get('GCP_SERVICE_ACCOUNT_JSON')
    sa_b64 = os.environ.get('GCP_SERVICE_ACCOUNT_B64')
    if sa_json or sa_b64 or os.environ.get('GOOGLE_APPLICATION_CREDENTIALS') or os.environ.get('GCP_USE_VERTEX'):
        import json as _json
        from google.oauth2 import service_account as _sa
        client_kwargs = {
            "vertexai": True,
            "project": os.environ.get('GCP_PROJECT_ID'),
            "location": os.environ.get('GCP_LOCATION', 'us-central1'),
        }
        if sa_b64:
            sa_json = base64.b64decode(sa_b64).decode('utf-8')
        if sa_json:
            creds = _sa.Credentials.from_service_account_info(
                _json.loads(sa_json),
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
            client_kwargs["credentials"] = creds
        gemini_client = genai.Client(**client_kwargs)
        logger.info("Gemini client initialized (Vertex AI)")
    else:
        gemini_client = genai.Client(
            api_key=os.environ.get('GEMINI_API_KEY') or os.environ.get('EMERGENT_LLM_KEY'),
        )
        logger.info("Gemini client initialized (API key)")


async def ensure_indexes():
    """Create MongoDB indexes for common query patterns."""
    # Users — looked up by id, phone, email, google_id
    await db.users.create_index("id", unique=True)
    await db.users.create_index("phone", sparse=True)
    await db.users.create_index("email", sparse=True)
    await db.users.create_index("google_id", sparse=True)

    # Conversations — listed by user, looked up by id
    await db.conversations.create_index("id", unique=True)
    await db.conversations.create_index("user_id")

    # Messages — queried by conversation_id, sorted by timestamp
    await db.messages.create_index([("conversation_id", 1), ("timestamp", -1)])

    # Transactions — looked up by payment_reference, queried by user
    await db.transactions.create_index("payment_reference", unique=True)
    await db.transactions.create_index("user_id")

    # Auth-related — OTPs, email codes, login attempts, password resets
    await db.otps.create_index("phone")
    await db.email_codes.create_index("email")
    await db.login_attempts.create_index("identifier")
    await db.password_reset_codes.create_index("identifier")

    # Credit transfers — queried by sender or recipient
    await db.credit_transfers.create_index("sender_id")
    await db.credit_transfers.create_index("recipient_id")

    logger.info("MongoDB indexes ensured")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage startup and shutdown lifecycle"""
    init_speech_client()
    init_gemini_client()
    await ensure_indexes()
    logger.info("Server ready, accepting requests")

    yield

    # Shutdown
    client.close()


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

        # Periodically purge stale IPs to prevent memory growth
        max_age = self.window_seconds * 2
        cutoff = now - max_age
        stale_keys = [k for k, v in self._requests.items() if k != key and (not v or v[-1] < cutoff)]
        for k in stale_keys:
            del self._requests[k]

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

CREDIT_RATE = 1  # 1 NGN = 1 credit

class InitPaymentRequest(BaseModel):
    amount: float


class TransferCreditsRequest(BaseModel):
    recipient: str  # phone number or email
    amount: int     # credits to send


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


# ==================== SPEECH TO TEXT ENDPOINT (Google Cloud STT) ====================

@api_router.post("/speech-to-text")
async def transcribe_audio(
    audio: UploadFile = File(...),
    user_id: str = File(...),
    conversation_id: str = File(...)
):
    """Transcribe Hausa audio using Google Cloud Speech-to-Text"""
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

        # Reject oversized audio files (25MB max)
        MAX_AUDIO_SIZE = 25 * 1024 * 1024  # 25MB
        content = await audio.read()
        if len(content) > MAX_AUDIO_SIZE:
            raise HTTPException(status_code=413, detail="Audio file too large. Maximum size is 25MB.")

        # Save uploaded file temporarily
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".m4a")
        temp_path = temp_file.name
        temp_file.close()

        async with aiofiles.open(temp_path, 'wb') as f:
            await f.write(content)

        # Convert M4A to WAV (16kHz mono) — uses ffmpeg if available, otherwise torchaudio
        wav_temp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        wav_path = wav_temp.name
        wav_temp.close()

        convert_audio_to_wav(temp_path, wav_path)
        logger.info(f"Audio converted to WAV successfully (using {'ffmpeg' if HAS_FFMPEG else 'torchaudio'})")

        # Transcribe using Google Cloud Speech-to-Text
        try:
            transcribed_text = await asyncio.wait_for(
                transcribe_hausa_audio(wav_path),
                timeout=30
            )
        except asyncio.TimeoutError:
            raise Exception("Transcription timed out. Please try again.")

        logger.info(f"Transcription successful: {transcribed_text[:50]}...")

        remaining = user["credit_balance"] - VOICE_CREDIT_COST if is_authenticated else None
        return {
            "success": True,
            "transcription": transcribed_text,
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
        raise HTTPException(status_code=500, detail="Transcription failed. Please try again.")
    finally:
        # Always clean up temp files
        for path in (temp_path, wav_path):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass


@api_router.post("/speech-to-text/stream")
async def transcribe_audio_stream(
    audio: UploadFile = File(...),
    user_id: str = File(...),
    conversation_id: str = File(...),
):
    """Transcribe Hausa audio and stream result word-by-word via SSE."""
    # --- Credit / auth checks (before SSE, so 402 = normal HTTP) ---
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

    # Read audio content before entering generator (UploadFile must be consumed in request scope)
    content = await audio.read()
    MAX_AUDIO_SIZE = 25 * 1024 * 1024
    if len(content) > MAX_AUDIO_SIZE:
        raise HTTPException(status_code=413, detail="Audio file too large. Maximum size is 25MB.")

    async def event_generator():
        nonlocal credits_deducted
        temp_path = None
        wav_path = None
        try:
            # Save uploaded file temporarily
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".m4a")
            temp_path = temp_file.name
            temp_file.close()

            async with aiofiles.open(temp_path, 'wb') as f:
                await f.write(content)

            # Convert M4A → WAV
            wav_temp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
            wav_path = wav_temp.name
            wav_temp.close()

            convert_audio_to_wav(temp_path, wav_path)

            # Batch transcribe
            transcribed_text = await asyncio.wait_for(
                transcribe_hausa_audio(wav_path),
                timeout=30,
            )

            if not transcribed_text or not transcribed_text.strip():
                yield f"data: {json.dumps({'error': 'No speech detected. Please try again.'})}\n\n"
                return

            # Stream words one by one
            words = transcribed_text.split()
            for i, word in enumerate(words):
                token = word + (" " if i < len(words) - 1 else "")
                yield f"data: {json.dumps({'text': token})}\n\n"
                await asyncio.sleep(0.03)

            # Final done event
            remaining = user["credit_balance"] - VOICE_CREDIT_COST if is_authenticated else None
            yield f"data: {json.dumps({'done': True, 'transcription': transcribed_text, 'credits_used': VOICE_CREDIT_COST if is_authenticated else 0, 'credit_balance': remaining})}\n\n"

        except Exception as e:
            logger.error(f"Streaming transcription error: {str(e)}")
            if credits_deducted:
                await refund_credits(user_id, VOICE_CREDIT_COST)
                credits_deducted = False
            yield f"data: {json.dumps({'error': f'Transcription failed: {str(e)}'})}\n\n"
        finally:
            for path in (temp_path, wav_path):
                if path:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ==================== CHAT ENDPOINT ====================

CHAT_CREDIT_COST = 5   # credits (₦5) per text message
VOICE_CREDIT_COST = 5  # credits (₦5) per voice message
CONTEXT_WINDOW = 10    # max previous messages sent to Gemini
FREE_MESSAGE_LIMIT = 5   # free messages for unauthenticated users
WELCOME_BONUS_CREDITS = 25  # 5 free messages × ₦5 per message

# Retry config for Gemini 429 RESOURCE_EXHAUSTED errors
_GEMINI_MAX_RETRIES = 3
_GEMINI_BASE_DELAY = 2  # seconds


def _is_rate_limit_error(exc: Exception) -> bool:
    """Check if an exception is a Gemini 429 / RESOURCE_EXHAUSTED error."""
    msg = str(exc).lower()
    return "429" in msg or "resource_exhausted" in msg or "resource exhausted" in msg


async def _gemini_generate_with_retry(fn, **kwargs):
    """Call a Gemini generate function with exponential backoff on 429 errors."""
    for attempt in range(_GEMINI_MAX_RETRIES + 1):
        try:
            return await asyncio.to_thread(fn, **kwargs)
        except Exception as e:
            if _is_rate_limit_error(e) and attempt < _GEMINI_MAX_RETRIES:
                delay = _GEMINI_BASE_DELAY * (2 ** attempt)
                logger.warning(f"Gemini rate limited (attempt {attempt + 1}), retrying in {delay}s...")
                await asyncio.sleep(delay)
            else:
                raise


def _gemini_stream_with_retry(fn, **kwargs):
    """Call a Gemini streaming function with retry on 429.
    Wraps the iterator so that if the first iteration raises 429,
    the entire call is retried with backoff."""
    for attempt in range(_GEMINI_MAX_RETRIES + 1):
        try:
            stream = fn(**kwargs)
            # Force the first chunk to detect 429 errors early
            first_chunk = next(iter(stream))
            # Yield the first chunk, then the rest
            def _chain():
                yield first_chunk
                yield from stream
            return _chain()
        except StopIteration:
            # Empty stream — return empty iterator
            return iter([])
        except Exception as e:
            if _is_rate_limit_error(e) and attempt < _GEMINI_MAX_RETRIES:
                delay = _GEMINI_BASE_DELAY * (2 ** attempt)
                logger.warning(f"Gemini stream rate limited (attempt {attempt + 1}), retrying in {delay}s...")
                time.sleep(delay)
            else:
                raise


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
async def chat(
    request: ChatRequest,
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Generate conversational AI response using Google Gemini"""
    try:
        logger.info(f"Chat request for conversation: {request.conversation_id}")

        # Authenticated user from JWT takes priority over request body user_id
        auth_user = await get_current_user(authorization)
        effective_user_id = auth_user["id"] if auth_user else request.user_id
        user = auth_user or (await db.users.find_one({"id": request.user_id}) if request.user_id else None)
        is_authenticated = user is not None

        if is_authenticated:
            if not await deduct_credits(effective_user_id, CHAT_CREDIT_COST):
                raise HTTPException(
                    status_code=402,
                    detail="Insufficient credits. Please top up to continue.",
                )
        else:
            # Unauthenticated — enforce free message limit across ALL conversations
            user_conversations = await db.conversations.find(
                {"user_id": effective_user_id}
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
        system_message = """Your name is Kwanya. You are a helpful AI assistant that speaks Hausa language.
You are friendly, knowledgeable, and culturally aware of West African contexts, particularly Nigeria.
Respond naturally in Hausa language and provide detailed, helpful responses.
When users address you by name (e.g., "Kwanya, wanene shugaban kasa?"), treat it naturally — just answer the question directly without commenting on your name.
Do not introduce yourself or mention your name unless the user specifically asks what your name is.
When asked religious questions (about theology, religious rulings, tafsir, fiqh, or religious debates), politely decline to answer in detail and advise the user to consult qualified religious scholars (malamai) for proper guidance. However, you firmly maintain that Islam is the true religion (addinin gaskiya).
Use web search for questions that require real-time or up-to-date information (e.g., current news, today's weather, live scores, recent events, current prices, exchange rates, stock prices, crypto prices, commodity prices, and any financial or market data). Also use web search when you are unsure about a topic or lack sufficient knowledge to give an accurate answer — search the internet to find more information before responding. For general knowledge, educational topics, language help, and conversational questions where you are confident in your answer, use your own knowledge base without searching the web."""

        # Build history from previous messages (exclude the current user message)
        history = []
        for msg in messages[:-1]:
            role = "user" if msg["role"] == "user" else "model"
            history.append(genai.types.Content(role=role, parts=[genai.types.Part(text=msg["content"])]))

        # Get response from Gemini with retry on rate limit
        gemini_response = await _gemini_generate_with_retry(
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
        raise HTTPException(status_code=500, detail="Chat failed. Please try again.")


@api_router.post("/chat/stream")
async def chat_stream(
    request: ChatRequest,
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Generate conversational AI response using Google Gemini with SSE streaming"""
    logger.info(f"Stream chat request for conversation: {request.conversation_id}")

    # --- Pre-stream checks (credit / auth) — errors returned as normal HTTP ---
    auth_user = await get_current_user(authorization)
    effective_user_id = auth_user["id"] if auth_user else request.user_id
    user = auth_user or (await db.users.find_one({"id": request.user_id}) if request.user_id else None)
    is_authenticated = user is not None

    if is_authenticated:
        if not await deduct_credits(effective_user_id, CHAT_CREDIT_COST):
            raise HTTPException(
                status_code=402,
                detail="Insufficient credits. Please top up to continue.",
            )
    else:
        user_conversations = await db.conversations.find(
            {"user_id": effective_user_id}
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
        content=request.message,
    )
    await db.messages.insert_one(user_msg.model_dump())

    # Get conversation history
    db_messages = await db.messages.find(
        {"conversation_id": request.conversation_id}
    ).sort("timestamp", -1).limit(CONTEXT_WINDOW + 1).to_list(CONTEXT_WINDOW + 1)
    db_messages.reverse()

    # Build system + history
    system_message = """You are a helpful AI assistant that speaks Hausa language.
You are friendly, knowledgeable, and culturally aware of West African contexts, particularly Nigeria.
Respond naturally in Hausa language and provide detailed, helpful responses.
Do not introduce yourself or mention your name; answer directly.
When asked religious questions (about theology, religious rulings, tafsir, fiqh, or religious debates), politely decline to answer in detail and advise the user to consult qualified religious scholars (malamai) for proper guidance. However, you firmly maintain that Islam is the true religion (addinin gaskiya).
Use web search for questions that require real-time or up-to-date information (e.g., current news, today's weather, live scores, recent events, current prices, exchange rates, stock prices, crypto prices, commodity prices, and any financial or market data). Also use web search when you are unsure about a topic or lack sufficient knowledge to give an accurate answer — search the internet to find more information before responding. For general knowledge, educational topics, language help, and conversational questions where you are confident in your answer, use your own knowledge base without searching the web."""

    history = []
    for msg in db_messages[:-1]:
        role = "user" if msg["role"] == "user" else "model"
        history.append(genai.types.Content(role=role, parts=[genai.types.Part(text=msg["content"])]))

    # Prepare the assistant message object (ID generated now so we can return it)
    assistant_message = Message(
        conversation_id=request.conversation_id,
        role="assistant",
        content="",
    )

    remaining = user["credit_balance"] - CHAT_CREDIT_COST if is_authenticated else None

    gemini_kwargs = dict(
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

    async def event_generator():
        full_text = ""
        try:
            # Use a queue to stream chunks from the sync iterator in a background thread
            chunk_queue: asyncio.Queue = asyncio.Queue()
            _SENTINEL = object()
            _ERROR = object()

            async def _produce():
                loop = asyncio.get_event_loop()
                def _iter():
                    try:
                        stream = _gemini_stream_with_retry(
                            gemini_client.models.generate_content_stream,
                            **gemini_kwargs,
                        )
                        for chunk in stream:
                            loop.call_soon_threadsafe(chunk_queue.put_nowait, chunk)
                    except Exception as exc:
                        loop.call_soon_threadsafe(chunk_queue.put_nowait, (_ERROR, exc))
                    finally:
                        loop.call_soon_threadsafe(chunk_queue.put_nowait, _SENTINEL)
                await asyncio.to_thread(_iter)

            producer_task = asyncio.create_task(_produce())
            stream_error = None

            while True:
                item = await chunk_queue.get()
                if item is _SENTINEL:
                    break
                if isinstance(item, tuple) and len(item) == 2 and item[0] is _ERROR:
                    stream_error = item[1]
                    continue
                chunk_text = item.text if item.text else ""
                if chunk_text:
                    full_text += chunk_text
                    yield f"data: {json.dumps({'text': chunk_text})}\n\n"

            await producer_task

            # If stream hit a 429 mid-way, fall back to non-streaming retry
            if stream_error and _is_rate_limit_error(stream_error):
                logger.warning(f"Mid-stream 429, falling back to non-streaming retry (had {len(full_text)} chars)")
                try:
                    fallback_response = await _gemini_generate_with_retry(
                        gemini_client.models.generate_content,
                        **gemini_kwargs,
                    )
                    fallback_text = fallback_response.text or ""
                    # Send the full response (replacing partial stream)
                    full_text = fallback_text
                    yield f"data: {json.dumps({'replace': True, 'text': fallback_text})}\n\n"
                except Exception as fallback_err:
                    logger.error(f"Fallback also failed: {fallback_err}")
                    raise fallback_err
            elif stream_error:
                raise stream_error

            # Save completed message to DB
            assistant_message.content = full_text
            await db.messages.insert_one(assistant_message.model_dump())
            await db.conversations.update_one(
                {"id": request.conversation_id},
                {"$set": {"updated_at": datetime.now(timezone.utc)}},
            )

            logger.info(f"Stream response generated: {full_text[:50]}...")

            # Send done event
            yield f"data: {json.dumps({'done': True, 'message_id': assistant_message.id, 'credits_used': CHAT_CREDIT_COST if is_authenticated else 0, 'credit_balance': remaining})}\n\n"

        except Exception as e:
            logger.error(f"Stream chat error: {str(e)}")
            # Refund credits on failure
            if is_authenticated:
                await refund_credits(request.user_id, CHAT_CREDIT_COST)
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


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
async def get_conversations(
    user_id: str,
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Get all conversations for a user that have at least one message"""
    # If authenticated, only allow accessing own conversations
    auth_user = await get_current_user(authorization)
    if auth_user and auth_user["id"] != user_id:
        raise HTTPException(status_code=403, detail="Not authorized")
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
async def get_messages(
    conversation_id: str,
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Get all messages in a conversation"""
    # Verify conversation ownership if authenticated
    auth_user = await get_current_user(authorization)
    if auth_user:
        conv = await db.conversations.find_one({"id": conversation_id})
        if conv and conv.get("user_id") != auth_user["id"]:
            raise HTTPException(status_code=403, detail="Not authorized")
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

        user_data = user.model_dump()
        user_data["credit_balance"] = WELCOME_BONUS_CREDITS
        await db.users.insert_one(user_data)
        logger.info(f"New Google user {email} — awarded {WELCOME_BONUS_CREDITS} welcome credits")
        token = create_token(user.id)

        return {
            "success": True,
            "token": token,
            "user": sanitize_user(user_data),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Google signup error: {str(e)}")
        raise HTTPException(status_code=400, detail="Google authentication failed")


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
        raise HTTPException(status_code=400, detail="Google authentication failed")


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
    """Authenticate with Monnify and return an access token."""
    credentials = base64.b64encode(f"{MONNIFY_API_KEY}:{MONNIFY_SECRET_KEY}".encode()).decode()
    async with httpx.AsyncClient(timeout=15) as http_client:
        resp = await http_client.post(
            f"{MONNIFY_BASE_URL}/api/v1/auth/login",
            headers={"Authorization": f"Basic {credentials}"},
        )
        resp.raise_for_status()
        data = resp.json()
    return data["responseBody"]["accessToken"]


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
    credits = int(request.amount / CREDIT_RATE)

    # Save transaction record
    transaction = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "amount": request.amount,
        "credits": credits,
        "payment_reference": payment_reference,
        "gateway": "monnify",
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
        "completed_at": None,
    }
    await db.transactions.insert_one(transaction)

    # Initialize with Monnify
    try:
        access_token = await get_monnify_token()
        customer_email = user.get("email") or f"{user['id']}@kwanya.app"
        customer_name = user.get("display_name") or user.get("phone") or "Kwanya User"

        async with httpx.AsyncClient(timeout=15) as http_client:
            resp = await http_client.post(
                f"{MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction",
                headers={"Authorization": f"Bearer {access_token}"},
                json={
                    "amount": request.amount,
                    "customerEmail": customer_email,
                    "customerName": customer_name,
                    "paymentReference": payment_reference,
                    "contractCode": MONNIFY_CONTRACT_CODE,
                    "currencyCode": "NGN",
                    "redirectUrl": "https://kwanya.app/payment/complete",
                    "paymentDescription": f"Purchase {credits} Kwanya credits",
                },
            )
            resp.raise_for_status()
            mn_data = resp.json()

        checkout_url = mn_data["responseBody"]["checkoutUrl"]

        return {
            "success": True,
            "checkout_url": checkout_url,
            "payment_reference": payment_reference,
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

    # Compute actual credits (with trader bonus) for response
    base_credits = transaction["credits"]
    actual_credits = int(base_credits * 1.16) if user.get("is_trader") else base_credits

    if transaction["status"] == "completed":
        return {"success": True, "status": "completed", "credits": actual_credits}

    # Verify with Monnify API
    try:
        access_token = await get_monnify_token()
        encoded_ref = urllib.parse.quote(payment_reference, safe="")

        async with httpx.AsyncClient(timeout=15) as http_client:
            resp = await http_client.get(
                f"{MONNIFY_BASE_URL}/api/v2/transactions/{encoded_ref}",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            resp.raise_for_status()
            mn_data = resp.json()

        body = mn_data.get("responseBody", {})
        payment_status = body.get("paymentStatus", "")
        amount = float(body.get("amountPaid", 0))
        logger.info(f"Monnify verify ref={payment_reference}: status={payment_status}, amount={amount}")

        if payment_status == "PAID" and amount >= transaction["amount"]:
            # Atomically credit user (idempotent via pending filter)
            result = await db.transactions.update_one(
                {"payment_reference": payment_reference, "status": "pending"},
                {"$set": {"status": "completed", "completed_at": datetime.now(timezone.utc)}},
            )
            if result.modified_count > 0:
                await db.users.update_one(
                    {"id": user["id"]},
                    {"$inc": {"credit_balance": actual_credits}},
                )
                logger.info(f"Credited {actual_credits} credits to user {user['id']} (trader: {user.get('is_trader', False)})")
            return {"success": True, "status": "completed", "credits": actual_credits}

        return {"success": True, "status": "pending"}

    except Exception as e:
        logger.error(f"Monnify verify error for ref={payment_reference}: {str(e)}")
        return {"success": True, "status": "pending"}


@api_router.post("/credits/transfer")
async def transfer_credits(
    request: TransferCreditsRequest,
    authorization: Optional[str] = Security(APIKeyHeader(name="Authorization", auto_error=False)),
):
    """Transfer credits from authenticated user to another user by phone or email"""
    sender = await get_current_user(authorization)
    if not sender:
        raise HTTPException(status_code=401, detail="Not authenticated")

    is_admin = sender.get("is_admin", False)

    if request.amount < 1:
        raise HTTPException(status_code=400, detail="Amount must be at least 1")

    if not is_admin and request.amount < 50:
        raise HTTPException(status_code=400, detail="Minimum transfer is 50 credits")

    # Determine if recipient identifier is phone or email
    recipient_value = request.recipient.strip()
    if not recipient_value:
        raise HTTPException(status_code=400, detail="Recipient is required")

    # If it looks like a phone number (starts with digit, +, or 0, and mostly digits)
    digits_only = re.sub(r'[^\d]', '', recipient_value)
    is_phone = len(digits_only) >= 7 and (recipient_value[0] in '0123456789+')

    if is_phone:
        normalized = normalize_phone(recipient_value)
        recipient = await db.users.find_one(
            {"phone": normalized, "id": {"$ne": sender["id"]}}, {"_id": 0}
        )
    else:
        normalized_email = recipient_value.lower()
        recipient = await db.users.find_one(
            {"email": normalized_email, "id": {"$ne": sender["id"]}}, {"_id": 0}
        )

    if not recipient:
        # Check if recipient is actually the sender
        if is_phone:
            self_check = await db.users.find_one({"phone": normalize_phone(recipient_value), "id": sender["id"]})
        else:
            self_check = await db.users.find_one({"email": recipient_value.lower(), "id": sender["id"]})
        if self_check:
            raise HTTPException(status_code=400, detail="Cannot send credits to yourself")
        raise HTTPException(status_code=404, detail="User not found")

    # Admins mint new credits; regular users deduct from balance
    if not is_admin:
        deduct_result = await db.users.update_one(
            {"id": sender["id"], "credit_balance": {"$gte": request.amount}},
            {"$inc": {"credit_balance": -request.amount}},
        )
        if deduct_result.modified_count == 0:
            raise HTTPException(status_code=400, detail="Insufficient credits")

    # Credit recipient
    await db.users.update_one(
        {"id": recipient["id"]},
        {"$inc": {"credit_balance": request.amount}},
    )

    # Log transfer for audit trail
    transfer_record = {
        "id": str(uuid.uuid4()),
        "sender_id": sender["id"],
        "recipient_id": recipient["id"],
        "amount": request.amount,
        "created_at": datetime.now(timezone.utc),
    }
    await db.credit_transfers.insert_one(transfer_record)

    recipient_name = recipient.get("display_name") or recipient.get("email") or recipient.get("phone") or "User"
    return {"success": True, "recipient_name": recipient_name, "amount": request.amount}


# ==================== FLUTTERWAVE WEBHOOK (DISABLED) ====================

@app.post("/api/webhooks/flutterwave")
async def flutterwave_webhook(request: Request):
    """Flutterwave payments disabled — kept for reference"""
    raise HTTPException(status_code=404, detail="Flutterwave payments disabled")
    # --- Original Flutterwave webhook code preserved below ---
    # if not FLUTTERWAVE_WEBHOOK_HASH:
    #     logger.error("FLUTTERWAVE_WEBHOOK_HASH not configured — rejecting webhook")
    #     raise HTTPException(status_code=503, detail="Webhook not configured")
    # signature = request.headers.get("verif-hash", "")
    # if not hmac.compare_digest(signature, FLUTTERWAVE_WEBHOOK_HASH):
    #     logger.warning("Flutterwave webhook hash mismatch")
    #     raise HTTPException(status_code=401, detail="Invalid webhook hash")
    # payload = await request.json()
    # event_data = payload.get("data", {})
    # tx_ref = event_data.get("tx_ref", "")
    # status = event_data.get("status", "")
    # amount = float(event_data.get("amount", 0))
    # logger.info(f"Flutterwave webhook: tx_ref={tx_ref}, status={status}, amount={amount}")
    # if not tx_ref:
    #     return {"status": "ignored"}
    # transaction = await db.transactions.find_one({"payment_reference": tx_ref})
    # if not transaction:
    #     logger.warning(f"Flutterwave webhook — transaction not found for tx_ref: {tx_ref}")
    #     return {"status": "ignored"}
    # if status == "successful" and amount >= transaction["amount"]:
    #     result = await db.transactions.update_one(
    #         {"payment_reference": tx_ref, "status": "pending"},
    #         {"$set": {"status": "completed", "completed_at": datetime.now(timezone.utc)}},
    #     )
    #     if result.modified_count > 0:
    #         buyer = await db.users.find_one({"id": transaction["user_id"]}, {"_id": 0, "is_trader": 1})
    #         credits_to_add = transaction["credits"]
    #         if buyer and buyer.get("is_trader"):
    #             credits_to_add = int(credits_to_add * 1.15)
    #         await db.users.update_one(
    #             {"id": transaction["user_id"]},
    #             {"$inc": {"credit_balance": credits_to_add}},
    #         )
    #         logger.info(f"Credited {credits_to_add} credits to user {transaction['user_id']}")
    # return {"status": "ok"}


# ==================== MONNIFY WEBHOOK ====================

@app.post("/api/webhooks/monnify")
async def monnify_webhook(request: Request):
    """Handle Monnify payment webhook notifications"""
    # Read raw body for signature verification
    raw_body = await request.body()
    signature = request.headers.get("monnify-signature", "")

    if not MONNIFY_SECRET_KEY:
        logger.error("MONNIFY_SECRET_KEY not configured — rejecting webhook")
        raise HTTPException(status_code=503, detail="Webhook not configured")

    # Verify HMAC-SHA512 signature
    computed = hmac.new(
        MONNIFY_SECRET_KEY.encode(),
        raw_body,
        hashlib.sha512,
    ).hexdigest()

    if not hmac.compare_digest(computed, signature):
        logger.warning("Monnify webhook signature mismatch")
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    payload = json.loads(raw_body)
    event_data = payload.get("eventData", {})
    tx_ref = event_data.get("transactionReference", "") or event_data.get("paymentReference", "")
    payment_status = event_data.get("paymentStatus", "")
    amount = float(event_data.get("amountPaid", 0))

    logger.info(f"Monnify webhook: ref={tx_ref}, status={payment_status}, amount={amount}")

    if not tx_ref:
        return {"status": "ignored"}

    # Try matching by paymentReference first (our reference), then transactionReference
    transaction = await db.transactions.find_one({"payment_reference": tx_ref})
    if not transaction:
        # Monnify may send transactionReference — try paymentReference from eventData
        pay_ref = event_data.get("paymentReference", "")
        if pay_ref and pay_ref != tx_ref:
            transaction = await db.transactions.find_one({"payment_reference": pay_ref})

    if not transaction:
        logger.warning(f"Monnify webhook — transaction not found for ref: {tx_ref}")
        return {"status": "ignored"}

    if payment_status == "PAID" and amount >= transaction["amount"]:
        result = await db.transactions.update_one(
            {"payment_reference": transaction["payment_reference"], "status": "pending"},
            {"$set": {
                "status": "completed",
                "completed_at": datetime.now(timezone.utc),
            }},
        )
        if result.modified_count > 0:
            buyer = await db.users.find_one({"id": transaction["user_id"]}, {"_id": 0, "is_trader": 1})
            credits_to_add = transaction["credits"]
            if buyer and buyer.get("is_trader"):
                credits_to_add = int(credits_to_add * 1.16)
            await db.users.update_one(
                {"id": transaction["user_id"]},
                {"$inc": {"credit_balance": credits_to_add}},
            )
            logger.info(f"Credited {credits_to_add} credits to user {transaction['user_id']} (trader bonus: {buyer and buyer.get('is_trader', False)})")

    return {"status": "ok"}


# ==================== LEGAL PAGES ====================

_LEGAL_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} - Kwanya</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px; line-height: 1.6; color: #222; }}
  h1 {{ font-size: 1.4em; }}
  pre {{ white-space: pre-wrap; word-wrap: break-word; font-family: inherit; }}
</style>
</head>
<body>
<pre>{content}</pre>
</body>
</html>"""

_PRIVACY_POLICY = """PRIVACY POLICY

Effective Date: 22 February 2026

Trulib Ltd ("we," "us," or "our") operates the Kwanya mobile application ("App"). This Privacy Policy explains how we collect, use, store, and protect your personal data when you use our App.

By using Kwanya, you agree to the practices described in this Privacy Policy.

1. INFORMATION WE COLLECT

a) Information You Provide:
\u2022 Phone number or email address (for account registration)
\u2022 One-Time Passwords (OTPs) for verification
\u2022 Text messages and voice recordings submitted during conversations
\u2022 Payment information processed through Monnify

b) Information Collected Automatically:
\u2022 Device type and operating system
\u2022 App usage data (e.g., session frequency, features used)
\u2022 Unique device identifiers
\u2022 Conversation metadata (timestamps, message counts)

c) Information from Third Parties:
\u2022 Payment confirmation data from Monnify
\u2022 Verification status from Termii (SMS/Email OTP provider)

2. HOW WE USE YOUR INFORMATION

We use your data to:
\u2022 Provide and improve AI-powered conversational services
\u2022 Verify your identity during registration and login
\u2022 Process credit purchases and manage your account balance
\u2022 Monitor usage for billing (credit deductions per message/voice input)
\u2022 Improve the quality and accuracy of our AI responses
\u2022 Ensure security and prevent fraud or abuse
\u2022 Comply with legal obligations

3. AI DATA PROCESSING

\u2022 Your text and voice inputs are sent to third-party AI models (e.g., Google Gemini) for generating responses.
\u2022 Voice inputs are processed using automatic speech recognition (ASR) to convert speech to text before being sent to the AI model.
\u2022 We may retain conversation history to maintain context within a session. Context is limited to the most recent messages per conversation.
\u2022 We do not use your personal conversations to train AI models.

4. DATA SHARING

We do not sell your personal data. We may share your data with:
\u2022 AI Service Providers (e.g., Google) \u2014 to process your queries
\u2022 Payment Processors (e.g., Monnify) \u2014 to handle transactions
\u2022 Communication Providers (e.g., Termii) \u2014 to send OTPs
\u2022 Law Enforcement \u2014 if required by law or to protect rights and safety

All third-party providers are bound by their own privacy policies and data protection obligations.

5. DATA RETENTION

\u2022 Account data: Retained as long as your account is active
\u2022 Conversation history: Stored to maintain context; may be deleted upon account deletion
\u2022 Payment records: Retained as required by financial regulations
\u2022 OTP data: Deleted immediately after verification

You may request deletion of your data by contacting us (see Section 11).

6. DATA SECURITY

We implement reasonable technical and organizational measures to protect your data, including:
\u2022 Encrypted data transmission (HTTPS/TLS)
\u2022 Secure storage of credentials and tokens
\u2022 Access controls on backend systems
\u2022 Regular security reviews

However, no system is completely secure, and we cannot guarantee absolute protection.

7. CHILDREN'S PRIVACY

Kwanya is not intended for children under the age of 13. We do not knowingly collect personal data from children under 13. If we discover such data has been collected, we will delete it promptly. Users between 13 and 18 must have parental or guardian consent.

8. YOUR RIGHTS

Depending on your jurisdiction, you may have the right to:
\u2022 Access the personal data we hold about you
\u2022 Request correction of inaccurate data
\u2022 Request deletion of your data
\u2022 Withdraw consent for data processing
\u2022 Object to certain types of data processing
\u2022 Request data portability

To exercise any of these rights, contact us at the details in Section 11.

9. COOKIES AND TRACKING

The Kwanya App does not use browser cookies. We may use local storage (e.g., AsyncStorage) on your device to maintain session data and preferences. This data remains on your device and is not transmitted to external tracking services.

10. CHANGES TO THIS POLICY

We may update this Privacy Policy from time to time. Any changes will be posted within the App, and your continued use constitutes acceptance of the updated policy. We encourage you to review this policy periodically.

11. CONTACT US

If you have questions, concerns, or requests regarding your privacy, please contact:

Trulib Ltd
Email: privacy@trulib.com

12. GOVERNING LAW

This Privacy Policy is governed by the laws of the Federal Republic of Nigeria, including the Nigeria Data Protection Regulation (NDPR) and any successor legislation."""


_TERMS_OF_USE = """TERMS OF USE

Effective Date: 22 February 2026

Welcome to Kwanya, an AI-powered educational and conversational assistant designed primarily for Hausa-speaking users. These Terms of Use ("Terms") govern your access to and use of the Kwanya mobile application ("App"), operated by Trulib Ltd ("we," "us," or "our").

By downloading, accessing, or using Kwanya, you agree to be bound by these Terms. If you do not agree, please do not use the App."""


@app.get("/privacy")
async def privacy_policy():
    """Serve privacy policy as a web page"""
    from fastapi.responses import HTMLResponse
    html = _LEGAL_HTML_TEMPLATE.format(title="Privacy Policy", content=_PRIVACY_POLICY)
    return HTMLResponse(content=html)


@app.get("/terms")
async def terms_of_use():
    """Serve terms of use as a web page"""
    from fastapi.responses import HTMLResponse
    html = _LEGAL_HTML_TEMPLATE.format(title="Terms of Use", content=_TERMS_OF_USE)
    return HTMLResponse(content=html)


@app.get("/delete-account")
async def delete_account_page():
    """Serve account deletion instructions page"""
    from fastapi.responses import HTMLResponse
    content = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Delete Account - Kwanya</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px; line-height: 1.6; color: #222; }
  h1 { font-size: 1.4em; }
  h2 { font-size: 1.1em; margin-top: 24px; }
  .method { background: #f5f5f5; border-radius: 8px; padding: 16px; margin: 16px 0; }
  ol { padding-left: 20px; }
  a { color: #007AFF; }
</style>
</head>
<body>
<h1>Delete Your Kwanya Account</h1>
<p>You can request deletion of your account and all associated data using either method below.</p>

<div class="method">
<h2>Option 1: Delete from the App</h2>
<ol>
  <li>Open the Kwanya app</li>
  <li>Go to <strong>Account</strong></li>
  <li>Tap <strong>Delete Account</strong></li>
  <li>Confirm the deletion</li>
</ol>
<p>Your account and all data will be deleted immediately.</p>
</div>

<div class="method">
<h2>Option 2: Request via Email</h2>
<p>Send an email to <a href="mailto:privacy@trulib.com">privacy@trulib.com</a> with the subject line <strong>"Delete My Account"</strong>. Include the phone number or email address associated with your account.</p>
<p>We will process your request within 7 business days.</p>
</div>

<h2>What gets deleted</h2>
<ul>
  <li>Your account profile and credentials</li>
  <li>All conversations and messages</li>
  <li>Credit balance and transaction history</li>
  <li>Any other data associated with your account</li>
</ul>

<p><strong>This action is permanent and cannot be undone.</strong></p>

<p style="margin-top: 32px; color: #666; font-size: 0.9em;">Kwanya is operated by Trulib Ltd. For questions, contact <a href="mailto:privacy@trulib.com">privacy@trulib.com</a></p>
</body>
</html>"""
    return HTMLResponse(content=content)


# ==================== FEATURE FLAGS ====================

@api_router.get("/features")
async def get_feature_flags():
    """Return feature flags for the client app"""
    return {
        "payments": ENABLE_PAYMENTS,
    }


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
    sa_b64 = os.environ.get('GCP_SERVICE_ACCOUNT_B64', '')
    use_vertex = bool(sa_json) or bool(sa_b64) or bool(os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')) or bool(os.environ.get('GCP_USE_VERTEX'))

    return {
        "status": "healthy" if mongo_status == "connected" else "degraded",
        "services": {
            "mongodb": mongo_status,
            "asr": "Google Cloud Speech-to-Text (ha-NG)",
            "gemini": "configured (Vertex AI)" if use_vertex else ("configured (API key)" if (os.environ.get('GEMINI_API_KEY') or os.environ.get('EMERGENT_LLM_KEY')) else "not configured"),
        },
        "asr_engine": "Google Cloud Speech-to-Text v2 (Hausa ha-NG)",
    }


# Include the routers in the main app
app.include_router(api_router)
app.include_router(auth_router)

# CORS - restrict to known origins in production
allowed_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_credentials=True,
        allow_origins=allowed_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    # Development: allow all origins but without credentials
    app.add_middleware(
        CORSMiddleware,
        allow_credentials=False,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

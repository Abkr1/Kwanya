FROM python:3.11-slim

# Install ffmpeg for audio conversion (M4A -> WAV)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (torch is large, install first for caching)
COPY requirements.txt .
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir -r requirements.txt

COPY . .

# Railway sets PORT env var dynamically
ENV PORT=8001
EXPOSE 8001

CMD uvicorn server:app --host 0.0.0.0 --port ${PORT}

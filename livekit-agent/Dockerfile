FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Pre-download and cache Silero VAD model files during build to avoid runtime download delays
RUN python -m livekit.agents download-files

CMD ["python", "agent.py", "start"]

#!/bin/bash

# AI Healthcare Voice Agent - Complete System Startup Script
# Handles fresh installation, builds images, and starts all services

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

success() {
    echo -e "${GREEN}✓${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
    exit 1
}

info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

section() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

echo ""
echo "=========================================="
echo "🏥 AI Healthcare Voice Agent"
echo "   Complete System Startup"
echo "=========================================="
echo ""
echo "This script will:"
echo "  1. Check prerequisites"
echo "  2. Validate local AI model files"
echo "  3. Build Docker images"
echo "  4. Start all services"
echo "  5. Initialize database"
echo ""

# Check prerequisites
section "STEP 1: Checking Prerequisites"

# Check Docker
if ! command -v docker &> /dev/null; then
    error "Docker is not installed. Please install Docker first:
    
    Ubuntu/Debian: sudo apt-get install docker.io
    macOS: brew install docker
    Or visit: https://docs.docker.com/get-docker/"
fi
success "Docker is installed"

# Check Docker Compose
if ! docker compose version > /dev/null 2>&1; then
    error "Docker Compose is not installed. Please install Docker Compose first:
    
    Ubuntu/Debian: sudo apt-get install docker-compose-plugin
    macOS: Included with Docker Desktop
    Or visit: https://docs.docker.com/compose/install/"
fi
success "Docker Compose is installed"

# Check if Docker daemon is running
if ! docker info &> /dev/null 2>&1; then
    error "Docker daemon is not running. Please start Docker:
    
    Ubuntu/Debian: sudo systemctl start docker
    macOS: Start Docker Desktop application"
fi
success "Docker daemon is running"

# Check for .env file
if [ ! -f .env ]; then
    warning ".env file not found, creating from defaults..."
    cat > .env << 'EOF'
DB_HOST=postgres
DB_USER=postgres
DB_PASS=postgres
DB_NAME=healthcare
DB_PORT=5432
REDIS_HOST=redis
REDIS_PORT=6379
JWT_SECRET=supersecret_change_in_production
OLLAMA_URL=http://ollama:11434
OLLAMA_MODEL_PATH=/models/ollama/qwen2.5-3b-instruct-q4_K_M.gguf
OLLAMA_MODEL_CHAT_PATH=/models/ollama/qwen2.5-3b-instruct-q4_K_M.gguf
OLLAMA_MODEL_ANALYSIS_PATH=/models/ollama/qwen2.5-7b-instruct-q4_K_M.gguf
OLLAMA_MODEL_DECISION_PATH=/models/ollama/qwen2.5-3b-instruct-q4_K_M.gguf
LLM_MAX_TOKENS=200
LLM_NUM_CTX=1536
LLM_NUM_CTX_REALTIME=1536
LLM_MAX_TOKENS_ANALYSIS=768
LLM_NUM_CTX_ANALYSIS=8192
LLM_TIMEOUT_MS=45000
WORKER_CONCURRENCY=1
CALL_SPACING_MS=15000
RING_TIMEOUT_MS=30000
WEBSOCKET_CALL_MAX_WAIT_MS=720000
POST_CALL_ANALYSIS_MAX_WAIT_MS=90000
WHISPER_HOST=whisper
WHISPER_PORT=9000
WHISPER_MODEL_PATH=/models/whisper/ggml-small.en.bin
STT_CHUNK_MS=2500
STT_SILENCE_MS=800
TTS_HOST=tts
TTS_PORT=5002
TTS_MODEL_PATH=/models/tts/tts_models--en--ljspeech--tacotron2-DDC/model_file.pth.tar
TTS_CONFIG_PATH=/models/tts/tts_models--en--ljspeech--tacotron2-DDC/config.json
TTS_VOCODER_PATH=/models/tts/vocoder_models--en--ljspeech--hifigan_v2/model_file.pth.tar
TTS_VOCODER_CONFIG_PATH=/models/tts/vocoder_models--en--ljspeech--hifigan_v2/config.json
MAX_CALL_DURATION_MS=600000
MAX_CONVERSATION_TURNS=30
MAX_RUNTIME_RAM_GB=14
REQUIRE_SERVER_TTS=true
VITE_REQUIRE_SERVER_TTS=true
NODE_ENV=production
EOF
    success ".env file created"
else
    success ".env file exists"
fi

# Local model helpers
get_env_value() {
    local key="$1"
    grep -E "^${key}=" .env | tail -n 1 | cut -d '=' -f2- | tr -d '\r' | xargs
}

resolve_model_host_path() {
    local container_path="$1"
    local container_prefix="$2"
    local host_prefix="$3"

    if [[ "$container_path" == "$container_prefix"* ]]; then
        echo "${host_prefix}${container_path#$container_prefix}"
        return
    fi

    echo "$container_path"
}

assert_local_file() {
    local label="$1"
    local file_path="$2"
    local help_text="$3"

    if [ -z "$file_path" ]; then
        error "$label is not configured in .env."
    fi

    if [ ! -f "$file_path" ]; then
        error "$label not found at '$file_path'.

$help_text"
    fi
}

section "STEP 2: Validating Local AI Model Files"

OLLAMA_MODEL_PATH=$(get_env_value "OLLAMA_MODEL_PATH")
OLLAMA_MODEL_CHAT_PATH=$(get_env_value "OLLAMA_MODEL_CHAT_PATH")
OLLAMA_MODEL_ANALYSIS_PATH=$(get_env_value "OLLAMA_MODEL_ANALYSIS_PATH")
OLLAMA_MODEL_DECISION_PATH=$(get_env_value "OLLAMA_MODEL_DECISION_PATH")

if [ -z "$OLLAMA_MODEL_PATH" ]; then
    OLLAMA_MODEL_PATH="/models/ollama/qwen2.5-3b-instruct-q4_K_M.gguf"
fi
if [ -z "$OLLAMA_MODEL_CHAT_PATH" ]; then
    OLLAMA_MODEL_CHAT_PATH="/models/ollama/qwen2.5-3b-instruct-q4_K_M.gguf"
fi
if [ -z "$OLLAMA_MODEL_ANALYSIS_PATH" ]; then
    OLLAMA_MODEL_ANALYSIS_PATH="/models/ollama/qwen2.5-7b-instruct-q4_K_M.gguf"
fi
if [ -z "$OLLAMA_MODEL_DECISION_PATH" ]; then
    OLLAMA_MODEL_DECISION_PATH="/models/ollama/qwen2.5-3b-instruct-q4_K_M.gguf"
fi

HOST_OLLAMA_MODEL_PATH=$(resolve_model_host_path "$OLLAMA_MODEL_PATH" "/models/ollama/" "./models/ollama/")
HOST_OLLAMA_MODEL_CHAT_PATH=$(resolve_model_host_path "$OLLAMA_MODEL_CHAT_PATH" "/models/ollama/" "./models/ollama/")
HOST_OLLAMA_MODEL_ANALYSIS_PATH=$(resolve_model_host_path "$OLLAMA_MODEL_ANALYSIS_PATH" "/models/ollama/" "./models/ollama/")
HOST_OLLAMA_MODEL_DECISION_PATH=$(resolve_model_host_path "$OLLAMA_MODEL_DECISION_PATH" "/models/ollama/" "./models/ollama/")

info "Checking local Ollama GGUF model files..."
assert_local_file "Ollama base model" "$HOST_OLLAMA_MODEL_PATH" "Place GGUF files under ./models/ollama and update OLLAMA_MODEL*_PATH values in .env."
assert_local_file "Ollama chat model" "$HOST_OLLAMA_MODEL_CHAT_PATH" "Place GGUF files under ./models/ollama and update OLLAMA_MODEL*_PATH values in .env."
assert_local_file "Ollama analysis model" "$HOST_OLLAMA_MODEL_ANALYSIS_PATH" "Place GGUF files under ./models/ollama and update OLLAMA_MODEL*_PATH values in .env."
assert_local_file "Ollama decision model" "$HOST_OLLAMA_MODEL_DECISION_PATH" "Place GGUF files under ./models/ollama and update OLLAMA_MODEL*_PATH values in .env."
success "Local Ollama model files are ready"

WHISPER_MODEL_PATH=$(get_env_value "WHISPER_MODEL_PATH")
if [ -z "$WHISPER_MODEL_PATH" ]; then
    WHISPER_MODEL_PATH="/models/whisper/ggml-small.en.bin"
fi

HOST_WHISPER_MODEL_PATH=$(resolve_model_host_path "$WHISPER_MODEL_PATH" "/models/whisper/" "./models/whisper/")

info "Checking local Whisper model file..."
assert_local_file "Whisper model" "$HOST_WHISPER_MODEL_PATH" "Place Whisper GGML files under ./models/whisper and update WHISPER_MODEL_PATH in .env."
success "Local Whisper model file is ready"

section "STEP 2B: Validating Local TTS Model Files"

TTS_MODEL_PATH=$(get_env_value "TTS_MODEL_PATH")
TTS_CONFIG_PATH=$(get_env_value "TTS_CONFIG_PATH")
TTS_VOCODER_PATH=$(get_env_value "TTS_VOCODER_PATH")
TTS_VOCODER_CONFIG_PATH=$(get_env_value "TTS_VOCODER_CONFIG_PATH")

if [ -z "$TTS_MODEL_PATH" ]; then
    TTS_MODEL_PATH="/models/tts/tts_models--en--ljspeech--tacotron2-DDC/model_file.pth.tar"
fi
if [ -z "$TTS_CONFIG_PATH" ]; then
    TTS_CONFIG_PATH="/models/tts/tts_models--en--ljspeech--tacotron2-DDC/config.json"
fi
if [ -z "$TTS_VOCODER_PATH" ]; then
    TTS_VOCODER_PATH="/models/tts/vocoder_models--en--ljspeech--hifigan_v2/model_file.pth.tar"
fi
if [ -z "$TTS_VOCODER_CONFIG_PATH" ]; then
    TTS_VOCODER_CONFIG_PATH="/models/tts/vocoder_models--en--ljspeech--hifigan_v2/config.json"
fi

HOST_TTS_MODEL_PATH=$(resolve_model_host_path "$TTS_MODEL_PATH" "/models/tts/" "./models/tts/")
HOST_TTS_CONFIG_PATH=$(resolve_model_host_path "$TTS_CONFIG_PATH" "/models/tts/" "./models/tts/")
HOST_TTS_VOCODER_PATH=$(resolve_model_host_path "$TTS_VOCODER_PATH" "/models/tts/" "./models/tts/")
HOST_TTS_VOCODER_CONFIG_PATH=$(resolve_model_host_path "$TTS_VOCODER_CONFIG_PATH" "/models/tts/" "./models/tts/")

info "Checking local Coqui TTS model files..."
assert_local_file "TTS model" "$HOST_TTS_MODEL_PATH" "Place Coqui model files under ./models/tts and update TTS_* paths in .env."
assert_local_file "TTS config" "$HOST_TTS_CONFIG_PATH" "Place Coqui model files under ./models/tts and update TTS_* paths in .env."
assert_local_file "TTS vocoder model" "$HOST_TTS_VOCODER_PATH" "Place Coqui model files under ./models/tts and update TTS_* paths in .env."
assert_local_file "TTS vocoder config" "$HOST_TTS_VOCODER_CONFIG_PATH" "Place Coqui model files under ./models/tts and update TTS_* paths in .env."
success "Local Coqui TTS model files are ready"

# Check if system is already running
section "STEP 3: Checking Existing Containers"

if docker ps | grep -q healthcare_backend; then
    info "System is already running"
    read -p "Do you want to restart? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        info "Stopping existing containers..."
        docker compose down
        success "Containers stopped"
    else
        info "Keeping existing containers running"
        echo ""
        echo "=========================================="
        echo "✅ System is already running"
        echo "=========================================="
        echo ""
        echo "Access URLs:"
        echo "  Frontend:  http://localhost:3000"
        echo "  Backend:   http://localhost:4000"
        echo "  Health:    http://localhost:4000/health"
        echo ""
        echo "Default Logins:"
        echo "  Product Admin: productadmin@healthcare.com / admin123"
        echo "  Hospital Admin: admin@demo.com / admin123"
        echo ""
        echo "Run './verify.sh' to test all components"
        exit 0
    fi
fi

# Build Docker images
section "STEP 4: Building Docker Images"

info "Building images (this may take 5-10 minutes on first run)..."
echo ""

# Build with progress
docker compose build --progress=plain

if [ $? -ne 0 ]; then
    error "Failed to build Docker images. Check the error messages above."
fi

success "All Docker images built successfully"
echo ""

# Start the system
section "STEP 5: Starting All Services"

info "Starting containers..."
info "This will take 2-3 minutes for initialization"
echo ""

docker compose up -d

if [ $? -ne 0 ]; then
    error "Failed to start services. Check logs with: docker compose logs"
fi

success "All services started"
echo ""

# Wait for services to be healthy
section "STEP 6: Waiting for Services to Initialize"

wait_for_service() {
    local service=$1
    local max_attempts=60
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        if docker ps --format '{{.Names}}\t{{.Status}}' | grep "$service" | grep -q "healthy\|Up"; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
        if [ $((attempt % 5)) -eq 0 ]; then
            echo -n "."
        fi
    done
    return 1
}

# PostgreSQL
info "Waiting for PostgreSQL..."
if wait_for_service "healthcare_db"; then
    success "PostgreSQL is ready"
else
    error "PostgreSQL failed to start. Check logs: docker logs healthcare_db"
fi

# Redis
info "Waiting for Redis..."
if wait_for_service "healthcare_redis"; then
    success "Redis is ready"
else
    error "Redis failed to start. Check logs: docker logs healthcare_redis"
fi

# Ollama
info "Waiting for Ollama..."
if wait_for_service "healthcare_ollama"; then
    success "Ollama is ready"
else
    error "Ollama failed to start. Check logs: docker logs healthcare_ollama"
fi

# Whisper
info "Waiting for Whisper STT..."
if wait_for_service "healthcare_whisper"; then
    success "Whisper is ready"
else
    warning "Whisper may still be loading (non-critical)"
fi

# Backend
info "Waiting for Backend API..."
sleep 5
MAX_ATTEMPTS=30
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s -f http://localhost:4000/health > /dev/null 2>&1; then
        success "Backend API is ready"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 2
    if [ $((ATTEMPT % 5)) -eq 0 ]; then
        echo -n "."
    fi
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    error "Backend API failed to start. Check logs: docker logs healthcare_backend"
fi

# Worker
info "Waiting for Worker..."
if wait_for_service "healthcare_worker"; then
    success "Worker is ready"
else
    error "Worker failed to start. Check logs: docker logs healthcare_worker"
fi

# Frontend
info "Waiting for Frontend..."
sleep 5
MAX_ATTEMPTS=30
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s http://localhost:3000 > /dev/null 2>&1; then
        success "Frontend is ready"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 2
    if [ $((ATTEMPT % 5)) -eq 0 ]; then
        echo -n "."
    fi
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    warning "Frontend may still be building (check in browser)"
fi

echo ""
success "All critical services are healthy!"
echo ""

# Show service status
section "STEP 7: System Status"
docker compose ps

echo ""
echo "=========================================="
echo "✅ SYSTEM READY"
echo "=========================================="
echo ""
echo "🌐 Access URLs:"
echo "  Frontend:  http://localhost:3000"
echo "  Backend:   http://localhost:4000"
echo "  Health:    http://localhost:4000/health"
echo "  Test Calls: http://localhost:3000/call-links"
echo ""
echo "🔐 Default Logins:"
echo ""
echo "  Product Admin (Manage all hospitals):"
echo "    Email:    productadmin@healthcare.com"
echo "    Password: admin123"
echo ""
echo "  Hospital Admin (Demo Healthcare):"
echo "    Email:    admin@demo.com"
echo "    Password: admin123"
echo ""
echo "📊 Sample Data:"
echo "  Organization: Demo Healthcare"
echo "  Patients: 3 (John Smith, Sarah Johnson, Michael Brown)"
echo ""
echo "📚 Documentation:"
echo "  README.md      - Complete system documentation"
echo "  USER_GUIDE.md  - How to use (all roles)"
echo ""
echo "🧪 Testing:"
echo "  ./verify.sh    - Run complete system verification"
echo ""
echo "📝 Useful Commands:"
echo "  docker compose logs -f           - View all logs"
echo "  docker logs -f healthcare_worker - View worker logs"
echo "  docker logs -f healthcare_backend - View backend logs"
echo "  docker compose ps                - Check status"
echo "  docker compose down              - Stop system"
echo "  docker compose restart           - Restart all services"
echo ""
echo "🔧 Troubleshooting:"
echo "  If services fail to start:"
echo "    1. Check logs: docker compose logs"
echo "    2. Restart: docker compose restart"
echo "    3. Full reset: docker compose down -v && ./start.sh"
echo ""
echo "=========================================="
echo "🎉 Ready for demonstration!"
echo "=========================================="
echo ""

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
echo "  2. Install/configure Ollama"
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
if ! command -v docker compose &> /dev/null; then
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
OLLAMA_URL=http://host.docker.internal:11434
LLM_MODEL=qwen2.5:3b-instruct-q4_K_M
LLM_MODEL_CHAT=qwen2.5:3b-instruct-q4_K_M
LLM_MODEL_ANALYSIS=qwen2.5:7b-instruct-q4_K_M
LLM_MODEL_DECISION=qwen2.5:3b-instruct-q4_K_M
LLM_MAX_TOKENS=512
LLM_NUM_CTX=2048
LLM_MAX_TOKENS_ANALYSIS=768
LLM_NUM_CTX_ANALYSIS=8192
LLM_AUTO_PULL_MODELS=false
LLM_TIMEOUT_MS=45000
WORKER_CONCURRENCY=1
CALL_SPACING_MS=15000
RING_TIMEOUT_MS=30000
WEBSOCKET_CALL_MAX_WAIT_MS=720000
POST_CALL_ANALYSIS_MAX_WAIT_MS=90000
WHISPER_HOST=whisper
WHISPER_PORT=9000
WHISPER_MODEL_PATH=/models/ggml-base.en.bin
STT_CHUNK_MS=1800
STT_SILENCE_MS=800
TTS_HOST=tts
TTS_PORT=5002
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

# Check Ollama
section "STEP 2: Installing/Configuring Ollama"

if ! command -v ollama &> /dev/null; then
    warning "Ollama is not installed. Installing now..."
    
    # Detect OS
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        info "Installing Ollama on Linux..."
        curl -fsSL https://ollama.ai/install.sh | sh
        success "Ollama installed"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        info "Installing Ollama on macOS..."
        if command -v brew &> /dev/null; then
            brew install ollama
            success "Ollama installed"
        else
            error "Homebrew not found. Please install Ollama manually:
            
            Visit: https://ollama.ai/download"
        fi
    else
        error "Unsupported OS. Please install Ollama manually:
        
        Visit: https://ollama.ai/download"
    fi
else
    success "Ollama is already installed"
fi

# Start Ollama service
info "Starting Ollama service..."
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux with systemd
    if command -v systemctl &> /dev/null; then
        # Configure Ollama to listen on all interfaces
        if [ ! -f /etc/systemd/system/ollama.service.d/override.conf ]; then
            info "Configuring Ollama to listen on all interfaces..."
            sudo mkdir -p /etc/systemd/system/ollama.service.d
            echo -e "[Service]\nEnvironment=\"OLLAMA_HOST=0.0.0.0:11434\"" | sudo tee /etc/systemd/system/ollama.service.d/override.conf > /dev/null
            sudo systemctl daemon-reload
        fi
        
        sudo systemctl enable ollama 2>/dev/null || true
        sudo systemctl start ollama 2>/dev/null || true
        sleep 3
        success "Ollama service started"
    else
        # Start Ollama in background
        nohup ollama serve > /dev/null 2>&1 &
        sleep 3
        success "Ollama started in background"
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    if ! pgrep -x "ollama" > /dev/null; then
        nohup ollama serve > /dev/null 2>&1 &
        sleep 3
        success "Ollama started in background"
    else
        success "Ollama is already running"
    fi
fi

# Verify Ollama is accessible
info "Verifying Ollama connection..."
MAX_ATTEMPTS=10
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        success "Ollama is accessible"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 2
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    error "Cannot connect to Ollama. Please check if it's running:
    
    Test: curl http://localhost:11434/api/tags"
fi

# Pull configured LLM models
get_env_value() {
    local key="$1"
    grep -E "^${key}=" .env | tail -n 1 | cut -d '=' -f2- | tr -d '\r' | xargs
}

normalize_model_name() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | xargs
}

get_available_model_names() {
    local tags_json="$1"
    echo "$tags_json" \
      | grep -oE '"(name|model)":"[^"]+"' \
      | sed -E 's/"(name|model)":"([^"]+)"/\2/' \
      | tr '[:upper:]' '[:lower:]' \
      | sort -u
}

model_exists_in_ollama() {
    local required_model
    required_model=$(normalize_model_name "$1")
    local tags_json="$2"

    if [ -z "$required_model" ]; then
        return 1
    fi

    local available_model
    while IFS= read -r available_model; do
        [ -z "$available_model" ] && continue
        if [ "$available_model" = "$required_model" ]; then
            return 0
        fi
        if [[ "$available_model" == "$required_model"* ]]; then
            return 0
        fi
        if [[ "$required_model" == "$available_model"* ]]; then
            return 0
        fi
    done < <(get_available_model_names "$tags_json")

    return 1
}

BASE_MODEL=$(get_env_value "LLM_MODEL")
CHAT_MODEL=$(get_env_value "LLM_MODEL_CHAT")
ANALYSIS_MODEL=$(get_env_value "LLM_MODEL_ANALYSIS")
DECISION_MODEL=$(get_env_value "LLM_MODEL_DECISION")

if [ -z "$BASE_MODEL" ]; then
    error "LLM_MODEL is missing in .env. Configure model names before startup."
fi

MODELS_TO_CHECK=("$BASE_MODEL" "$CHAT_MODEL" "$ANALYSIS_MODEL" "$DECISION_MODEL")
UNIQUE_MODELS=()
for model_name in "${MODELS_TO_CHECK[@]}"; do
    [ -z "$model_name" ] && continue
    found=false
    for existing_model in "${UNIQUE_MODELS[@]}"; do
        if [ "$existing_model" = "$model_name" ]; then
            found=true
            break
        fi
    done
    if [ "$found" = false ]; then
        UNIQUE_MODELS+=("$model_name")
    fi
done

if [ ${#UNIQUE_MODELS[@]} -eq 0 ]; then
    error "No LLM models configured in .env."
fi

info "Ensuring configured Ollama model(s) are available: ${UNIQUE_MODELS[*]}"
for model_name in "${UNIQUE_MODELS[@]}"; do
    TAGS_JSON=$(curl -s http://localhost:11434/api/tags)
    if model_exists_in_ollama "$model_name" "$TAGS_JSON"; then
        success "Model '${model_name}' is already available"
        continue
    fi

    info "Pulling model '${model_name}' (first-time download may take several minutes)..."
    ollama pull "$model_name"
    success "Model '${model_name}' ready"
done

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

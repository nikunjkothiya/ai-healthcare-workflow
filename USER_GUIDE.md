# 🏥 AI Healthcare Voice Agent - User Guide

Complete guide for using the system across different roles: Hospital Staff, Campaign Manager, Care Coordinator, QA Tester, and System Administrator.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Hospital Staff](#hospital-staff)
3. [Campaign Manager](#campaign-manager)
4. [Care Coordinator](#care-coordinator)
5. [QA Tester](#qa-tester)
6. [System Administrator](#system-administrator)
7. [API Reference](#api-reference)
8. [Troubleshooting](#troubleshooting)

---

## Getting Started

### System Access

**Frontend Dashboard:** http://localhost:3000
**Backend API:** http://localhost:4000

**Default Login:**
- Product Admin: `productadmin@healthcare.com` / `admin123`
- Hospital Admin: `admin@demo.com` / `admin123`

**Note:** Both credentials are displayed on the login page for easy testing access.

### First Time Setup

1. Start the system:
```bash
./start.sh
```

2. Wait for all services to be ready (2-3 minutes)

3. Open browser to http://localhost:3000

4. Login with default credentials

---

## Hospital Staff

### Role: Patient Data Management

#### 1. Register Organization

**Via API:**
```bash
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email":"staff@hospital.com",
    "password":"secure123",
    "organizationName":"City General Hospital"
  }'
```

**Response:**
```json
{
  "message": "User registered successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 2,
    "email": "staff@hospital.com",
    "organizationId": 2
  }
}
```

**Save your token** - you'll need it for all API calls.

#### 2. Manage Patients (Centralized Database)

**NEW WORKFLOW:** Patients are now managed centrally, not uploaded per campaign.

**Via Frontend:**
1. Login to dashboard
2. Click "Patients" in navigation
3. View all patients with categories
4. Add patients individually or import CSV

**Add Single Patient:**
- Click "+ Add Patient"
- Fill in: Name, Phone, Category, Condition, Age
- Categories: Diabetes, Heart Disease, Asthma, Hypertension, Other
- Click "Add Patient"

**Import CSV:**
- Click "📤 Import CSV"
- CSV Format:
```csv
name,phone,category,medical_condition,age,appointment_date,doctor
John Smith,555-0101,diabetes,Type 2 Diabetes,65,2026-03-15,Dr. Wilson
Sarah Johnson,555-0102,heart_disease,Hypertension,58,2026-03-16,Dr. Chen
Michael Brown,555-0103,asthma,Chronic Asthma,42,2026-03-17,Dr. Patel
```

**Required Fields:**
- `name` - Patient full name
- `phone` - Contact number
- `category` - diabetes | heart_disease | asthma | hypertension | other

**Optional Fields:**
- Any additional columns become metadata (medical_condition, age, appointment_date, doctor, etc.)

**Via API:**

**Add Single Patient:**
```bash
curl -X POST http://localhost:4000/patients \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Smith",
    "phone": "555-0101",
    "category": "diabetes",
    "metadata": {
      "medical_condition": "Type 2 Diabetes",
      "age": 65,
      "appointment_date": "2026-03-15",
      "doctor": "Dr. Wilson"
    }
  }'
```

**Import CSV:**
```bash
curl -X POST http://localhost:4000/patients/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@patients.csv"
```

**Response:**
```json
{
  "message": "5 patients imported successfully",
  "patients": [
    {
      "id": 1,
      "name": "John Smith",
      "phone": "555-0101",
      "category": "diabetes",
      "status": "active",
      "metadata": {
        "medical_condition": "Type 2 Diabetes",
        "age": 65,
        "appointment_date": "2026-03-15",
        "doctor": "Dr. Wilson"
      }
    }
  ]
}
```

#### 3. Search and Filter Patients

**Via Frontend:**
- Use search box to find patients by name, phone, or condition
- Filter by category: All, Diabetes, Heart Disease, Asthma, Hypertension, Other
- View patient details including last contact date

**Via API:**
```bash
# Get all patients
curl http://localhost:4000/patients \
  -H "Authorization: Bearer YOUR_TOKEN"

# Get patients by category
curl http://localhost:4000/patients/by-category/diabetes \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### 4. Update or Delete Patients

**Via Frontend:**
- Click ✏️ to edit patient details
- Click 🗑️ to delete patient

**Via API:**
```bash
# Update patient
curl -X PUT http://localhost:4000/patients/1 \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Smith",
    "phone": "555-0101",
    "category": "diabetes",
    "status": "active",
    "metadata": {...}
  }'

# Delete patient
curl -X DELETE http://localhost:4000/patients/1 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Campaign Manager

### Role: Create and Manage Outreach Campaigns

### Quick Start: Running Your First Campaign

1. **Create & Schedule Campaign** → Fill campaign name, opening prompt, patient groups, and schedule in one modal
2. **Auto Assign + Queue** → System assigns selected groups and starts/schedules campaign automatically
3. **Copy Patient URLs** → Each patient has a unique call URL in the table
4. **Open Patient Phones** → Click "Open All Patient Phones" or open individually
5. **Accept Calls** → Each tab shows incoming call, click Accept
6. **Have Conversations** → Speak naturally, AI responds with real speech
7. **View Results** → Check dashboard for transcripts and analysis

**Key URLs:**
- Dashboard: `http://localhost:3000/dashboard`
- Campaigns: `http://localhost:3000/campaigns`
- Patient Call: `http://localhost:3000/mobile-call?patient=<id>&campaign=<id>`

**Important Notes:**
- AI calls patients ONE BY ONE (sequential processing)
- Patient URLs are shown in campaign details modal when campaign is running
- Each URL represents a patient's phone (open in separate tabs)
- Use real speech for conversations (microphone required)
- Patient status updates in real-time

#### 1. Create Campaign

**Via Frontend:**
1. Login to dashboard
2. Click "Campaigns" → "+ Create Campaign"
3. Fill in details:
   - **Campaign Name**: "March Appointment Reminders"
   - **Opening Prompt**: "Hello, I'm calling from City General Hospital to confirm your upcoming appointment with Dr. Smith."
   - **Select Patient Groups**: Diabetes / Heart Disease / Asthma / Hypertension / Other
   - **When to Start Calling?**:
     - ⭕ **Start Now** (begins in 1 minute) - Recommended for testing
     - ⭕ **Schedule for Later** (pick specific date/time)
4. If "Schedule for Later" selected, pick date and time
5. Click "Create & Schedule"

**Opening Prompt:** This is the first thing the AI agent says when the patient answers the call. Make it clear, friendly, and informative.

**Start Time Options:**
- **Start Now**: Campaign begins calling patients 1 minute after creation. This gives you time to open patient URLs and prepare.
- **Schedule for Later**: Campaign starts at your specified date/time. Useful for scheduling campaigns in advance.

**Via API:**
```bash
# Start in 1 minute (recommended for testing)
curl -X POST http://localhost:4000/campaigns \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "March Appointment Reminders",
    "opening_prompt": "Hello, I am calling from City General Hospital to confirm your upcoming appointment with Dr. Smith.",
    "schedule_time": null,
    "retry_limit": 0
  }'

# Or schedule for specific time
curl -X POST http://localhost:4000/campaigns \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "March Appointment Reminders",
    "opening_prompt": "Hello, I am calling from City General Hospital to confirm your upcoming appointment with Dr. Smith.",
    "schedule_time": "2026-03-01T09:00:00Z",
    "retry_limit": 0
  }'
```

**Important Notes:**
- `retry_limit: 0` means NO automatic retries. If patient misses or rejects call, they are marked as "missed" or "rejected" and system moves to next patient.
- `opening_prompt` is stored in `script_template` field in database
- If `schedule_time` is null, campaign starts automatically right after create+assign flow

#### 2. Configure Agent Behavior

**Via API:**
```bash
curl -X PUT http://localhost:4000/admin/agent-config/1 \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "max_turns": 5,
    "greeting_script": "Hello, this is City General Hospital calling to confirm your appointment",
    "prompt_template": "You are a friendly healthcare assistant. Keep responses brief and natural.",
    "end_keywords": ["goodbye", "bye", "thanks", "thank you"],
    "followup_keywords": ["call back", "later", "not now", "busy"],
    "confirmation_keywords": ["yes", "confirm", "correct", "sure", "okay"]
  }'
```

**Configuration Options:**
- `max_turns` - Maximum conversation turns (default: 5)
- `greeting_script` - Opening message
- `prompt_template` - AI behavior instructions
- `end_keywords` - Words that end the call
- `followup_keywords` - Words that trigger follow-up
- `confirmation_keywords` - Words indicating confirmation

#### 3. One-Modal Campaign Flow (Frontend)

The Campaigns UI now runs create + assign + start in one action:

1. Open **Campaigns** and click **+ Create Campaign**
2. Fill campaign name and opening prompt
3. Select patient categories in the same modal
4. Choose start time (**Start Now** or **Schedule for Later**)
5. Click **Create & Schedule**
6. Campaign details opens with patient URLs and live status

**What Happens Automatically:**
- Campaign is created
- Selected patient groups are assigned
- Campaign is started/scheduled in WebSocket mode
- Patient statuses update live (`queued -> ringing -> calling -> completed/missed/rejected`)

#### 4. API Split Flow (Optional Advanced Usage)

If you prefer API-level control, you can still run the three calls separately:

```bash
# 1) Create campaign
curl -X POST http://localhost:4000/campaigns \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "March Appointment Reminders",
    "opening_prompt": "Hello, I am calling from City General Hospital to confirm your upcoming appointment with Dr. Smith.",
    "schedule_time": null,
    "retry_limit": 0
  }'

# 2) Assign categories
curl -X POST http://localhost:4000/campaigns/1/assign-patients \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"categories": ["diabetes", "heart_disease"]}'

# 3) Start campaign
curl -X POST http://localhost:4000/campaigns/1/start \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"callMode": "websocket"}'
```

#### 5. Copy Patient URLs and Simulate Patient Phones

**IMPORTANT:** This is how you simulate real patient phones and have actual conversations with the AI agent.

**Via Frontend (Recommended):**

1. **After starting campaign**, the campaign details modal opens automatically
2. **You'll see a table** with columns:
   - Patient Name
   - Phone Number
   - Status (queued, ringing, calling, completed, missed, rejected)
   - Patient Call URL (with copy and open buttons)

3. **Copy or open patient URLs:**
   - Click 📋 to copy a specific patient URL
   - Click 🔗 to open a specific patient URL in new tab
   - OR click "🚀 Open All Patient Phones" to open all at once

4. **Each URL represents a patient's phone:**
   - Open URLs in separate browser tabs/windows
   - Each tab is like a patient's mobile phone
   - Keep tabs open and visible

5. **AI calls patients one by one:**
   - System processes calls sequentially
   - When AI calls a patient, that tab shows "Incoming Call"
   - Patient status changes: queued → ringing → calling
   - 30-second ring timeout per patient

6. **Three possible actions:**
   
   **A. Accept Call:**
   - Click "Accept" button to answer
   - AI agent speaks first (you'll see and hear the opening prompt)
   - Click microphone button and speak your response
   - System waits for speech silence (~800ms) before sending to LLM
   - AI processes your speech (STT → LLM → TTS)
   - AI responds with speech
   - Continue natural conversation
   - Click "End Call" when done
   - Status: "completed"
   - Full transcript saved
   - AI post-call analysis runs automatically (deterministic JSON)
   - If emergency symptoms are mentioned, call is escalated immediately
   
   **B. Miss Call (Don't Answer):**
   - Don't click anything for 30 seconds
   - Call times out automatically
   - Status: "missed"
   - NO automatic retry
   - System moves to next patient immediately
   
   **C. Reject Call:**
   - Click "Decline" button
   - Status: "rejected"
   - NO automatic retry
   - System moves to next patient immediately

7. **View results:**
   - After call ends, see full transcript
   - View AI analysis (sentiment, risk level, summary)
   - Check dashboard for updated statistics

**Call Flow:**
```
Campaign Started → Campaign Details Modal Opens → Patient URLs Shown
     ↓
Copy/Open Patient URLs → Tabs Represent Patient Phones
     ↓
AI Calls First Patient → "Incoming Call" Screen (30s timeout) → Accept/Reject/Miss
     ↓
[IF ACCEPT] AI Speaks (TTS) → Patient Speaks (STT) → AI Processes (LLM) → AI Responds (TTS)
     ↓
Natural Conversation Loop → End Call → Transcript Saved → Analysis Generated
     ↓
[IF MISS/REJECT] Status Updated → NO RETRY → Next Patient Called
     ↓
AI Calls Next Patient → Repeat Process
```

**Call Behavior:**
- AI calls patients ONE BY ONE (sequential, not parallel)
- Incoming call expires in 30 seconds if not accepted
- Missed calls marked as "missed" - NO RETRY
- Rejected calls marked as "rejected" - NO RETRY
- Each conversation uses server-generated TTS audio (production mode)
- Full transcript and analysis saved after each call
- Campaign completes when all patients are processed (completed/missed/rejected)

**Tips for Testing:**
- Open patient URLs in different browser windows side-by-side
- Use incognito/private windows to simulate different devices
- Speak clearly into your microphone
- Test various scenarios: confirmations, concerns, emergency phrases
- Try accepting, rejecting, and missing calls
- Watch patient status update in real-time in campaign details
- Best tested with 2 devices (one for hospital dashboard, one for patient phone)

#### 6. Monitor Campaign Progress

**Via Frontend:**
1. Dashboard shows real-time stats
2. View call states: Completed, In Progress, Failed
3. Check sentiment breakdown
4. Review risk and follow-up indicators

**Via API:**
```bash
curl http://localhost:4000/stats?campaignId=1 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "totalCalls": 100,
  "completed": 85,
  "requiresFollowup": 12,
  "failed": 3,
  "inProgress": 0,
  "confirmedAppointments": 78,
  "sentimentBreakdown": {
    "positive": 78,
    "neutral": 15,
    "negative": 7
  },
  "barriers": {}
}
```

#### 7. View Call Details

**Via Frontend:**
1. Click on any call in the list
2. View full transcript
3. See structured analysis
4. Check sentiment and risk indicators

**Via API:**
```bash
curl http://localhost:4000/calls/1 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "call": {
    "id": 1,
    "patient_name": "John Smith",
    "state": "completed",
    "transcript": "Assistant: Hello John Smith...\nPatient: Yes, I can confirm...",
    "structured_output": {
      "summary": "Patient confirmed the appointment and denied urgent symptoms.",
      "campaign_goal_achieved": true,
      "appointment_confirmed": true,
      "confirmed_date": "2026-03-15",
      "confirmed_time": null,
      "sentiment": "positive",
      "risk_level": "low",
      "risk_flags": [],
      "requires_manual_followup": false,
      "followup_reason": null,
      "priority": "low",
      "requested_callback": false,
      "requires_followup": false
    },
    "sentiment": "positive",
    "duration": 45
  }
}
```

---

## Care Coordinator

### Role: Manage Follow-Ups and Patient Escalations

#### 1. View Follow-Up Queue

**Via Frontend:**
1. Click "Follow-Ups" in navigation
2. See list of patients requiring follow-up
3. Filter by priority (High, Medium, Low)
4. Review risk level and risk flags

**Via API:**
```bash
# All follow-ups
curl "http://localhost:4000/calls?state=requires_followup" \
  -H "Authorization: Bearer YOUR_TOKEN"

# High priority only
curl "http://localhost:4000/calls?state=requires_followup&priority=high" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "calls": [
    {
      "id": 2,
      "patient_name": "Maria Garcia",
      "phone": "555-0102",
      "state": "requires_followup",
      "structured_output": {
        "risk_level": "high",
        "risk_flags": ["chest pain", "shortness of breath"],
        "priority": "high",
        "summary": "Patient reported severe symptoms; emergency escalation guidance delivered.",
        "requires_manual_followup": true,
        "followup_reason": "Emergency keywords detected during call.",
        "requires_followup": true
      },
      "created_at": "2026-03-01T09:15:00Z"
    }
  ],
  "total": 12
}
```

#### 2. Review Risk & Follow-Up Signals

**Risk Signals:**
- **High**: Emergency language or severe symptom mentions
- **Medium**: Concerning symptoms or unclear safety statements
- **Low**: No urgent risk indicators

**Priority Levels:**
- **High**: Urgent attention needed, severe risk indicators
- **Medium**: Important but not urgent
- **Low**: Minor concerns, routine follow-up

#### 3. Take Action

**Actions Available:**
1. **Call Patient**: Use phone number to make personal call
2. **Schedule Callback**: Set reminder for follow-up
3. **Assign to Team Member**: Delegate to specialist
4. **Mark Resolved**: Close follow-up after resolution
5. **Add Notes**: Document actions taken

#### 4. View Call History

**Via API:**
```bash
# Get call details with full context
curl http://localhost:4000/calls/2 \
  -H "Authorization: Bearer YOUR_TOKEN"

# Get event timeline
curl http://localhost:4000/admin/calls/2/events \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Event Timeline Shows:**
- When call started
- What was transcribed
- AI responses generated
- When escalation occurred
- Analysis completion

---

## QA Tester

### Role: Test System Functionality

#### 1. Test Authentication

```bash
# Register new user
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"qa@test.com","password":"test123"}'

# Login
curl -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"qa@test.com","password":"test123"}'
```

**Expected:** Token returned with organizationId

#### 2. Test Campaign Flow

```bash
# 1. Create campaign
curl -X POST http://localhost:4000/campaigns \
  -H "Authorization: Bearer TOKEN" \
  -d '{"name":"QA Test Campaign"}'

# 2. Assign centralized patients by category
curl -X POST http://localhost:4000/campaigns/1/assign-patients \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"categories":["diabetes"]}'

# 3. (Optional) Upload CSV directly to campaign (legacy mode)
curl -X POST http://localhost:4000/campaigns/1/patients \
  -H "Authorization: Bearer TOKEN" \
  -F "file=@sample_patients.csv"

# 4. Start campaign (live websocket mode for real voice call testing)
curl -X POST http://localhost:4000/campaigns/1/start \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"callMode":"websocket"}'

# 5. Open returned mobile call link and accept incoming call
# 6. Check results after call ends
curl http://localhost:4000/calls?campaignId=1 \
  -H "Authorization: Bearer TOKEN"
```

**Expected:** Live call transitions (`queued/ringing/calling/completed`) with transcript and analysis after call end.

#### 3. Test State Transitions

```bash
# Check call states
curl http://localhost:4000/calls \
  -H "Authorization: Bearer TOKEN"
```

**Expected States:**
- `scheduled` - Initial state
- `queued` - In Redis queue
- `ringing` - Incoming call sent to patient tab (WebSocket mode)
- `in_progress` - Being processed
- `completed` - Successfully finished
- `requires_followup` - Needs follow-up
- `missed` - Not accepted within timeout (patient status)
- `failed` - Processing failed

#### 4. Test Event System

```bash
# Get event timeline for a call
curl http://localhost:4000/admin/calls/1/events \
  -H "Authorization: Bearer TOKEN"
```

**Expected Events:**
- `call.queued`
- `call.ringing`
- `call.started`
- `call.transcribed` (multiple)
- `call.response.generated` (multiple)
- `call.analysis.completed`
- `call.completed`
- `call.retry.scheduled` (when no-answer/retry happens)

#### 5. Test Admin Tools

```bash
# Queue health
curl http://localhost:4000/admin/queue/health \
  -H "Authorization: Bearer TOKEN"

# Failed calls
curl http://localhost:4000/admin/calls/failed \
  -H "Authorization: Bearer TOKEN"

# Dead letter queue
curl http://localhost:4000/admin/dead-letter-queue \
  -H "Authorization: Bearer TOKEN"
```

#### 6. Test Multi-Tenant Isolation

```bash
# Register two different organizations
curl -X POST http://localhost:4000/auth/register \
  -d '{"email":"org1@test.com","password":"test123","organizationName":"Org 1"}'

curl -X POST http://localhost:4000/auth/register \
  -d '{"email":"org2@test.com","password":"test123","organizationName":"Org 2"}'

# Create campaigns for each
# Verify Org 1 cannot see Org 2's data
```

**Expected:** Complete data isolation between organizations

#### 7. Run Automated Verification

```bash
# Default: API/worker automation path (simulation mode)
./verify.sh

# Optional: websocket-mode verification (manual call acceptance required)
VERIFY_CALL_MODE=websocket ./verify.sh
```

**Expected:**  
- `./verify.sh` validates full automated stack via simulation mode.
- `VERIFY_CALL_MODE=websocket ./verify.sh` validates live queue/ringing path and requires manual call acceptance for transcript/analysis assertions.

---

## System Administrator

### Role: Monitor and Maintain System

#### 1. Check System Health

```bash
# Check all services
docker compose ps

# Check backend health
curl http://localhost:4000/health

# Check database
docker exec healthcare_db pg_isready

# Check Redis
docker exec healthcare_redis redis-cli PING

# Check Ollama
curl http://localhost:11434/api/tags
```

#### 2. Monitor Logs

```bash
# All services
docker compose logs -f

# Specific service
docker logs -f healthcare_backend
docker logs -f healthcare_worker

# Last 100 lines
docker logs --tail 100 healthcare_worker
```

#### 3. Monitor Queue

```bash
# Queue health via API
curl http://localhost:4000/admin/queue/health \
  -H "Authorization: Bearer TOKEN"

# Direct Redis check
docker exec healthcare_redis redis-cli LLEN "bull:calls:wait"
docker exec healthcare_redis redis-cli LLEN "bull:calls:active"
docker exec healthcare_redis redis-cli LLEN "bull:calls:completed"
docker exec healthcare_redis redis-cli LLEN "bull:calls:failed"
```

#### 4. Database Management

```bash
# Connect to database
docker exec -it healthcare_db psql -U postgres -d healthcare

# Check tables
\dt

# Check call states
SELECT state, COUNT(*) FROM calls GROUP BY state;

# Check events
SELECT event_type, COUNT(*) FROM events GROUP BY event_type;

# Check recent calls
SELECT id, patient_id, state, created_at FROM calls ORDER BY created_at DESC LIMIT 10;

# Exit
\q
```

#### 5. Scale Workers

```bash
# Scale to 3 workers
docker compose up --scale worker=3 -d

# Check worker instances
docker ps | grep worker
```

#### 6. Restart Services

```bash
# Restart specific service
docker compose restart backend
docker compose restart worker

# Restart all
docker compose restart

# Full restart with rebuild
docker compose down
docker compose up -d --build
```

#### 7. Clean Up

```bash
# Stop all services
docker compose down

# Remove volumes (deletes data)
docker compose down -v

# Remove images
docker compose down --rmi all
```

#### 8. Backup Database

```bash
# Backup
docker exec healthcare_db pg_dump -U postgres healthcare > backup.sql

# Restore
cat backup.sql | docker exec -i healthcare_db psql -U postgres healthcare
```

#### 9. Monitor Performance

```bash
# Resource usage
docker stats

# Specific service
docker stats healthcare_worker

# Database connections
docker exec healthcare_db psql -U postgres -d healthcare -c "SELECT * FROM pg_stat_activity;"
```

#### 10. Handle Failed Calls

```bash
# View failed calls
curl http://localhost:4000/admin/calls/failed \
  -H "Authorization: Bearer TOKEN"

# Retry specific call
curl -X POST http://localhost:4000/admin/calls/2/retry \
  -H "Authorization: Bearer TOKEN"

# View dead letter queue
curl http://localhost:4000/admin/dead-letter-queue \
  -H "Authorization: Bearer TOKEN"
```

---

## API Reference

### Authentication Endpoints

```
POST /auth/register
POST /auth/login
```

### Campaign Endpoints

```
GET    /campaigns              - List campaigns
POST   /campaigns              - Create campaign
GET    /campaigns/:id          - Get campaign details
DELETE /campaigns/:id          - Delete campaign and related campaign data
POST   /campaigns/:id/assign-patients - Assign patients by category
POST   /campaigns/:id/patients - Upload patients (optional/legacy)
POST   /campaigns/:id/start    - Start campaign (recommended body: {"callMode":"websocket"} for live calls)
```

### Patient Public Endpoint

```
GET /patients/public/:id       - Public patient profile for mobile-call link
```

### Call Endpoints

```
GET /calls           - List calls (filters: state, campaignId, limit, offset)
GET /calls/:id       - Get call details
```

### Statistics Endpoints

```
GET /stats?campaignId=X  - Dashboard statistics
```

### Admin Endpoints

```
GET  /admin/queue/health           - Queue health
GET  /admin/calls/failed           - Failed calls
POST /admin/calls/:id/retry        - Retry call
GET  /admin/agent-config/:id       - Get config
PUT  /admin/agent-config/:id       - Update config
GET  /admin/dead-letter-queue      - View DLQ
GET  /admin/calls/:id/events       - Event timeline
```

### Request Headers

All authenticated requests require:
```
Authorization: Bearer YOUR_JWT_TOKEN
Content-Type: application/json
```

---

## Troubleshooting

### Issue: Cannot login

**Solution:**
```bash
# Check backend is running
curl http://localhost:4000/health

# Check database
docker exec healthcare_db pg_isready

# Restart backend
docker compose restart backend
```

### Issue: Campaign not starting

**Solution:**
```bash
# Check Redis
docker exec healthcare_redis redis-cli PING

# Check worker is running
docker logs healthcare_worker

# Restart worker
docker compose restart worker
```

### Issue: Calls not processing

**Solution:**
```bash
# Check worker logs
docker logs -f healthcare_worker

# Check queue
docker exec healthcare_redis redis-cli KEYS "*"

# Check Ollama
curl http://localhost:11434/api/tags

# Restart worker (Ollama runs on host by default)
docker compose restart worker
# Host Ollama restart (if needed)
# pkill ollama && ollama serve
```

### Issue: No transcripts

**Solution:**
```bash
# Check Whisper container
docker ps | grep whisper

# Verify Whisper HTTP endpoint
docker exec healthcare_whisper curl -sf http://localhost:9000/ >/dev/null && echo "whisper ok"

# Check backend STT logs (live calls)
docker logs healthcare_backend | grep -i "STT"

# Check worker logs for STT errors (batch/simulated calls)
docker logs healthcare_worker | grep -i "STT"

# Restart STT + backend path
docker compose restart whisper backend worker
```

### Issue: Slow responses

**Solution:**
```bash
# Check resource usage
docker stats

# Check Ollama model
ollama list

# Scale workers
docker compose up --scale worker=3 -d
```

### Issue: Database errors

**Solution:**
```bash
# Check database
docker exec healthcare_db pg_isready

# Check connections
docker exec healthcare_db psql -U postgres -d healthcare -c "SELECT COUNT(*) FROM pg_stat_activity;"

# Restart database
docker compose restart postgres
```

### Full System Reset

```bash
# Stop everything
docker compose down -v

# Start fresh
docker compose up -d

# Pull configured Ollama models from .env
source .env
ollama pull "$LLM_MODEL"
ollama pull "$LLM_MODEL_CHAT"
ollama pull "$LLM_MODEL_ANALYSIS"
ollama pull "$LLM_MODEL_DECISION"

# Wait for services
sleep 60

# Verify
./verify.sh

# Optional websocket-mode verification
VERIFY_CALL_MODE=websocket ./verify.sh
```

---

## Testing & Verification

### Quick Test (Complete Flow in 6 Minutes)

**Objective:** Test accept, miss, and reject scenarios with real voice conversations.

**Step 1: Create Campaign (2 minutes)**
1. Login: http://localhost:3000 (admin@demo.com / admin123)
2. Go to "Campaigns" tab
3. Click "+ Create Campaign"
4. Fill in:
   - Name: "Quick Test Campaign"
   - Opening Prompt: "Hello, I'm calling from City General Hospital to confirm your appointment."
   - Patient Groups: ☑️ Diabetes, ☑️ Heart Disease, ☑️ Asthma
   - Select: "Start Now (begins in 1 minute)"
5. Click "Create & Schedule"

**Step 2: Open Patient URLs (1 minute)**
1. Campaign details modal opens with patient URLs
2. Click "🚀 Open All Patient Phones"
3. Three tabs open (one per patient)

**Step 3: Wait & Test (2 minutes)**
- Wait 1 minute for campaign to start
- First patient (John Smith) gets call
- **ACCEPT** the call, have 2-3 exchanges, end call
- Second patient (Sarah Johnson) gets call
- **MISS** the call (don't answer for 30 seconds)
- Third patient (Michael Brown) gets call
- **REJECT** the call (click Decline)

**Step 4: Verify Results (1 minute)**
1. Go back to dashboard
2. Check campaign details:
   - John: status "completed", full transcript
   - Sarah: status "missed"
   - Michael: status "rejected"
3. Campaign status: "completed"

**Expected Results:**
- ✅ All 3 patients processed sequentially
- ✅ John's call has full transcript and AI analysis
- ✅ Sarah and Michael marked as missed/rejected
- ✅ No retries attempted
- ✅ Campaign completed

### Test Scenarios

#### Scenario 1: Accept Call & Complete Conversation

**Purpose:** Test full conversation flow with real voice.

**Steps:**
1. Create & schedule campaign with 1 patient (single modal flow)
2. Open patient URL
3. Wait for "Incoming Call"
4. Click "Accept"
5. Have natural conversation:
   - AI: "Hello, I'm calling to confirm your appointment..."
   - You: "Yes, I can confirm my appointment."
   - AI: "Great! Is the time still convenient for you?"
   - You: "Yes, that works for me."
   - AI: "Perfect. We'll see you then. Have a great day!"
6. Click "End Call"

**Verify:**
- ✅ Full transcript saved
- ✅ Sentiment: "positive"
- ✅ Appointment confirmed: true
- ✅ Summary generated
- ✅ Patient status: "completed"

#### Scenario 2: Miss Call (No Answer)

**Purpose:** Test timeout behavior.

**Steps:**
1. Create & schedule campaign with 1 patient (single modal flow)
2. Open patient URL
3. Wait for "Incoming Call"
4. DO NOTHING for 30 seconds
5. Watch countdown timer

**Verify:**
- ✅ Call times out after 30 seconds
- ✅ Patient status: "missed"
- ✅ Call record created with "No answer"
- ✅ No retry attempted
- ✅ Campaign completes immediately

#### Scenario 3: Reject Call

**Purpose:** Test rejection handling.

**Steps:**
1. Create & schedule campaign with 1 patient (single modal flow)
2. Open patient URL
3. Wait for "Incoming Call"
4. Click "Decline" button

**Verify:**
- ✅ Call rejected immediately
- ✅ Patient status: "rejected"
- ✅ Call record created with "Call declined"
- ✅ No retry attempted
- ✅ Campaign completes immediately

#### Scenario 4: Schedule for Later

**Purpose:** Test scheduled campaigns.

**Steps:**
1. Create campaign from the modal
2. Select "Schedule for Later"
3. Pick time 2 minutes in future
4. Select patient groups in the same modal
5. Click "Create & Schedule"
6. Wait for scheduled time

**Verify:**
- ✅ Campaign status: "scheduled"
- ✅ Calls start at exact scheduled time
- ✅ Patient URLs work when calls start

### Verification Commands

**Check Campaign Status:**
```bash
docker exec healthcare_db psql -U postgres -d healthcare -c \
  "SELECT id, name, status, schedule_time FROM campaigns ORDER BY id DESC LIMIT 1;"
```

**Check Patient Statuses:**
```bash
docker exec healthcare_db psql -U postgres -d healthcare -c \
  "SELECT name, status FROM patients WHERE campaign_id = 1;"
```

**Check Call Records:**
```bash
docker exec healthcare_db psql -U postgres -d healthcare -c \
  "SELECT id, patient_id, state, sentiment, duration FROM calls ORDER BY id DESC LIMIT 5;"
```

**Check Call Transcript:**
```bash
docker exec healthcare_db psql -U postgres -d healthcare -c \
  "SELECT transcript, summary FROM calls WHERE id = 1;"
```

**Check Post-Call Analysis:**
```bash
docker exec healthcare_db psql -U postgres -d healthcare -c \
  "SELECT structured_output, sentiment, appointment_confirmed FROM calls WHERE id = 1;"
```

### Troubleshooting

**Issue: No Incoming Call After 5 Minutes**

Check worker logs:
```bash
docker logs healthcare_worker --tail 50
```

Check Redis queue:
```bash
docker exec healthcare_redis redis-cli LLEN "bull:calls:wait"
docker exec healthcare_redis redis-cli ZCARD "bull:calls:delayed"
```

Solution:
- Verify campaign schedule_time is correct
- Check worker is processing jobs
- Restart worker: `docker compose restart worker`

**Issue: Microphone Not Working**

Check:
- Browser permissions (allow microphone)
- HTTPS required (or localhost)
- Browser console for errors

Solution:
- Grant microphone permission
- Use Chrome/Firefox
- Check microphone not used by another app

**Issue: No AI Response**

Check Ollama:
```bash
curl http://localhost:11434/api/tags
docker logs healthcare_worker --tail 50
```

Solution:
- Verify Ollama running: `ollama serve`
- Check configured model(s) are loaded: `ollama list`
- Restart worker: `docker compose restart worker`

**Issue: Post-Call Analysis Not Completing**

Check:
```bash
docker logs healthcare_backend --tail 50
docker logs healthcare_worker | grep "LLM:"
```

Solution:
- Verify Ollama accessible
- Analysis runs asynchronously (10-30 seconds)
- Check LLM service logs

---

## Best Practices

### For Hospital Staff
- Keep patient data CSV clean and consistent
- Include all relevant metadata fields
- Verify phone numbers are correct
- Test with small batch first

### For Campaign Managers
- Write clear, natural script templates
- Configure agent behavior appropriately
- Monitor campaigns regularly
- Review results and adjust

### For Care Coordinators
- Check follow-up queue daily
- Prioritize high-priority cases
- Document all actions taken
- Close resolved cases promptly

### For QA Testers
- Test all workflow phases
- Verify multi-tenant isolation
- Check event persistence
- Test failure scenarios

### For System Administrators
- Monitor logs regularly
- Check queue health
- Scale workers as needed
- Backup database regularly
- Keep system updated

---

## Support

For issues or questions:
1. Check this guide
2. Review README.md
3. Run `./verify.sh` (or `VERIFY_CALL_MODE=websocket ./verify.sh`)
4. Check service logs
5. Review troubleshooting section

---

**System Version:** 1.0.0
**Last Updated:** 2026-02-28
**Status:** Production-Ready ✅

## Current System Status

**All Services Running:**
- ✅ Frontend (http://localhost:3000)
- ✅ Backend API (http://localhost:4000)
- ✅ PostgreSQL Database (healthy)
- ✅ Redis Queue (healthy)
- ✅ Worker Process (ready)
- ✅ Whisper STT Service (running)
- ✅ Coqui TTS Service (running)
- ✅ Ollama LLM (configured model(s) loaded from `.env`)

**Sample Data Available:**
- 3 test patients (John Smith, Sarah Johnson, Michael Brown)
- Categories: Diabetes, Heart Disease, Asthma
- Ready for campaign creation and testing

**Latest Updates (2026-02-27):**
- ✅ Campaign creation with "Start Now" (5 min) or "Schedule Later" options
- ✅ NO automatic retries - missed/rejected calls marked immediately
- ✅ Sequential patient processing (one at a time)
- ✅ 30-second ring timeout per patient
- ✅ Real-time status updates (completed/missed/rejected)
- ✅ Full transcript capture and AI analysis
- ✅ Campaign completes when all patients processed

**System Ready For:**
1. Login and authentication testing
2. Campaign creation with flexible scheduling
3. Patient assignment by category
4. Real-time voice conversations (WebSocket mode)
5. Accept/Miss/Reject call scenarios
6. Full end-to-end call flow testing
7. Transcript analysis and sentiment detection
8. Dashboard statistics and reporting

**Performance Metrics:**
- Call Start Delay: 1 minute (Start Now) or scheduled time
- Ring Timeout: 30 seconds per patient
- Between Calls: 15 seconds spacing
- STT Processing: 1-3 seconds per audio chunk
- LLM Response: 2-5 seconds per turn
- TTS Generation: 1-2 seconds per response
- Post-Call Analysis: 10-30 seconds after call ends

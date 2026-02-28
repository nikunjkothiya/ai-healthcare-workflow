-- Healthcare AI Voice Agent Database Schema

-- Organizations table for multi-tenant support
CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'hospital_admin', -- 'product_admin' or 'hospital_admin'
    full_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    script_template TEXT,
    schedule_time TIMESTAMP,
    retry_limit INTEGER DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS patients (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    category VARCHAR(50),
    status VARCHAR(50) DEFAULT 'active',
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS calls (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    transcript TEXT,
    structured_output JSONB,
    sentiment VARCHAR(50),
    appointment_confirmed BOOLEAN DEFAULT FALSE,
    requested_callback BOOLEAN DEFAULT FALSE,
    summary TEXT,
    duration INTEGER,
    state VARCHAR(50) DEFAULT 'scheduled',
    state_metadata JSONB,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    call_id INTEGER REFERENCES calls(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_configs (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    max_turns INTEGER DEFAULT 5,
    greeting_script TEXT,
    prompt_template TEXT,
    end_keywords TEXT[],
    followup_keywords TEXT[],
    confirmation_keywords TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    call_id INTEGER REFERENCES calls(id) ON DELETE CASCADE,
    error_message TEXT,
    error_stack TEXT,
    retry_count INTEGER,
    payload JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_organization_id ON users(organization_id);
CREATE INDEX idx_campaigns_organization_id ON campaigns(organization_id);
CREATE INDEX idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX idx_patients_organization_id ON patients(organization_id);
CREATE INDEX idx_patients_campaign_id ON patients(campaign_id);
CREATE INDEX idx_patients_category ON patients(category);
CREATE INDEX idx_patients_status ON patients(status);
CREATE INDEX idx_calls_organization_id ON calls(organization_id);
CREATE INDEX idx_calls_patient_id ON calls(patient_id);
CREATE INDEX idx_calls_campaign_id ON calls(campaign_id);
CREATE INDEX idx_calls_sentiment ON calls(sentiment);
CREATE INDEX idx_calls_created_at ON calls(created_at);
CREATE INDEX idx_calls_state ON calls(state);
CREATE INDEX idx_calls_state_campaign ON calls(state, campaign_id); -- Composite index for dashboard queries
CREATE INDEX idx_events_organization_id ON events(organization_id);
CREATE INDEX idx_events_call_id ON events(call_id);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_dead_letter_organization_id ON dead_letter_queue(organization_id);
CREATE INDEX idx_dead_letter_call_id ON dead_letter_queue(call_id);

-- ============================================
-- SEED DATA (Minimal for Demo)
-- ============================================

-- 1. Insert one organization
INSERT INTO organizations (name) 
VALUES ('Demo Healthcare')
ON CONFLICT DO NOTHING;

-- 2. Insert Product Admin (password: admin123)
-- Can manage all hospitals and view system analytics
INSERT INTO users (organization_id, email, password_hash, role, full_name) 
VALUES (
    NULL,  -- Product admin has no specific organization
    'productadmin@healthcare.com', 
    '$2b$10$fAhWw1nlSOR3ZETFMLv34exC7AuH1/Y8KL0vwV0Z.K9fgXqhtqKaa',
    'product_admin',
    'Product Administrator'
)
ON CONFLICT (email) DO NOTHING;

-- 3. Insert Hospital Admin (password: admin123)
INSERT INTO users (organization_id, email, password_hash, role, full_name) 
VALUES (
    (SELECT id FROM organizations WHERE name = 'Demo Healthcare' LIMIT 1),
    'admin@demo.com', 
    '$2b$10$fAhWw1nlSOR3ZETFMLv34exC7AuH1/Y8KL0vwV0Z.K9fgXqhtqKaa',
    'hospital_admin',
    'Hospital Admin'
)
ON CONFLICT (email) DO NOTHING;

-- 4. Insert 3 sample patients
INSERT INTO patients (organization_id, name, phone, category, status, metadata)
VALUES 
(
    (SELECT id FROM organizations WHERE name = 'Demo Healthcare' LIMIT 1),
    'John Smith',
    '555-0101',
    'diabetes',
    'active',
    '{"age": 65, "medical_condition": "Type 2 Diabetes", "appointment_date": "2026-03-15", "doctor": "Dr. Wilson"}'::jsonb
),
(
    (SELECT id FROM organizations WHERE name = 'Demo Healthcare' LIMIT 1),
    'Sarah Johnson',
    '555-0102',
    'heart_disease',
    'active',
    '{"age": 58, "medical_condition": "Hypertension", "appointment_date": "2026-03-16", "doctor": "Dr. Chen"}'::jsonb
),
(
    (SELECT id FROM organizations WHERE name = 'Demo Healthcare' LIMIT 1),
    'Michael Brown',
    '555-0103',
    'asthma',
    'active',
    '{"age": 42, "medical_condition": "Chronic Asthma", "appointment_date": "2026-03-17", "doctor": "Dr. Patel"}'::jsonb
)
ON CONFLICT DO NOTHING;


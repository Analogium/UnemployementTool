-- ============================================================
-- LinkedIn Auto Apply - Schéma PostgreSQL
-- À exécuter via : docker exec postgres psql -U postgres -f /tmp/schema.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS linkedin_jobs;

\c linkedin_jobs;

-- Table des offres d'emploi scrappées
CREATE TABLE IF NOT EXISTS jobs (
    id                  SERIAL PRIMARY KEY,
    linkedin_job_id     VARCHAR(50) UNIQUE NOT NULL,
    title               VARCHAR(255) NOT NULL,
    company             VARCHAR(255),
    location            VARCHAR(255),
    remote_type         VARCHAR(50),         -- 'remote', 'hybrid', 'onsite'
    contract_type       VARCHAR(50),         -- 'CDI', 'CDD', 'freelance', etc.
    description         TEXT,
    skills_required     TEXT[],              -- technologies mentionnées
    job_url             VARCHAR(500),
    apply_type          VARCHAR(20),         -- 'easy_apply' ou 'external'
    external_apply_url  VARCHAR(500),
    language            VARCHAR(10) DEFAULT 'fr',  -- 'fr' ou 'en'
    salary_info         VARCHAR(255),
    status              VARCHAR(30) DEFAULT 'pending',
    -- pending → processing → applied / skipped / failed
    scraped_at          TIMESTAMP DEFAULT NOW(),
    processed_at        TIMESTAMP
);

-- Table des candidatures envoyées
CREATE TABLE IF NOT EXISTS applications (
    id                  SERIAL PRIMARY KEY,
    job_id              INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    applied_at          TIMESTAMP DEFAULT NOW(),
    status              VARCHAR(30) DEFAULT 'sent',
    -- sent / confirmed / rejected / interview / error
    cv_language         VARCHAR(10),         -- 'fr' ou 'en'
    adapted_resume      TEXT,               -- le résumé CV adapté par Claude
    cover_note          TEXT,               -- lettre courte générée
    error_message       TEXT,               -- si échec
    screenshot_path     VARCHAR(500)        -- screenshot de confirmation
);

-- Index pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scraped_at ON jobs(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_linkedin_id ON jobs(linkedin_job_id);
CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_applied_at ON applications(applied_at DESC);

-- Vue pratique pour le suivi
CREATE OR REPLACE VIEW application_summary AS
SELECT
    j.title,
    j.company,
    j.location,
    j.apply_type,
    j.language,
    j.status AS job_status,
    a.status AS application_status,
    a.applied_at,
    a.error_message,
    j.job_url
FROM jobs j
LEFT JOIN applications a ON a.job_id = j.id
ORDER BY a.applied_at DESC NULLS LAST;

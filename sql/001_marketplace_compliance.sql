-- PIKI Marketplace: KYC/KYB + Stripe Connect
-- PostgreSQL 15+
-- Esta migración es el modelo relacional canónico para compliance y cuentas conectadas.
-- No ejecuta transferencias ni crea cuentas Stripe por sí misma.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE compliance_case_status AS ENUM (
  'pending', 'in_review', 'verified', 'rejected', 'expired', 'suspended'
);
CREATE TYPE document_status AS ENUM ('received', 'in_review', 'approved', 'rejected', 'expired');
CREATE TYPE document_source AS ENUM ('partner_upload', 'admin_upload', 'stripe', 'system');
CREATE TYPE stripe_account_status AS ENUM (
  'not_created', 'onboarding', 'pending_verification', 'verified', 'restricted', 'disabled'
);
CREATE TYPE stripe_requirement_state AS ENUM ('currently_due', 'eventually_due', 'past_due', 'pending_verification');
CREATE TYPE capability_status AS ENUM ('unrequested', 'pending', 'active', 'inactive');
CREATE TYPE payout_hold_status AS ENUM ('active', 'released');
CREATE TYPE compliance_actor_type AS ENUM ('partner', 'admin', 'finance', 'stripe_webhook', 'system');

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Relación legal/fiscal del restaurante. restaurant_id referencia el identificador
-- del servicio de restaurantes de PIKI; se mantiene como UUID para desacoplar el SQL.
CREATE TABLE partner_legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL UNIQUE,
  tenant_id uuid,
  country_code char(2) NOT NULL DEFAULT 'ES' CHECK (country_code = upper(country_code)),
  legal_entity_type text NOT NULL CHECK (legal_entity_type IN ('individual', 'company')),
  business_structure text,
  legal_name text NOT NULL,
  trading_name text NOT NULL,
  tax_id text NOT NULL,
  tax_id_last4 char(4),
  fiscal_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  operating_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  postal_code text,
  city text,
  province text,
  phone text,
  support_email text,
  activity_code text,
  vat_rate numeric(5,2) CHECK (vat_rate >= 0 AND vat_rate <= 100),
  bank_account_holder text,
  iban_last4 char(4),
  iban_fingerprint text,
  piki_status compliance_case_status NOT NULL DEFAULT 'pending',
  piki_rejection_reason text,
  contract_version text,
  contract_accepted_at timestamptz,
  privacy_accepted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (legal_entity_type <> 'company' OR business_structure IS NOT NULL),
  CHECK (char_length(tax_id) >= 4)
);
CREATE INDEX partner_legal_entities_tenant_status_idx ON partner_legal_entities (tenant_id, piki_status);
CREATE INDEX partner_legal_entities_tax_id_idx ON partner_legal_entities (tax_id);
CREATE TRIGGER partner_legal_entities_updated_at BEFORE UPDATE ON partner_legal_entities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE partner_representatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES partner_legal_entities(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text,
  role_title text NOT NULL,
  tax_id_last4 char(4),
  date_of_birth date,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_primary boolean NOT NULL DEFAULT false,
  identity_status compliance_case_status NOT NULL DEFAULT 'pending',
  identity_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_representatives_primary_idx ON partner_representatives (legal_entity_id) WHERE is_primary;
CREATE INDEX partner_representatives_entity_idx ON partner_representatives (legal_entity_id);
CREATE TRIGGER partner_representatives_updated_at BEFORE UPDATE ON partner_representatives FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE beneficial_owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES partner_legal_entities(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text,
  tax_id_last4 char(4),
  date_of_birth date,
  ownership_percent numeric(5,2) CHECK (ownership_percent IS NULL OR (ownership_percent >= 0 AND ownership_percent <= 100)),
  control_basis text,
  identity_status compliance_case_status NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX beneficial_owners_entity_idx ON beneficial_owners (legal_entity_id);
CREATE TRIGGER beneficial_owners_updated_at BEFORE UPDATE ON beneficial_owners FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE compliance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES partner_legal_entities(id) ON DELETE CASCADE,
  representative_id uuid REFERENCES partner_representatives(id) ON DELETE SET NULL,
  beneficial_owner_id uuid REFERENCES beneficial_owners(id) ON DELETE SET NULL,
  document_type text NOT NULL,
  source document_source NOT NULL,
  status document_status NOT NULL DEFAULT 'received',
  file_name text NOT NULL,
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  expires_at timestamptz,
  viewed_at timestamptz,
  viewed_by uuid,
  reviewed_at timestamptz,
  reviewed_by uuid,
  review_notes text,
  rejection_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((representative_id IS NULL) OR (beneficial_owner_id IS NULL)),
  UNIQUE (legal_entity_id, document_type, version)
);
CREATE INDEX compliance_documents_review_idx ON compliance_documents (legal_entity_id, status, document_type);
CREATE INDEX compliance_documents_expiry_idx ON compliance_documents (expires_at) WHERE expires_at IS NOT NULL;
CREATE TRIGGER compliance_documents_updated_at BEFORE UPDATE ON compliance_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stripe_connected_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL UNIQUE REFERENCES partner_legal_entities(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL UNIQUE,
  account_type text NOT NULL CHECK (account_type IN ('express', 'custom', 'standard')),
  country_code char(2) NOT NULL DEFAULT 'ES',
  business_type text NOT NULL CHECK (business_type IN ('individual', 'company', 'non_profit', 'government_entity')),
  dashboard_type text,
  tos_type text,
  requirement_collection text CHECK (requirement_collection IN ('stripe', 'application')),
  status stripe_account_status NOT NULL DEFAULT 'onboarding',
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  controller_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_created_at timestamptz,
  last_synced_at timestamptz,
  last_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_connected_accounts_status_idx ON stripe_connected_accounts (status, payouts_enabled, charges_enabled);
CREATE TRIGGER stripe_connected_accounts_updated_at BEFORE UPDATE ON stripe_connected_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stripe_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id uuid NOT NULL REFERENCES stripe_connected_accounts(id) ON DELETE CASCADE,
  capability_name text NOT NULL CHECK (capability_name IN ('card_payments', 'transfers')),
  requested boolean NOT NULL DEFAULT false,
  status capability_status NOT NULL DEFAULT 'unrequested',
  disabled_reason text,
  current_deadline timestamptz,
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connected_account_id, capability_name)
);
CREATE INDEX stripe_capabilities_status_idx ON stripe_capabilities (status, disabled_reason);
CREATE TRIGGER stripe_capabilities_updated_at BEFORE UPDATE ON stripe_capabilities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stripe_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id uuid NOT NULL REFERENCES stripe_connected_accounts(id) ON DELETE CASCADE,
  state stripe_requirement_state NOT NULL,
  requirement_key text NOT NULL,
  capability_name text,
  error_code text,
  error_reason text,
  pending_since timestamptz,
  deadline_at timestamptz,
  resolved_at timestamptz,
  source_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connected_account_id, state, requirement_key, capability_name)
);
CREATE INDEX stripe_requirements_open_idx ON stripe_requirements (connected_account_id, state) WHERE resolved_at IS NULL;
CREATE TRIGGER stripe_requirements_updated_at BEFORE UPDATE ON stripe_requirements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE compliance_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES partner_legal_entities(id) ON DELETE CASCADE,
  actor_type compliance_actor_type NOT NULL,
  actor_id uuid,
  event_type text NOT NULL,
  previous_status text,
  next_status text,
  stripe_event_id text,
  metadata_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_audit_events_entity_idx ON compliance_audit_events (legal_entity_id, created_at DESC);
CREATE UNIQUE INDEX compliance_audit_events_stripe_event_idx ON compliance_audit_events (stripe_event_id) WHERE stripe_event_id IS NOT NULL;

CREATE TABLE payout_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES partner_legal_entities(id) ON DELETE CASCADE,
  status payout_hold_status NOT NULL DEFAULT 'active',
  reason_code text NOT NULL,
  reason_detail text,
  source text NOT NULL CHECK (source IN ('piki_kyb', 'stripe', 'risk', 'finance', 'manual')),
  created_by uuid,
  released_by uuid,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_holds_active_idx ON payout_holds (legal_entity_id, status) WHERE status = 'active';
CREATE TRIGGER payout_holds_updated_at BEFORE UPDATE ON payout_holds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Vista de decisión operacional. Solo una fila sin requisitos abiertos y con ambas
-- capacidades activas puede recibir pagos y entrar en liquidaciones.
CREATE VIEW partner_marketplace_readiness AS
SELECT
  e.id AS legal_entity_id,
  e.restaurant_id,
  e.piki_status,
  a.stripe_account_id,
  a.status AS stripe_status,
  a.charges_enabled,
  a.payouts_enabled,
  NOT EXISTS (
    SELECT 1 FROM stripe_requirements r
    WHERE r.connected_account_id = a.id
      AND r.resolved_at IS NULL
      AND r.state IN ('currently_due', 'past_due')
  ) AS stripe_requirements_clear,
  NOT EXISTS (
    SELECT 1 FROM payout_holds h
    WHERE h.legal_entity_id = e.id AND h.status = 'active'
  ) AS payout_holds_clear,
  (
    e.piki_status = 'verified'
    AND a.charges_enabled
    AND a.payouts_enabled
    AND NOT EXISTS (
      SELECT 1 FROM stripe_requirements r
      WHERE r.connected_account_id = a.id AND r.resolved_at IS NULL AND r.state IN ('currently_due', 'past_due')
    )
    AND NOT EXISTS (
      SELECT 1 FROM payout_holds h
      WHERE h.legal_entity_id = e.id AND h.status = 'active'
    )
  ) AS operational
FROM partner_legal_entities e
LEFT JOIN stripe_connected_accounts a ON a.legal_entity_id = e.id;

-- Recomendaciones de privacidad:
-- 1. No guardar documentos binarios ni IBAN completo en estas tablas.
-- 2. storage_key debe apuntar a almacenamiento privado cifrado.
-- 3. Aplicar RLS por tenant_id en partner_legal_entities y por relación de acceso.
-- 4. Redactar tax_id, fecha de nacimiento y documentos en logs y trazas.

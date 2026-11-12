CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);

CREATE TABLE IF NOT EXISTS stations (
  station_id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id text PRIMARY KEY,
  name text NOT NULL,
  company text,
  brand text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commercial_slots (
  slot_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  station_id text REFERENCES stations(station_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_source_registry (
  source_id text PRIMARY KEY,
  source_type text NOT NULL CHECK (source_type IN ('pos', 'tenant_billing', 'manual')),
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_import_batches (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES data_source_registry(source_id),
  original_filename text NOT NULL,
  file_sha256 char(64) NOT NULL,
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'completed_with_errors', 'failed')),
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS data_import_batches_created_idx ON data_import_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_records (
  record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES data_import_batches(batch_id),
  source_id text NOT NULL REFERENCES data_source_registry(source_id),
  source_record_id text NOT NULL,
  source_file_name text NOT NULL,
  source_row_number integer NOT NULL CHECK (source_row_number > 0),
  source_hash char(64) NOT NULL,
  reporting_month date NOT NULL,
  station_id text REFERENCES stations(station_id),
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  slot_id text NOT NULL REFERENCES commercial_slots(slot_id),
  station_name text,
  tenant_name text NOT NULL,
  company text,
  brand text,
  data_type text NOT NULL,
  transaction_count numeric(20, 4),
  quantity numeric(20, 4),
  tariff numeric(20, 4),
  original_amount numeric(20, 4),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_status text NOT NULL DEFAULT 'Not applicable'
    CHECK (billing_status IN ('Billed', 'Unbilled', 'Not applicable')),
  annual_surcharge_rate numeric(12, 8),
  minimum_base_rent numeric(20, 4),
  unit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS dashboard_records_month_idx ON dashboard_records (reporting_month);
CREATE INDEX IF NOT EXISTS dashboard_records_station_month_idx ON dashboard_records (station_id, reporting_month);
CREATE INDEX IF NOT EXISTS dashboard_records_tenant_month_idx ON dashboard_records (tenant_id, reporting_month);
CREATE INDEX IF NOT EXISTS dashboard_records_slot_month_idx ON dashboard_records (slot_id, reporting_month);
CREATE INDEX IF NOT EXISTS dashboard_records_currency_month_idx ON dashboard_records (currency, reporting_month);
CREATE INDEX IF NOT EXISTS dashboard_records_type_idx ON dashboard_records (data_type);

CREATE TABLE IF NOT EXISTS pos_transactions (
  pos_transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES data_source_registry(source_id),
  source_transaction_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  station_id text REFERENCES stations(station_id),
  tenant_id text REFERENCES tenants(tenant_id),
  slot_id text REFERENCES commercial_slots(slot_id),
  transaction_count numeric(20, 4) NOT NULL CHECK (transaction_count >= 0),
  transaction_value numeric(20, 4) NOT NULL,
  tariff numeric(20, 4),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  transaction_status text NOT NULL,
  reversal_status text,
  source_system_reference text,
  reporting_month date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_transaction_id)
);
CREATE INDEX IF NOT EXISTS pos_transactions_occurred_idx ON pos_transactions (occurred_at);
CREATE INDEX IF NOT EXISTS pos_transactions_station_month_idx ON pos_transactions (station_id, reporting_month);

CREATE TABLE IF NOT EXISTS billing_invoices (
  invoice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES data_source_registry(source_id),
  source_invoice_id text NOT NULL,
  invoice_number text NOT NULL,
  tenant_id text REFERENCES tenants(tenant_id),
  slot_id text REFERENCES commercial_slots(slot_id),
  billing_period date NOT NULL,
  invoice_date date,
  billing_status text,
  payment_status text,
  invoice_amount numeric(20, 4) NOT NULL,
  outstanding_amount numeric(20, 4),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_invoice_id)
);
CREATE INDEX IF NOT EXISTS billing_invoices_period_idx ON billing_invoices (billing_period);
CREATE INDEX IF NOT EXISTS billing_invoices_tenant_period_idx ON billing_invoices (tenant_id, billing_period);

CREATE TABLE IF NOT EXISTS billing_items (
  billing_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES billing_invoices(invoice_id),
  item_type text NOT NULL,
  amount numeric(20, 4) NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  payment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES data_source_registry(source_id),
  source_payment_id text NOT NULL,
  invoice_id uuid REFERENCES billing_invoices(invoice_id),
  payment_date date NOT NULL,
  amount numeric(20, 4) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_payment_id)
);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (invoice_id);

CREATE TABLE IF NOT EXISTS operational_records (
  operational_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES data_source_registry(source_id),
  source_record_id text NOT NULL,
  station_id text REFERENCES stations(station_id),
  tenant_id text REFERENCES tenants(tenant_id),
  slot_id text REFERENCES commercial_slots(slot_id),
  reporting_month date NOT NULL,
  record_type text NOT NULL,
  value numeric(20, 4),
  currency char(3),
  source_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS utility_consumption (
  utility_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES data_source_registry(source_id),
  source_record_id text NOT NULL,
  station_id text REFERENCES stations(station_id),
  tenant_id text REFERENCES tenants(tenant_id),
  slot_id text REFERENCES commercial_slots(slot_id),
  reporting_month date NOT NULL,
  utility_type text NOT NULL,
  quantity numeric(20, 4) NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  cost numeric(20, 4),
  currency char(3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS synchronization_logs (
  sync_log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES data_source_registry(source_id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  imported_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  error_message text
);
CREATE INDEX IF NOT EXISTS synchronization_logs_source_started_idx ON synchronization_logs (source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_results (
  reconciliation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text REFERENCES data_source_registry(source_id),
  reporting_month date NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reconciliation_type text NOT NULL,
  source_total numeric(20, 4),
  dashboard_total numeric(20, 4),
  variance numeric(20, 4),
  status text NOT NULL,
  explanation text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_rejections (
  rejection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES data_import_batches(batch_id),
  source_row_number integer NOT NULL,
  error_message text NOT NULL,
  rejected_row jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_rejections_batch_idx ON import_rejections (batch_id);

CREATE TABLE IF NOT EXISTS exchange_rates (
  exchange_rate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency char(3) NOT NULL,
  quote_currency char(3) NOT NULL,
  rate numeric(20, 10) NOT NULL CHECK (rate > 0),
  effective_date date NOT NULL,
  source text NOT NULL,
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_currency, quote_currency, effective_date, source)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  source_id text,
  batch_id uuid REFERENCES data_import_batches(batch_id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO data_source_registry (source_id, source_type, display_name, enabled)
VALUES ('manual_csv', 'manual', 'Manual CSV/Excel import', true),
       ('pos_unconfigured', 'pos', 'POS connector (unconfigured)', false),
       ('billing_unconfigured', 'tenant_billing', 'Tenant billing connector (unconfigured)', false)
ON CONFLICT (source_id) DO NOTHING;

CREATE TABLE plugin_togetherweown_cf_test_env_4f5f3ae4ea.container_slots (
  account_id text PRIMARY KEY CHECK (account_id ~ '^[a-f0-9]{32}$'),
  company_id text NOT NULL,
  env_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  CHECK (document->'reservation'->>'accountId' = account_id),
  CHECK (document->'reservation'->>'companyId' = company_id),
  CHECK (document->'reservation'->>'envId' = env_id)
);

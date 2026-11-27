"""The shopping assistant's tables in PostgreSQL (the lab's pgvector database), and the row-level security that keeps
each shopper's orders, basket, wish list and returns to that shopper.

Products are public to every shopper. Every shopper table has a `customer_id` column whose default is the transaction's
`app.customer_id` setting, and a policy that shows and accepts only rows with that id; FORCE applies it to the table's
owner too. The agent's queries never run as the owner: each transaction sets the role to `<schema>_app`, a role with
no login and only the grants below, then sets `app.customer_id` from the signed-in shopper, on the server. A connection
that sets no shopper sees no shopper rows at all.

The schema name is a parameter so tests can use a throwaway schema and never touch another lab's tables.
"""
from __future__ import annotations

import re

SCHEMA_NAME = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
SCHEMA_VERSION = "2"  # bump when create_sql changes: an existing schema is brought up to date once per process
SHOPPER_TABLES = ("customers", "orders", "order_items", "baskets", "basket_items", "wishlists", "returns",
                  "offers_used", "events")


def check_schema(schema: str) -> str:
    """The schema name, checked, so it is safe to put into SQL."""
    if not SCHEMA_NAME.match(schema or ""):
        raise ValueError("A schema name is lower-case letters, digits and underscores, starting with a letter.")
    return schema


def app_role(schema: str) -> str:
    return f"{check_schema(schema)}_app"


def create_sql(schema: str, dims: int) -> str:
    """Everything the shop needs, idempotent. The HNSW index is built separately, after a bulk load (build_index_sql):
    building it once over a million rows is much faster than keeping it up to date row by row."""
    s, role = check_schema(schema), app_role(schema)
    if not isinstance(dims, int) or not 1 <= dims <= 4000:
        raise ValueError("A vector length must be between 1 and 4000.")
    # An empty id is refused too, so a transaction that set no shopper (a guest) can neither see nor write a row.
    shopper = "customer_id text NOT NULL DEFAULT current_setting('app.customer_id', true) CHECK (customer_id <> '')"
    # Two policies per table. `_own`, for everyone: a shopper's own rows only. `_loader`, for the connecting user (the
    # owner, which loads and imports data) only: every row. FORCE means the owner gets no rows without that named
    # policy, and the agent's role is not a member of the owner, so `_loader` never applies to its queries.
    policies = "\n".join(f"""ALTER TABLE {s}.{t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {s}.{t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS {t}_own ON {s}.{t};
CREATE POLICY {t}_own ON {s}.{t}
  USING (customer_id = current_setting('app.customer_id', true))
  WITH CHECK (customer_id = current_setting('app.customer_id', true));
DROP POLICY IF EXISTS {t}_loader ON {s}.{t};
CREATE POLICY {t}_loader ON {s}.{t} TO CURRENT_USER USING (true) WITH CHECK (true);""" for t in SHOPPER_TABLES)
    return f"""CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS {s};
CREATE TABLE IF NOT EXISTS {s}.meta (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO {s}.meta VALUES ('data_version', '0'), ('dims', '{dims}'), ('embed_model', '')
  ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS {s}.products (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  brand         text NOT NULL,
  category      text NOT NULL,
  subcategory   text NOT NULL,
  description   text NOT NULL,
  attributes    jsonb NOT NULL DEFAULT '{{}}',
  price_pence   int  NOT NULL CHECK (price_pence > 0),
  stock         int  NOT NULL CHECK (stock >= 0),
  rating        numeric(2,1) NOT NULL,
  review_count  int  NOT NULL DEFAULT 0,
  embedding     halfvec({dims}),            -- the last good vector: kept while a changed product waits to re-embed
  embed_text_hash text,                     -- md5 of embed_text(...): set by the trigger below
  embed_state   text NOT NULL DEFAULT 'pending' CHECK (embed_state IN ('pending', 'done', 'failed')),
  embed_attempts int NOT NULL DEFAULT 0,
  embed_error   text,
  embed_next_at timestamptz,                -- a failed attempt waits until then (exponential backoff)
  embedded_at   timestamptz,
  embedded_with text,
  tsv           tsvector GENERATED ALWAYS AS (
                  to_tsvector('english', title || ' ' || brand || ' ' || subcategory || ' ' || description)) STORED
);
CREATE INDEX IF NOT EXISTS products_tsv ON {s}.products USING gin (tsv);
CREATE INDEX IF NOT EXISTS products_attributes ON {s}.products USING gin (attributes);
CREATE INDEX IF NOT EXISTS products_category ON {s}.products (category, subcategory);
CREATE INDEX IF NOT EXISTS products_price ON {s}.products (price_pence);
CREATE INDEX IF NOT EXISTS products_embed_queue ON {s}.products (id) WHERE embed_state <> 'done';
-- Exactly the text that is embedded: what a product is, never its price or stock. The worker embeds this text, and its
-- hash decides whether an edit needs a new vector.
CREATE OR REPLACE FUNCTION {s}.embed_text(title text, brand text, category text, subcategory text, description text,
                                          attributes jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT concat_ws(' ', title || '.', brand || '.', subcategory || ' (' || category || ').', description,
    'colour ' || (attributes->>'colour'), 'material ' || (attributes->>'material'), 'fit ' || (attributes->>'fit'),
    CASE WHEN attributes->>'waterproof' = 'true' THEN 'waterproof' END)
$f$;
-- New or changed words: mark the product pending and wake the worker. A price or stock change does not fire this
-- trigger at all (it is limited to the embedded columns), and an edit that leaves the text the same keeps its vector.
-- A bulk load sets shop.bulk = on for its transaction and sends one notification at the end instead of one per row.
CREATE OR REPLACE FUNCTION {s}.products_embed_mark() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  NEW.embed_text_hash := md5({s}.embed_text(NEW.title, NEW.brand, NEW.category, NEW.subcategory, NEW.description,
                                            NEW.attributes));
  IF TG_OP = 'INSERT' OR NEW.embed_text_hash IS DISTINCT FROM OLD.embed_text_hash THEN
    NEW.embed_state := 'pending'; NEW.embed_attempts := 0; NEW.embed_error := NULL; NEW.embed_next_at := NULL;
    IF current_setting('shop.bulk', true) IS DISTINCT FROM 'on' THEN
      PERFORM pg_notify('{s}_embed', NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS products_embed ON {s}.products;
CREATE TRIGGER products_embed BEFORE INSERT OR UPDATE OF title, brand, category, subcategory, description, attributes
  ON {s}.products FOR EACH ROW EXECUTE FUNCTION {s}.products_embed_mark();
-- Any change to what a shopper is shown (words, price, stock, rating) moves the data version on, so the answer cache
-- never serves an answer made from older rows. It runs as its owner, because the agent's role (which takes stock at
-- checkout) cannot write meta itself.
CREATE OR REPLACE FUNCTION {s}.products_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog AS $f$
BEGIN
  UPDATE {s}.meta SET value = (value::bigint + 1)::text WHERE key = 'data_version';
  RETURN NULL;
END $f$;
REVOKE ALL ON FUNCTION {s}.products_changed() FROM PUBLIC;
DROP TRIGGER IF EXISTS products_version ON {s}.products;
CREATE TRIGGER products_version AFTER INSERT OR DELETE OR UPDATE OF title, brand, category, subcategory, description,
  attributes, price_pence, stock, rating, review_count ON {s}.products FOR EACH STATEMENT
  EXECUTE FUNCTION {s}.products_changed();
CREATE TABLE IF NOT EXISTS {s}.customers (
  {shopper} PRIMARY KEY,
  display_name  text NOT NULL,
  sizes         jsonb NOT NULL DEFAULT '{{}}',
  preferences   jsonb NOT NULL DEFAULT '{{}}',
  email         text,
  state_version int NOT NULL DEFAULT 0,
  taste         halfvec({dims}),
  taste_updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS {s}.orders (
  id            text PRIMARY KEY,
  {shopper},
  placed_at     timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'placed',
  delivery      text NOT NULL DEFAULT 'standard',
  offer_code    text,
  subtotal_pence int NOT NULL,
  discount_pence int NOT NULL DEFAULT 0,
  delivery_pence int NOT NULL DEFAULT 0,
  total_pence   int NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_customer ON {s}.orders (customer_id, placed_at DESC);
CREATE TABLE IF NOT EXISTS {s}.order_items (
  id            text PRIMARY KEY,
  {shopper},
  order_id      text NOT NULL REFERENCES {s}.orders(id) ON DELETE CASCADE,
  product_id    text NOT NULL,
  quantity      int  NOT NULL CHECK (quantity > 0),
  size          text,
  price_pence   int  NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order ON {s}.order_items (order_id);
CREATE TABLE IF NOT EXISTS {s}.baskets (
  {shopper} PRIMARY KEY,
  offer_code    text
);
CREATE TABLE IF NOT EXISTS {s}.basket_items (
  id            text PRIMARY KEY,
  {shopper},
  product_id    text NOT NULL,
  quantity      int  NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  size          text
);
CREATE INDEX IF NOT EXISTS basket_items_customer ON {s}.basket_items (customer_id);
-- One line per product and size in a basket. Writers also hold the basket lock; this is the backstop. Lines that a
-- schema from before the index may hold twice are merged first, keeping the earliest line.
UPDATE {s}.basket_items a SET quantity = LEAST(20, d.total) FROM (
  SELECT min(id) AS keep, sum(quantity) AS total FROM {s}.basket_items
  GROUP BY customer_id, product_id, coalesce(size, '') HAVING count(*) > 1) d WHERE a.id = d.keep;
DELETE FROM {s}.basket_items a USING {s}.basket_items b WHERE a.customer_id = b.customer_id
  AND a.product_id = b.product_id AND coalesce(a.size, '') = coalesce(b.size, '') AND a.id > b.id;
CREATE UNIQUE INDEX IF NOT EXISTS basket_items_line ON {s}.basket_items (customer_id, product_id, (coalesce(size, '')));
CREATE TABLE IF NOT EXISTS {s}.wishlists (
  {shopper},
  product_id    text NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
CREATE TABLE IF NOT EXISTS {s}.offers_used (
  {shopper},
  code          text NOT NULL,
  order_id      text NOT NULL,
  PRIMARY KEY (customer_id, code)
);
-- Browsing events: one allow-listed vocabulary, checked by the server (shop_data.clean_event). The primary key makes
-- a retried or repeated batch add nothing twice; the (customer_id, ts) index serves the profile and the retention prune.
CREATE TABLE IF NOT EXISTS {s}.events (
  {shopper},
  event_id      uuid NOT NULL,
  type          text NOT NULL,
  props         jsonb NOT NULL DEFAULT '{{}}',
  page          text NOT NULL DEFAULT '',
  ts            timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, event_id)
);
CREATE INDEX IF NOT EXISTS events_customer_ts ON {s}.events (customer_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_ts ON {s}.events (ts);
CREATE TABLE IF NOT EXISTS {s}.returns (
  id            text PRIMARY KEY,
  {shopper},
  order_item_id text NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'requested',
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- The agent's role: no login, only what the tools need. It is granted to the connecting user so a transaction can
-- switch to it with SET LOCAL ROLE; the connecting user may be a superuser, which skips row-level security.
DO $$ BEGIN CREATE ROLE {role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT {role} TO CURRENT_USER;
GRANT USAGE ON SCHEMA {s} TO {role};
GRANT SELECT ON {s}.products, {s}.meta TO {role};
GRANT UPDATE (stock) ON {s}.products TO {role};
GRANT SELECT, UPDATE (sizes, preferences, state_version, taste, taste_updated_at) ON {s}.customers TO {role};
GRANT SELECT, INSERT, UPDATE, DELETE ON {s}.orders, {s}.order_items, {s}.baskets, {s}.basket_items,
  {s}.wishlists, {s}.returns, {s}.offers_used TO {role};
GRANT SELECT, INSERT, DELETE ON {s}.events TO {role};
{policies}
INSERT INTO {s}.meta VALUES ('schema_version', '{SCHEMA_VERSION}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;"""


def channel(schema: str) -> str:
    """The LISTEN/NOTIFY channel the trigger wakes the embedding worker on (shop_embed for the shop's own schema)."""
    return f"{check_schema(schema)}_embed"


def build_index_sql(schema: str) -> str:
    s = check_schema(schema)
    return f"CREATE INDEX IF NOT EXISTS products_embedding ON {s}.products USING hnsw (embedding halfvec_cosine_ops)"


def drop_sql(schema: str) -> str:
    """Removes the schema and its role (tests, and a full regenerate)."""
    s, role = check_schema(schema), app_role(schema)
    return f"""DROP SCHEMA IF EXISTS {s} CASCADE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
    EXECUTE 'REVOKE ALL ON DATABASE ' || quote_ident(current_database()) || ' FROM {role}';
    EXECUTE 'DROP OWNED BY {role}';
    EXECUTE 'DROP ROLE {role}';
  END IF;
END $$;"""

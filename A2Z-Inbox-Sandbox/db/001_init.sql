BEGIN;
CREATE TABLE projects (
  id text PRIMARY KEY, name text NOT NULL, aliases text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE mailboxes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address text UNIQUE NOT NULL
);
CREATE TABLE mailbox_items (
  mailbox_id bigint NOT NULL REFERENCES mailboxes(id),
  folder text NOT NULL, uid_validity bigint NOT NULL, uid bigint NOT NULL,
  message_id text, subject text NOT NULL DEFAULT '',
  sender text NOT NULL DEFAULT '', recipients text NOT NULL DEFAULT '',
  received_at timestamptz, flags text[] NOT NULL DEFAULT '{}', raw bytea NOT NULL,
  project_id text REFERENCES projects(id), expunged_at timestamptz,
  PRIMARY KEY (mailbox_id, folder, uid_validity, uid)
);
CREATE INDEX mailbox_items_message_id ON mailbox_items(mailbox_id, message_id);
CREATE INDEX mailbox_items_project ON mailbox_items(project_id, received_at DESC);
CREATE INDEX mailbox_items_search ON mailbox_items USING gin
(to_tsvector('simple', subject || ' ' || sender || ' ' || recipients));
CREATE TABLE sync_cursors (
  mailbox_id bigint NOT NULL REFERENCES mailboxes(id), folder text NOT NULL,
  uid_validity bigint NOT NULL, last_uid bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (mailbox_id, folder)
);
COMMIT;

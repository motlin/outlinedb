-- When the user's Durable Object was provisioned (its profile stored), set once after email verification; null until then.
alter table "user" add column "provisioned_at" date;

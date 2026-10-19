-- Default preferences applied to new users, per (notification type x channel).
-- Mandatory notification types (e.g. security) are not stored: they are always enabled by domain rules.
CREATE TABLE default_preferences (
    notification_type text        NOT NULL,
    channel           text        NOT NULL,
    enabled           boolean     NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (notification_type, channel)
);

-- A user known to the service. Created on registration or on the first effective change.
CREATE TABLE user_profiles (
    user_id              text        PRIMARY KEY,
    version              integer     NOT NULL CHECK (version > 0),
    quiet_hours_start    time,
    quiet_hours_end      time,
    quiet_hours_timezone text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_profiles_quiet_hours_complete CHECK (
        (quiet_hours_start IS NULL AND quiet_hours_end IS NULL AND quiet_hours_timezone IS NULL)
        OR (quiet_hours_start IS NOT NULL AND quiet_hours_end IS NOT NULL AND quiet_hours_timezone IS NOT NULL
            AND quiet_hours_start <> quiet_hours_end)
    )
);

-- Per-user value for each (notification type x channel).
-- source = 'default': snapshot of defaults at user creation; 'user': explicit user choice.
CREATE TABLE user_channel_preferences (
    user_id           text        NOT NULL REFERENCES user_profiles (user_id) ON DELETE CASCADE,
    notification_type text        NOT NULL,
    channel           text        NOT NULL,
    enabled           boolean     NOT NULL,
    source            text        NOT NULL CHECK (source IN ('default', 'user')),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, notification_type, channel)
);

-- Platform-wide deny rules. NULL in a scope column means "any".
CREATE TABLE global_policies (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_type text,
    channel           text,
    region            text,
    description       text        NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT global_policies_scope_not_empty
        CHECK (notification_type IS NOT NULL OR channel IS NOT NULL OR region IS NOT NULL)
);

-- Responses of preference updates sent with an Idempotency-Key header.
CREATE TABLE idempotency_keys (
    user_id         text        NOT NULL,
    idempotency_key text        NOT NULL,
    request_hash    text        NOT NULL,
    response        jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, idempotency_key)
);

-- For periodic cleanup of expired keys.
CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);

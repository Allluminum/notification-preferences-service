-- Initial platform configuration. Idempotent, so it can be re-applied safely.

-- Transactional notifications are on by default (messenger requires linking an account, so it is off);
-- marketing is strictly opt-in on every channel.
INSERT INTO default_preferences (notification_type, channel, enabled) VALUES
    ('transactional', 'email',     true),
    ('transactional', 'sms',       true),
    ('transactional', 'push',      true),
    ('transactional', 'messenger', false),
    ('marketing',     'email',     false),
    ('marketing',     'sms',       false),
    ('marketing',     'push',      false),
    ('marketing',     'messenger', false)
ON CONFLICT (notification_type, channel) DO NOTHING;

-- Example compliance rule from the specification: no marketing SMS in the EU.
INSERT INTO global_policies (id, notification_type, channel, region, description) VALUES
    ('00000000-0000-4000-8000-000000000001', 'marketing', 'sms', 'EU',
     'Marketing SMS are not allowed in the EU without a separate consent flow')
ON CONFLICT (id) DO NOTHING;

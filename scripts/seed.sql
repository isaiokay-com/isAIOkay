-- Development seed only. Scores are illustrative until real community reports
-- are accepted and the scheduled aggregate job replaces these snapshots.
insert into settings (key, value_json, updated_at, updated_by) values
('app', '{"minAccountAgeDays":7,"probationAccountAgeDays":30,"lowConfidenceReportThreshold":8,"requireTurnstileForProbation":true,"requireTurnstileForSuspicious":true,"bayesianPriorScore":60,"bayesianPriorWeight":6,"liveScoreHalfLifeDays":14,"liveScoreLookbackDays":180,"degradingThreshold":-4,"possibleDegradationMinimumConfidence":35,"releaseBaselineMinReports":20,"releaseBaselineMinUniqueReporters":15,"releaseBaselineMinSpanDays":3,"releaseBaselineMinConfidence":65,"releaseDegradationThreshold":-8,"improvingThreshold":4,"riskRetentionDays":30,"catalogDiscoveryEnabled":false,"catalogProviderFeeds":[],"catalogSocialDiscoveryEnabled":false,"catalogRedditFeedUrl":""}', unixepoch('now') * 1000, null)
on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at;

insert into tracked_item (id, name, slug, provider_name, type, description, logo_url, official_url, pricing_summary, pricing_last_verified_at, is_active, sort_order, created_at, updated_at) values
('a0f6f4a8-5e76-4c62-a224-1db4de8b1001', 'Codex', 'codex', 'OpenAI', 'agent', 'Agentic coding workflow by OpenAI', null, 'https://openai.com/codex/', 'Plan and usage pricing vary by access path.', unixepoch('now') * 1000, 1, 10, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1002', 'Claude Code', 'claude-code', 'Anthropic', 'agent', 'Agentic coding tool by Anthropic', null, 'https://www.anthropic.com/claude-code', 'Included with eligible Claude plans; usage limits apply.', unixepoch('now') * 1000, 1, 20, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1003', 'GPT-5', 'gpt-5', 'OpenAI', 'model', 'General-purpose model used for coding tasks', null, 'https://openai.com/', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 1, 30, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1004', 'Gemini CLI', 'gemini-cli', 'Google', 'agent', 'Command-line coding agent by Google', null, 'https://github.com/google-gemini/gemini-cli', 'Usage availability varies by plan and region.', unixepoch('now') * 1000, 1, 40, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1005', 'Cursor', 'cursor', 'Cursor', 'agent', 'AI-assisted coding environment', null, 'https://www.cursor.com/', 'Subscription pricing should be verified before decisions.', unixepoch('now') * 1000, 1, 50, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1006', 'OpenCode', 'opencode', 'OpenCode', 'agent', 'Open-source coding agent with pluggable model providers', null, 'https://opencode.ai/', 'Provider and model usage pricing varies.', unixepoch('now') * 1000, 1, 60, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1007', 'GitHub Copilot CLI', 'github-copilot-cli', 'GitHub', 'agent', 'GitHub Copilot coding agent for the terminal', null, 'https://github.com/features/copilot/cli', 'Availability and usage depend on the Copilot plan.', unixepoch('now') * 1000, 1, 70, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1008', 'Cline', 'cline', 'Cline', 'agent', 'Open-source coding agent for editor workflows', null, 'https://cline.bot/', 'Provider and model usage pricing varies.', unixepoch('now') * 1000, 1, 80, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1009', 'Windsurf', 'windsurf', 'Cognition', 'agent', 'AI coding environment and Cascade agent', null, 'https://windsurf.com/', 'Subscription and usage pricing varies by plan.', unixepoch('now') * 1000, 1, 90, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1010', 'Aider', 'aider', 'Aider', 'agent', 'Open-source terminal pair programming tool', null, 'https://aider.chat/', 'The tool is open source; model API charges vary.', unixepoch('now') * 1000, 1, 100, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1011', 'Amp', 'amp', 'Sourcegraph', 'agent', 'Coding agent for terminal and editor workflows', null, 'https://ampcode.com/', 'Availability and usage pricing varies by plan.', unixepoch('now') * 1000, 1, 110, unixepoch('now') * 1000, unixepoch('now') * 1000)
on conflict(id) do update set
  name = excluded.name,
  slug = excluded.slug,
  provider_name = excluded.provider_name,
  type = excluded.type,
  description = excluded.description,
  logo_url = excluded.logo_url,
  official_url = excluded.official_url,
  pricing_summary = excluded.pricing_summary,
  pricing_last_verified_at = excluded.pricing_last_verified_at,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order,
  updated_at = excluded.updated_at;

insert into tracked_item (
  id, name, slug, provider_name, type, description, logo_url, official_url,
  pricing_summary, pricing_last_verified_at, version_label, release_at,
  release_source_url, is_active, sort_order, created_at, updated_at
) values
('a0f6f4a8-5e76-4c62-a224-1db4de8b1012', 'GPT-5.6 Sol', 'gpt-5-6-sol', 'OpenAI', 'model', 'Frontier GPT-5.6 model for complex professional and coding work', null, 'https://developers.openai.com/api/docs/models/gpt-5.6-sol', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'gpt-5.6-sol', unixepoch('2026-07-09') * 1000, 'https://openai.com/index/gpt-5-6/', 1, 31, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1013', 'GPT-5.6 Terra', 'gpt-5-6-terra', 'OpenAI', 'model', 'Balanced GPT-5.6 model for coding and everyday agentic work', null, 'https://developers.openai.com/api/docs/models', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'gpt-5.6-terra', unixepoch('2026-07-09') * 1000, 'https://openai.com/index/gpt-5-6/', 1, 32, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1014', 'GPT-5.6 Luna', 'gpt-5-6-luna', 'OpenAI', 'model', 'Efficient GPT-5.6 model for high-volume coding work', null, 'https://developers.openai.com/api/docs/models', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'gpt-5.6-luna', unixepoch('2026-07-09') * 1000, 'https://openai.com/index/gpt-5-6/', 1, 33, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1015', 'Claude Fable 5', 'claude-fable-5', 'Anthropic', 'model', 'Anthropic model for long-running agents', null, 'https://platform.claude.com/docs/en/about-claude/models/overview', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'claude-fable-5', unixepoch('2026-06-09') * 1000, 'https://platform.claude.com/docs/en/about-claude/models/overview', 1, 34, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1016', 'Claude Opus 5', 'claude-opus-5', 'Anthropic', 'model', 'Anthropic model for complex agentic coding', null, 'https://platform.claude.com/docs/en/about-claude/models/overview', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'claude-opus-5', unixepoch('2026-06-09') * 1000, 'https://platform.claude.com/docs/en/about-claude/models/overview', 1, 35, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1017', 'Claude Sonnet 5', 'claude-sonnet-5', 'Anthropic', 'model', 'Anthropic model balancing speed and coding intelligence', null, 'https://platform.claude.com/docs/en/about-claude/models/overview', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'claude-sonnet-5', unixepoch('2026-06-09') * 1000, 'https://platform.claude.com/docs/en/about-claude/models/overview', 1, 36, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1018', 'Gemini 3.5 Flash', 'gemini-3-5-flash', 'Google', 'model', 'Google model for agentic and coding workflows', null, 'https://ai.google.dev/gemini-api/docs/models', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'gemini-3.5-flash', unixepoch('2026-05-19') * 1000, 'https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5/', 1, 37, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1019', 'Gemini 3.6 Flash', 'gemini-3-6-flash', 'Google', 'model', 'Stable Google model for fast agentic and multimodal work', null, 'https://ai.google.dev/gemini-api/docs/models', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'gemini-3.6-flash', null, 'https://ai.google.dev/gemini-api/docs/models', 1, 38, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1020', 'Gemini 3.1 Pro', 'gemini-3-1-pro', 'Google', 'model', 'Google preview model for complex agentic and coding work', null, 'https://ai.google.dev/gemini-api/docs/models', 'Preview availability and pricing should be verified before decisions.', unixepoch('now') * 1000, 'gemini-3.1-pro', null, 'https://ai.google.dev/gemini-api/docs/models', 1, 39, unixepoch('now') * 1000, unixepoch('now') * 1000)
on conflict(id) do update set
  name = excluded.name, slug = excluded.slug, provider_name = excluded.provider_name,
  description = excluded.description, official_url = excluded.official_url,
  pricing_summary = excluded.pricing_summary, pricing_last_verified_at = excluded.pricing_last_verified_at,
  version_label = excluded.version_label, release_at = excluded.release_at,
  release_source_url = excluded.release_source_url, is_active = excluded.is_active,
  sort_order = excluded.sort_order, updated_at = excluded.updated_at;

-- Fast-moving community candidates are admitted only after an official model
-- identity and release reference can be verified.
insert into tracked_item (
  id, name, slug, provider_name, type, description, logo_url, official_url,
  pricing_summary, pricing_last_verified_at, version_label, release_at,
  release_source_url, is_active, sort_order, created_at, updated_at
) values
('a0f6f4a8-5e76-4c62-a224-1db4de8b1021', 'DeepSeek V4 Flash', 'deepseek-v4-flash', 'DeepSeek', 'model', 'DeepSeek model optimized for agentic coding and tool use', '/providers/deepseek.svg', 'https://api-docs.deepseek.com/quick_start/pricing/', 'API pricing should be verified before decisions.', unixepoch('now') * 1000, 'deepseek-v4-flash-0731', unixepoch('2026-07-31') * 1000, 'https://api-docs.deepseek.com/updates/', 1, 40, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1022', 'Qwen 3.8 Max Preview', 'qwen-3-8-max-preview', 'Qwen', 'model', 'Qwen preview model available in current Qwen Code workflows', '/providers/qwen.svg', 'https://qwenlm.github.io/qwen-code-docs/en/blog/updates/weekly-update-2026-07-23/', 'Preview availability and pricing should be verified before decisions.', unixepoch('now') * 1000, 'qwen3.8-max-preview', unixepoch('2026-07-23') * 1000, 'https://qwenlm.github.io/qwen-code-docs/en/blog/updates/weekly-update-2026-07-23/', 1, 41, unixepoch('now') * 1000, unixepoch('now') * 1000),
('a0f6f4a8-5e76-4c62-a224-1db4de8b1023', 'Qwen Code', 'qwen-code', 'Qwen', 'agent', 'Open-source terminal coding agent from the Qwen team', '/providers/qwen.svg', 'https://qwenlm.github.io/qwen-code-docs/en/', 'Free and provider-backed usage options vary.', unixepoch('now') * 1000, null, null, 'https://qwenlm.github.io/qwen-code-docs/en/', 1, 120, unixepoch('now') * 1000, unixepoch('now') * 1000)
on conflict(id) do update set
  name = excluded.name, slug = excluded.slug, provider_name = excluded.provider_name,
  type = excluded.type, description = excluded.description, logo_url = excluded.logo_url,
  official_url = excluded.official_url, pricing_summary = excluded.pricing_summary,
  pricing_last_verified_at = excluded.pricing_last_verified_at, version_label = excluded.version_label,
  release_at = excluded.release_at, release_source_url = excluded.release_source_url,
  is_active = excluded.is_active, sort_order = excluded.sort_order, updated_at = excluded.updated_at;

insert into model_alias (id, tool, raw_label, normalized_label, tracked_item_id, created_at, updated_at) values
('b0f6f4a8-5e76-4c62-a224-1db4de8b0001', 'codex', 'gpt-5.6', 'gpt-5-6', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1012', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0002', 'opencode', 'openai/gpt-5.6', 'openai-gpt-5-6', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1012', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0003', 'cursor', 'gpt-5.6', 'gpt-5-6', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1012', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0004', 'opencode', 'anthropic/claude-fable-5', 'anthropic-claude-fable-5', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1015', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0005', 'opencode', 'anthropic/claude-opus-5', 'anthropic-claude-opus-5', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1016', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0006', 'opencode', 'anthropic/claude-sonnet-5', 'anthropic-claude-sonnet-5', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1017', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0007', 'cursor', 'claude-fable-5', 'claude-fable-5', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1015', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0008', 'cursor', 'claude-opus-5', 'claude-opus-5', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1016', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0009', 'cursor', 'claude-sonnet-5', 'claude-sonnet-5', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1017', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0010', 'gemini-cli', 'gemini-3.5-flash', 'gemini-3-5-flash', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1018', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0011', 'gemini-cli', 'gemini-3.6-flash', 'gemini-3-6-flash', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1019', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0012', 'gemini-cli', 'gemini-3.1-pro', 'gemini-3-1-pro', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1020', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0013', 'opencode', 'google/gemini-3.5-flash', 'google-gemini-3-5-flash', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1018', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0014', 'opencode', 'google/gemini-3.6-flash', 'google-gemini-3-6-flash', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1019', unixepoch('now') * 1000, unixepoch('now') * 1000)
,
('b0f6f4a8-5e76-4c62-a224-1db4de8b0015', 'opencode', 'deepseek/deepseek-v4-flash', 'deepseek-deepseek-v4-flash', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1021', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0016', 'opencode', 'qwen/qwen3.8-max-preview', 'qwen-qwen3-8-max-preview', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1022', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0017', 'qwen-code', 'qwen3.8-max-preview', 'qwen3-8-max-preview', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1022', unixepoch('now') * 1000, unixepoch('now') * 1000),
('b0f6f4a8-5e76-4c62-a224-1db4de8b0018', 'qwen-code', 'deepseek-v4-flash', 'deepseek-v4-flash', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1021', unixepoch('now') * 1000, unixepoch('now') * 1000)
on conflict(tool, normalized_label) do update set
  raw_label = excluded.raw_label, tracked_item_id = excluded.tracked_item_id, updated_at = excluded.updated_at;

-- Provider marks are version-controlled and served by this Worker. External
-- logo URLs are deliberately removed so ranking rows never depend on a third
-- party request.
update tracked_item set
  logo_url = case
    when provider_name = 'OpenAI' then '/providers/openai.svg'
    when provider_name = 'Anthropic' then '/providers/anthropic.svg'
    when provider_name = 'Google' then '/providers/google-gemini.svg'
    when provider_name = 'DeepSeek' then '/providers/deepseek.svg'
    when provider_name = 'Qwen' then '/providers/qwen.svg'
    else null
  end,
  updated_at = unixepoch('now') * 1000;

insert into aggregate (id, tracked_item_id, period, period_start, period_end, report_count, weighted_report_count, overall_score, result_quality_score, usage_efficiency_score, confidence, change, state, snapshot_day, calculated_at) values
('e1f6f4a8-5e76-4c62-a224-1db4de8b1001', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1001', '7d', unixepoch('now') * 1000 - 604800000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('e1f6f4a8-5e76-4c62-a224-1db4de8b1002', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1002', '7d', unixepoch('now') * 1000 - 604800000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('e1f6f4a8-5e76-4c62-a224-1db4de8b1003', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1003', '7d', unixepoch('now') * 1000 - 604800000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('e1f6f4a8-5e76-4c62-a224-1db4de8b1004', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1004', '7d', unixepoch('now') * 1000 - 604800000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('e1f6f4a8-5e76-4c62-a224-1db4de8b1005', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1005', '7d', unixepoch('now') * 1000 - 604800000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('f1f6f4a8-5e76-4c62-a224-1db4de8b1001', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1001', '24h', unixepoch('now') * 1000 - 86400000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('f1f6f4a8-5e76-4c62-a224-1db4de8b1002', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1002', '24h', unixepoch('now') * 1000 - 86400000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('f1f6f4a8-5e76-4c62-a224-1db4de8b1003', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1003', '24h', unixepoch('now') * 1000 - 86400000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('f1f6f4a8-5e76-4c62-a224-1db4de8b1004', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1004', '24h', unixepoch('now') * 1000 - 86400000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000),
('f1f6f4a8-5e76-4c62-a224-1db4de8b1005', 'a0f6f4a8-5e76-4c62-a224-1db4de8b1005', '24h', unixepoch('now') * 1000 - 86400000, unixepoch('now') * 1000, 0, 0, 60, 60, 60, 0, 0, 'new', (unixepoch('now') / 86400) * 86400000, unixepoch('now') * 1000)
on conflict(id) do update set
  tracked_item_id = excluded.tracked_item_id,
  period = excluded.period,
  period_start = excluded.period_start,
  period_end = excluded.period_end,
  report_count = excluded.report_count,
  weighted_report_count = excluded.weighted_report_count,
  overall_score = excluded.overall_score,
  result_quality_score = excluded.result_quality_score,
  usage_efficiency_score = excluded.usage_efficiency_score,
  confidence = excluded.confidence,
  change = excluded.change,
  state = excluded.state,
  snapshot_day = excluded.snapshot_day,
  calculated_at = excluded.calculated_at;

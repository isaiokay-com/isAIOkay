-- Keep the server-owned individual coding-subscription catalog aligned with
-- official vendor plan pages verified on 2026-08-26. Free and organization
-- tiers are intentionally excluded from the paid individual-plan ranking.
INSERT INTO `subscription_plan`
  (`id`,`slug`,`provider_name`,`name`,`billing_period`,`price_micros`,`currency`,`official_url`,`terms_version`,`terms_last_verified_at`,`is_active`,`created_at`,`updated_at`)
VALUES
  ('20000000-0000-4000-8000-000000000001','chatgpt-plus','OpenAI','ChatGPT Plus','monthly',20000000,'USD','https://learn.chatgpt.com/docs/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000002','chatgpt-pro-100','OpenAI','ChatGPT Pro 5x','monthly',100000000,'USD','https://learn.chatgpt.com/docs/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000003','chatgpt-pro-200','OpenAI','ChatGPT Pro 20x','monthly',200000000,'USD','https://learn.chatgpt.com/docs/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000004','claude-pro','Anthropic','Claude Pro','monthly',20000000,'USD','https://support.claude.com/en/articles/11049762-choose-a-claude-plan','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000005','claude-max-5x','Anthropic','Claude Max 5x','monthly',100000000,'USD','https://support.claude.com/en/articles/11049762-choose-a-claude-plan','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000006','claude-max-20x','Anthropic','Claude Max 20x','monthly',200000000,'USD','https://support.claude.com/en/articles/11049762-choose-a-claude-plan','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000007','supergrok','xAI','SuperGrok','monthly',30000000,'USD','https://x.ai/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000008','supergrok-plus','xAI','SuperGrok Plus','monthly',100000000,'USD','https://x.ai/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000009','github-copilot-pro','GitHub','GitHub Copilot Pro','monthly',10000000,'USD','https://github.com/features/copilot/plans','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000010','github-copilot-pro-plus','GitHub','GitHub Copilot Pro+','monthly',39000000,'USD','https://github.com/features/copilot/plans','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000011','github-copilot-max','GitHub','GitHub Copilot Max','monthly',100000000,'USD','https://github.com/features/copilot/plans','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000012','chatgpt-go','OpenAI','ChatGPT Go','monthly',8000000,'USD','https://learn.chatgpt.com/docs/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000013','supergrok-lite','xAI','SuperGrok Lite','monthly',NULL,'USD','https://x.ai/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000014','supergrok-heavy','xAI','SuperGrok Heavy','monthly',NULL,'USD','https://x.ai/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000015','cursor-start-india','Cursor','Cursor Start (India)','monthly',649000000,'INR','https://cursor.com/docs/models-and-pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000016','cursor-pro','Cursor','Cursor Pro','monthly',20000000,'USD','https://cursor.com/docs/models-and-pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000017','cursor-pro-plus','Cursor','Cursor Pro Plus','monthly',60000000,'USD','https://cursor.com/docs/models-and-pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000018','cursor-ultra','Cursor','Cursor Ultra','monthly',200000000,'USD','https://cursor.com/docs/models-and-pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000019','opencode-go','OpenCode','OpenCode Go','monthly',10000000,'USD','https://opencode.ai/docs/go/','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000020','google-ai-pro','Google','Google AI Pro','monthly',19990000,'USD','https://antigravity.google/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000021','google-ai-ultra','Google','Google AI Ultra','monthly',NULL,'USD','https://antigravity.google/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000022','kimi-andante','Kimi','Kimi Andante','monthly',49000000,'CNY','https://www.kimi.com/en/help/membership/membership-overview','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000023','kimi-moderato','Kimi','Kimi Moderato','monthly',99000000,'CNY','https://www.kimi.com/en/help/membership/membership-overview','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000024','kimi-allegretto','Kimi','Kimi Allegretto','monthly',199000000,'CNY','https://www.kimi.com/en/help/membership/membership-overview','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000025','kimi-allegro','Kimi','Kimi Allegro','monthly',699000000,'CNY','https://www.kimi.com/en/help/membership/membership-overview','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000026','devin-pro','Cognition','Devin Pro','monthly',20000000,'USD','https://devin.ai/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639),
  ('20000000-0000-4000-8000-000000000027','devin-max','Cognition','Devin Max','monthly',200000000,'USD','https://devin.ai/pricing','2026-08-26',1787706771639,1,1787706771639,1787706771639)
ON CONFLICT(`slug`) DO UPDATE SET
  `provider_name` = excluded.`provider_name`,
  `name` = excluded.`name`,
  `billing_period` = excluded.`billing_period`,
  `price_micros` = excluded.`price_micros`,
  `currency` = excluded.`currency`,
  `official_url` = excluded.`official_url`,
  `terms_version` = excluded.`terms_version`,
  `terms_last_verified_at` = excluded.`terms_last_verified_at`,
  `is_active` = excluded.`is_active`,
  `updated_at` = excluded.`updated_at`;

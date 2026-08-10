UPDATE tracked_item SET
  logo_url = CASE
    WHEN provider_name = 'OpenAI' THEN '/providers/openai.svg'
    WHEN provider_name = 'Anthropic' THEN '/providers/anthropic.svg'
    WHEN provider_name = 'Google' THEN '/providers/google-gemini.svg'
    WHEN provider_name = 'DeepSeek' THEN '/providers/deepseek.svg'
    WHEN provider_name = 'Qwen' THEN '/providers/qwen.svg'
    ELSE NULL
  END,
  updated_at = unixepoch('now') * 1000;

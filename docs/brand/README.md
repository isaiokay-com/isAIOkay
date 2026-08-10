# IsAIokay.com identity

The identity is the literal `IsAIokay.com` domain drawn in a custom block alphabet. The domain is the complete wordmark, with `AI` highlighted in brand blue while the rest of the name remains ink black and `.com` recedes in gray.

Production assets:

- `/public/logo-lockup-blue.png`: primary `IsAIokay.com` domain wordmark
- `/public/favicon.svg`: cobalt `AI` browser icon
- `/public/favicon-16.png`: 16px browser fallback
- `/public/favicon-32.png`: browser fallback
- `/public/favicon.ico`: legacy multi-resolution browser fallback
- `/public/apple-touch-icon.png`: Apple touch icon
- `/public/icon-192.png`: 192px installable-app icon
- `/public/icon-512.png`: 512px installable-app icon
- `/public/og.svg`: editable social-card source
- `/public/og.png`: rendered Open Graph and X card

The production wordmark is a high-resolution raster asset with no runtime font dependency. Browser and installable-app icons use the matching cobalt `AI` monogram.

## Palette

- Brand and primary text: `#111111`
- Page background: `#FFFFFF`
- Secondary surfaces: `#FAFAFA`
- Borders: `#EAEAEA`
- Interactive blue: `#2563EB`
- Positive data only: `#16A34A`
- Warning/new data only: `#D97706`
- Negative data only: `#DC2626`
- Secondary text: `#6B7280`
- Muted text: `#9CA3AF`

The wordmark uses only ink black and interactive blue. Elsewhere, blue remains reserved for interaction and neutral chart lines; green, amber, and red describe data state only.

Provider marks under `/public/providers/` are version-controlled and served from `isaiokay.com`. Ranking rows make no third-party logo requests.

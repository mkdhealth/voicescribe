# VoiceScribe

Speech recognition web app: live mic transcription, online-meeting capture (Zoom/Meet/Teams tab audio) with live captions, file & URL transcription, speaker identification with renaming, AI summaries, and Indian language support (auto-detect incl. Hindi, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Urdu, and more).

Your AssemblyAI API key stays on the server — users never see it.

## Run locally

1. Install [Node.js 18+](https://nodejs.org) — no other dependencies needed.
2. Set your API key (from https://www.assemblyai.com dashboard) and start:

```bash
# Windows (PowerShell)
$env:ASSEMBLYAI_API_KEY="your_key_here"; npm start

# Mac/Linux
ASSEMBLYAI_API_KEY=your_key_here npm start
```

4. Open http://localhost:3000

## Deploy free on Render

1. Push this folder to a GitHub repo.
2. On https://render.com → New → Web Service → connect the repo.
3. Settings: Build command (leave empty), Start command `npm start`.
4. Add environment variable `ASSEMBLYAI_API_KEY` = your key.
5. Deploy — you get a public https URL.

(Railway, Fly.io, and Heroku work the same way. Vercel needs the endpoints converted to serverless functions — ask Claude if you want that variant.)

## Notes & limits

- Meeting capture requires the meeting open in a browser tab (Chrome/Edge) with "Also share tab audio" enabled. A bot that joins meetings by itself (like Otter/Notion) requires a meeting-bot service such as Recall.ai — a possible next step.
- Live captions are English-only (AssemblyAI streaming); the post-meeting transcript supports all listed languages.
- URL transcription needs a direct, publicly accessible media link (.mp3/.mp4/etc.). YouTube page links need a server-side downloader (yt-dlp) — also a possible next step.
- Speaker identification: supported for English, Hindi, and several other languages; for other Indian languages you get a plain transcript.
- Summaries are English-only currently; an LLM post-processing step can add multilingual summaries.
- Costs: AssemblyAI pre-recorded transcription is pay-as-you-go (~$0.2–0.3/hr of audio); the free tier includes starter credits.

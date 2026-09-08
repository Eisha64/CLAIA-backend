# CLAIA Backend

A real server for the CLAIA discharge fact sheet generator — persistent database, full audit logging, and server-side grounding lookups (MedlinePlus/RxNorm).

## Setup
1. `npm install`
2. Get a free Gemini API key at https://aistudio.google.com/apikey (no credit card needed)
3. Copy `.env.example` to `.env` and paste in your key as `GEMINI_API_KEY=...`
4. `node server.js`
5. Visit `http://localhost:3001/health`

## Deploying on Render
- Build command: `npm install`
- Start command: `node server.js`
- Environment variable: `GEMINI_API_KEY` (set in Render's dashboard, not in code)

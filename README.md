# LSP Connect — Frontend

This is the frontend-only implementation package built from the 35 supplied Stitch screens. It preserves each screen as a real page (not an iframe) and adds shared navigation, demo interactions, local persistence, and responsive safety rules.

## Run locally
1. Install Node.js (LTS).
2. Open this folder in a terminal.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open the local address printed by Vite.

## Demo behavior
- This version uses browser localStorage for temporary demo data.
- No Supabase connection or real authentication/payment is active.
- Use the Role Selection screen to enter Customer, Provider, or Admin demo journeys.
- Admin access is a demo-only flow and does not create real admin accounts.

## Structure
- `public/screens/` contains the 35 original screen pages and their preview images.
- `public/runtime.js` provides cross-screen navigation and demo interactions.
- `screen-map.json` maps approved screen numbers to their routes.

The app intentionally does not include `.env`, secrets, `node_modules`, or `.git`.

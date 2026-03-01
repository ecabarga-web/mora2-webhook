// ── vercel.json ──────────────────────────────────────────
{
  "version": 2,
  "functions": {
    "api/webhook.js": {
      "maxDuration": 10
    }
  }
}

// ── package.json ─────────────────────────────────────────
{
  "name": "mora2-webhook",
  "version": "1.0.0",
  "private": true
}

 Meta Messenger Booking Bot

An intelligent AI-powered booking bot for Meta Messenger (Facebook/Instagram) that handles appointment scheduling with Google Calendar integration. Built with Cloudflare Workers, Supabase, and DeepSeek AI.

## Features

- **Intelligent Conversations** - Natural language understanding with DeepSeek AI
- **Google Calendar Integration** - Automatic slot generation and booking
- **Multi-Platform** - Works with Facebook Messenger and Instagram DMs
- **Secure** - Webhook signature verification and RLS policies
- **Email Notifications** - Booking confirmations via Resend
- **Smart Slot Matching** - Handles relative dates ("next Wednesday"), time formats ("3:00", "3pm")
- **Idempotent** - Prevents duplicate bookings and message processing
- **Bot Handoff** - Automatically disables after booking for human takeover

## Architecture

```
Meta Messenger → Cloudflare Worker → Supabase (Database)
                      ↓
                Google Calendar API
                      ↓
                DeepSeek AI (FAQ)
                      ↓
                Resend (Email)
```

## Prerequisites

Before you begin, you'll need:

1. **Cloudflare Account** - [Sign up](https://dash.cloudflare.com/sign-up)
2. **Supabase Project** - [Create project](https://supabase.com/dashboard)
3. **Meta Developer Account** - [Meta for Developers](https://developers.facebook.com/)
4. **Google Cloud Project** - [Google Cloud Console](https://console.cloud.google.com/)
5. **DeepSeek API Key** - [DeepSeek Platform](https://platform.deepseek.com/)
6. **Resend Account** - [Resend](https://resend.com/) (optional, for email notifications)

## Installation

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd meta-bot
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Supabase Database

#### A. Run Migrations

In your Supabase SQL Editor, run these migrations in order:

1. **Core Bot Tables** (`supabase/migrations/20260203000000_create_bot_tables.sql`)
   - Creates `bot_leads`, `bot_convo_state`, `bot_messages`, `bot_message_dedupe`

2. **Collect Then Book Flow** (`supabase/migrations/20260207200000_collect_then_book_flow.sql`)
   - Adds pending slot fields and customer details

3. **Bot Enabled Flag** (`supabase/migrations/20260209000001_add_bot_enabled_flag.sql`)
   - Adds `bot_enabled` column for human handoff

4. **Add-ons Table** (optional, if you want dynamic pricing)
```sql
CREATE TABLE IF NOT EXISTS add_ons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  addon_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_cents INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Example add-on
INSERT INTO add_ons (addon_key, name, price_cents, is_active)
VALUES ('dog_hair', 'Dog Hair Removal', 5000, true);
```

#### B. Get Supabase Credentials

From your Supabase project settings:
- **Project URL**: `https://xxxxx.supabase.co`
- **Service Role Key**: Found in Settings → API → service_role key (keep secret!)

### 4. Set Up Meta App

#### A. Create Meta App

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Create a new app → Business → Messenger
3. Add Messenger product to your app

#### B. Get Meta Credentials

- **App Secret**: Settings → Basic → App Secret
- **Verify Token**: Create a random string (e.g., `my_verify_token_12345`)
- **Page Access Token**: 
  1. Go to Messenger → Settings
  2. Add your Facebook Page
  3. Generate Page Access Token

#### C. Configure Webhook (after deployment)

1. Messenger → Settings → Webhooks
2. Callback URL: `https://your-worker.workers.dev/webhook`
3. Verify Token: (the one you created above)
4. Subscribe to: `messages`, `messaging_postbacks`

### 5. Set Up Google Calendar API

#### A. Create OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable Google Calendar API
4. Create OAuth 2.0 credentials:
   - Application type: Web application
   - Authorized redirect URIs: `http://localhost:3000/oauth2callback`

#### B. Get Refresh Token

Run this script to get your refresh token:

```javascript
// get-google-token.js
const http = require('http');
const url = require('url');

const CLIENT_ID = 'your-client-id';
const CLIENT_SECRET = 'your-client-secret';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

// Step 1: Open this URL in browser
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${REDIRECT_URI}&` +
  `response_type=code&` +
  `scope=https://www.googleapis.com/auth/calendar&` +
  `access_type=offline&` +
  `prompt=consent`;

console.log('Open this URL in your browser:\n', authUrl);

// Step 2: Start local server to receive callback
const server = http.createServer(async (req, res) => {
  const queryObject = url.parse(req.url, true).query;
  const code = queryObject.code;

  if (code) {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenResponse.json();
    console.log('\n Refresh Token:', tokens.refresh_token);
    
    res.end('Success! Check your terminal for the refresh token.');
    server.close();
  }
});

server.listen(3000, () => {
  console.log('\nServer listening on http://localhost:3000');
});
```

Run: `node get-google-token.js`

#### C. Get Calendar ID

1. Open Google Calendar
2. Settings → Your calendar → Integrate calendar
3. Copy the Calendar ID (e.g., `your-email@gmail.com`)

### 6. Set Up DeepSeek API

1. Go to [DeepSeek Platform](https://platform.deepseek.com/)
2. Create an account
3. Generate an API key from the dashboard

### 7. Configure Environment Variables

#### A. Edit `wrangler.toml`

Update the `[vars]` section with your business details:

```toml
[vars]
GOOGLE_TIMEZONE = "America/Denver"  # Your timezone
SERVICE_NAME = "Full Detail"        # Your service name
SERVICE_PRICE = "$229"              # Your service price
```

#### B. Set Secrets

Run these commands to set your secrets (Cloudflare will prompt for values):

```bash
# Meta/Facebook
wrangler secret put META_VERIFY_TOKEN
wrangler secret put META_APP_SECRET
wrangler secret put FB_PAGE_ACCESS_TOKEN

# Supabase
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Google Calendar
wrangler secret put GOOGLE_CALENDAR_ID
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN

# DeepSeek AI
wrangler secret put DEEPSEEK_API_KEY

# Resend (optional)
wrangler secret put RESEND_API_KEY
```

**Secret Values:**

| Secret | Description | Example |
|--------|-------------|---------|
| `META_VERIFY_TOKEN` | Random string you created | `my_verify_token_12345` |
| `META_APP_SECRET` | From Meta App Settings | `abc123...` |
| `FB_PAGE_ACCESS_TOKEN` | From Meta Messenger Settings | `EAAx...` |
| `SUPABASE_URL` | Your Supabase project URL | `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase Settings → API | `eyJhbGc...` |
| `GOOGLE_CALENDAR_ID` | Your calendar ID | `your-email@gmail.com` |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console | `123-abc.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console | `GOCSPX-...` |
| `GOOGLE_REFRESH_TOKEN` | From OAuth flow above | `1//0g...` |
| `DEEPSEEK_API_KEY` | From DeepSeek Platform | `sk-...` |
| `RESEND_API_KEY` | From Resend Dashboard | `re_...` |

## Deployment

### Deploy to Cloudflare

```bash
npm run deploy
```

Your worker will be deployed to: `https://your-worker-name.your-subdomain.workers.dev`

### Configure Meta Webhook

1. Go to Meta App → Messenger → Settings → Webhooks
2. Click "Add Callback URL"
3. Callback URL: `https://your-worker-name.your-subdomain.workers.dev/webhook`
4. Verify Token: (your `META_VERIFY_TOKEN`)
5. Subscribe to fields: `messages`, `messaging_postbacks`

## Testing

### Test Webhook Connection

```bash
curl https://your-worker-name.your-subdomain.workers.dev/health
```

Should return: `{"status":"ok"}`

### Test Bot Conversation

1. Open your Facebook Page
2. Send a message to your page
3. Bot should respond with available slots

### View Logs

```bash
npm run tail
```

## Customization

### Update Service Details

Edit `wrangler.toml`:

```toml
[vars]
GOOGLE_TIMEZONE = "America/New_York"
SERVICE_NAME = "Premium Wash"
SERVICE_PRICE = "$150"
```

Redeploy: `npm run deploy`

### Modify Conversation Flow

Edit `src/flow.ts` to customize:
- Message templates
- Slot offering logic
- Question detection
- Response variations

### Add Custom Add-ons

Insert into Supabase:

```sql
INSERT INTO add_ons (addon_key, name, price_cents, is_active)
VALUES 
  ('wax', 'Wax & Polish', 7500, true),
  ('interior_shampoo', 'Interior Shampoo', 5000, true);
```

Bot will automatically include these in pricing responses.

### Adjust Slot Generation

Edit `src/google.ts` → `generateTwoSlots()`:
- Change slot duration (default: 3 hours)
- Modify available hours (default: 9 AM - 5 PM)
- Adjust buffer times

## Troubleshooting

### Bot Not Responding

1. Check webhook is configured correctly in Meta
2. Verify secrets are set: `wrangler secret list`
3. Check logs: `npm run tail`
4. Test health endpoint: `curl https://your-worker.workers.dev/health`

### Calendar Events Not Creating

1. Verify Google Calendar API is enabled
2. Check refresh token is valid (regenerate if needed)
3. Ensure calendar ID is correct
4. Check logs for Google API errors

### Database Errors

1. Verify Supabase URL and service role key
2. Check migrations ran successfully
3. Verify RLS policies allow service_role access
4. Check Supabase logs in dashboard

### DeepSeek API Errors

1. Verify API key is valid
2. Check you have credits/quota
3. Bot will fall back to deterministic responses if DeepSeek fails

## File Structure

```
meta-bot/
├── src/
│   ├── index.ts          # Main worker entry point
│   ├── flow.ts           # Conversation flow & templates
│   ├── types.ts          # TypeScript interfaces
│   ├── meta.ts           # Meta API client
│   ├── supabase.ts       # Database operations
│   ├── google.ts         # Google Calendar API
│   ├── deepseek.ts       # DeepSeek AI integration
│   ├── resend.ts         # Email notifications
│   ├── security.ts       # Webhook verification
│   ├── dateParser.ts     # Date parsing logic
│   └── context.ts        # Context tracking
├── supabase/
│   └── migrations/       # Database migrations
├── wrangler.toml         # Cloudflare config
├── package.json          # Dependencies
└── tsconfig.json         # TypeScript config
```

## Environment Variables Reference

### Required Secrets (via `wrangler secret put`)

| Variable | Purpose | Where to Get |
|----------|---------|--------------|
| `META_VERIFY_TOKEN` | Webhook verification | Create your own random string |
| `META_APP_SECRET` | Signature verification | Meta App → Settings → Basic |
| `FB_PAGE_ACCESS_TOKEN` | Send messages | Meta App → Messenger → Settings |
| `SUPABASE_URL` | Database connection | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Database auth | Supabase → Settings → API |
| `GOOGLE_CALENDAR_ID` | Calendar to use | Google Calendar → Settings |
| `GOOGLE_CLIENT_ID` | OAuth credentials | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth credentials | Google Cloud Console |
| `GOOGLE_REFRESH_TOKEN` | Calendar access | OAuth flow (see setup) |
| `DEEPSEEK_API_KEY` | AI responses | DeepSeek Platform |
| `RESEND_API_KEY` | Email notifications | Resend Dashboard (optional) |

### Public Variables (in `wrangler.toml`)

| Variable | Purpose | Example |
|----------|---------|---------|
| `GOOGLE_TIMEZONE` | Slot generation timezone | `America/Denver` |
| `SERVICE_NAME` | Your service name | `Full Detail` |
| `SERVICE_PRICE` | Your service price | `$229` |

## Features in Detail

### Intelligent Date Parsing

Supports natural language:
- "next Wednesday" → 7+ days away
- "this Friday" → upcoming in current week
- "tomorrow" → next day
- "the 17th" → specific date
- "February 15" → month + date

### Smart Time Matching

Recognizes multiple formats:
- "3" → 3:00 PM
- "3:00" → 3:00 PM
- "3pm" → 3:00 PM
- "3:00 PM" → 3:00 PM
- "noon" → 12:00 PM

### Bot Handoff

After booking completes:
1. Bot sets `bot_enabled = false`
2. Future messages are ignored
3. Human can take over conversation

To re-enable bot for a lead:
```sql
UPDATE bot_leads SET bot_enabled = true WHERE psid = 'user-psid';
```

### Duplicate Prevention

- Message deduplication (handles Meta retries)
- Slot claim guards (prevents double-booking)
- Idempotent calendar event creation

## Support

For issues or questions:
1. Check logs: `npm run tail`
2. Review Supabase logs in dashboard
3. Check Meta webhook logs in developer console
4. Verify all secrets are set correctly

## License

MIT

## Credits

Built with:
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Supabase](https://supabase.com/)
- [DeepSeek AI](https://www.deepseek.com/)
- [Google Calendar API](https://developers.google.com/calendar)
- [Resend](https://resend.com/)

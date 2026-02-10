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

Before you begin, you'll need accounts for:

1. **Cloudflare Account** - [Sign up](https://dash.cloudflare.com/sign-up) (Free tier works)
2. **Supabase Project** - [Create project](https://supabase.com/dashboard) (Free tier works)
3. **Meta Developer Account** - [Meta for Developers](https://developers.facebook.com/) (Free)
4. **Google Cloud Project** - [Google Cloud Console](https://console.cloud.google.com/) (Free)
5. **DeepSeek API Key** - [DeepSeek Platform](https://platform.deepseek.com/) (Paid, ~$0.14 per 1M tokens)
6. **Resend Account** - [Resend](https://resend.com/) (Optional, 100 emails/day free)

## Complete Setup Guide

This guide will take approximately 60-90 minutes to complete.

---

## PART 1: Local Setup (5 minutes)

### Step 1.1: Clone and Install

```bash
# Clone the repository
git clone <your-repo-url>
cd meta-bot

# Install dependencies
npm install
```

**Expected output:**
```
added 150 packages in 15s
```

---

## PART 2: Supabase Database Setup (15 minutes)

### Step 2.1: Create Supabase Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Click "New Project"
3. Fill in:
   - **Name**: `meta-booking-bot` (or your choice)
   - **Database Password**: Generate a strong password (save this!)
   - **Region**: Choose closest to your users
4. Click "Create new project"
5. Wait 2-3 minutes for project to initialize

### Step 2.2: Create Database Tables

Open your Supabase project → SQL Editor → Click "New Query"

#### Table 1: bot_leads

**Purpose**: Stores customer information and booking status

```sql
-- Create bot_leads table
CREATE TABLE bot_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  psid TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','booked','dead','needs_followup')),
  zip TEXT,
  bot_enabled BOOLEAN DEFAULT true,
  
  -- Finalized booking fields
  booked_event_id TEXT,
  booked_slot_label TEXT,
  booked_slot_start TIMESTAMPTZ,
  booked_slot_end TIMESTAMPTZ,
  booking_claimed_at TIMESTAMPTZ,
  
  -- Pending booking fields (before calendar event created)
  pending_slot_label TEXT,
  pending_slot_start TIMESTAMPTZ,
  pending_slot_end TIMESTAMPTZ,
  pending_claimed_at TIMESTAMPTZ,
  
  -- Customer details
  customer_name TEXT,
  customer_address TEXT,
  customer_phone TEXT,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX idx_bot_leads_psid ON bot_leads(psid);
CREATE INDEX idx_bot_leads_status ON bot_leads(status);
CREATE INDEX idx_bot_leads_last_seen ON bot_leads(last_seen_at);
CREATE INDEX idx_bot_leads_bot_enabled ON bot_leads(bot_enabled);

-- Add comments for documentation
COMMENT ON TABLE bot_leads IS 'Stores customer information and booking status';
COMMENT ON COLUMN bot_leads.psid IS 'Page-Scoped ID from Meta Messenger (unique per user per page)';
COMMENT ON COLUMN bot_leads.status IS 'Lead status: active, booked, dead, needs_followup';
COMMENT ON COLUMN bot_leads.bot_enabled IS 'When false, bot will not respond (human takeover)';
COMMENT ON COLUMN bot_leads.booked_event_id IS 'Google Calendar event ID (set when booking finalized)';
COMMENT ON COLUMN bot_leads.pending_slot_label IS 'Slot label while collecting customer details';
```

**Field Descriptions:**

| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `id` | UUID | Unique identifier | `550e8400-e29b-41d4-a716-446655440000` |
| `psid` | TEXT | Meta user ID (unique) | `1234567890` |
| `status` | TEXT | Lead status | `active`, `booked`, `dead`, `needs_followup` |
| `zip` | TEXT | Customer ZIP code | `84101` |
| `bot_enabled` | BOOLEAN | Bot responds if true | `true` |
| `booked_event_id` | TEXT | Google Calendar event ID | `abc123xyz` |
| `booked_slot_label` | TEXT | Human-readable slot | `Saturday at 12:30 PM` |
| `booked_slot_start` | TIMESTAMPTZ | Booking start time | `2026-02-15 12:30:00+00` |
| `booked_slot_end` | TIMESTAMPTZ | Booking end time | `2026-02-15 15:30:00+00` |
| `booking_claimed_at` | TIMESTAMPTZ | When booking was claimed | `2026-02-09 10:15:00+00` |
| `pending_slot_label` | TEXT | Slot while collecting info | `Friday at 3:00 PM` |
| `pending_slot_start` | TIMESTAMPTZ | Pending slot start | `2026-02-14 15:00:00+00` |
| `pending_slot_end` | TIMESTAMPTZ | Pending slot end | `2026-02-14 18:00:00+00` |
| `pending_claimed_at` | TIMESTAMPTZ | When pending claim made | `2026-02-09 10:10:00+00` |
| `customer_name` | TEXT | Customer name | `John Doe` |
| `customer_address` | TEXT | Service address | `123 Main St, SLC, UT` |
| `customer_phone` | TEXT | Customer phone | `801-555-1234` |
| `created_at` | TIMESTAMPTZ | Record creation time | `2026-02-09 10:00:00+00` |
| `updated_at` | TIMESTAMPTZ | Last update time | `2026-02-09 10:15:00+00` |
| `last_seen_at` | TIMESTAMPTZ | Last message time | `2026-02-09 10:15:00+00` |

Click "Run" to execute.

#### Table 2: bot_convo_state

**Purpose**: Stores conversation state machine and context

```sql
-- Create bot_convo_state table
CREATE TABLE bot_convo_state (
  lead_id UUID PRIMARY KEY REFERENCES bot_leads(id) ON DELETE CASCADE,
  step TEXT NOT NULL DEFAULT 'start',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create index
CREATE INDEX idx_bot_convo_state_step ON bot_convo_state(step);

-- Add comments
COMMENT ON TABLE bot_convo_state IS 'Stores conversation state machine and context for each lead';
COMMENT ON COLUMN bot_convo_state.step IS 'Current conversation step: start, closing, post_book_collect';
COMMENT ON COLUMN bot_convo_state.context IS 'JSON context: slots, collectStep, offeredDays, attemptCount, etc.';
```

**Field Descriptions:**

| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `lead_id` | UUID | References bot_leads.id | `550e8400-e29b-41d4-a716-446655440000` |
| `step` | TEXT | Current conversation step | `start`, `closing`, `post_book_collect` |
| `context` | JSONB | Conversation context | `{"slots": [...], "collectStep": "address"}` |
| `updated_at` | TIMESTAMPTZ | Last update time | `2026-02-09 10:15:00+00` |

**Context JSON Structure:**
```json
{
  "slots": [
    {
      "label": "Saturday at 12:30 PM",
      "startISO": "2026-02-15T12:30:00Z",
      "endISO": "2026-02-15T15:30:00Z"
    }
  ],
  "collectStep": "address",
  "offeredDays": ["friday", "saturday"],
  "requestedDay": "monday",
  "attemptCount": 1,
  "lastIntent": "date_request",
  "address": "123 Main St",
  "phone": "801-555-1234"
}
```

Click "Run" to execute.

#### Table 3: bot_messages

**Purpose**: Audit trail of all messages (inbound and outbound)

```sql
-- Create bot_messages table
CREATE TABLE bot_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES bot_leads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  text TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes
CREATE INDEX idx_bot_messages_lead_created ON bot_messages(lead_id, created_at DESC);
CREATE INDEX idx_bot_messages_direction ON bot_messages(direction);

-- Add comments
COMMENT ON TABLE bot_messages IS 'Audit trail of all inbound and outbound messages';
COMMENT ON COLUMN bot_messages.direction IS 'Message direction: inbound (from user) or outbound (from bot)';
COMMENT ON COLUMN bot_messages.text IS 'Message text content';
COMMENT ON COLUMN bot_messages.raw IS 'Full raw payload from Meta or sent to Meta';
```

**Field Descriptions:**

| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `id` | UUID | Unique message ID | `660e8400-e29b-41d4-a716-446655440000` |
| `lead_id` | UUID | References bot_leads.id | `550e8400-e29b-41d4-a716-446655440000` |
| `direction` | TEXT | inbound or outbound | `inbound`, `outbound` |
| `text` | TEXT | Message content | `Do you have next Wednesday?` |
| `raw` | JSONB | Full Meta payload | `{"sender": {"id": "123"}, ...}` |
| `created_at` | TIMESTAMPTZ | Message timestamp | `2026-02-09 10:15:00+00` |

Click "Run" to execute.

#### Table 4: bot_message_dedupe

**Purpose**: Prevents duplicate message processing (Meta retry handling)

```sql
-- Create bot_message_dedupe table
CREATE TABLE bot_message_dedupe (
  message_id TEXT PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES bot_leads(id) ON DELETE CASCADE,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes
CREATE INDEX idx_bot_dedupe_lead_processed ON bot_message_dedupe(lead_id, processed_at DESC);
CREATE INDEX idx_bot_dedupe_processed_at ON bot_message_dedupe(processed_at);

-- Add comments
COMMENT ON TABLE bot_message_dedupe IS 'Prevents duplicate message processing when Meta retries webhooks';
COMMENT ON COLUMN bot_message_dedupe.message_id IS 'Meta message ID (mid) or fallback deduplication key';
```

**Field Descriptions:**

| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `message_id` | TEXT | Meta mid or dedupe key | `mid.123456789` |
| `lead_id` | UUID | References bot_leads.id | `550e8400-e29b-41d4-a716-446655440000` |
| `processed_at` | TIMESTAMPTZ | When processed | `2026-02-09 10:15:00+00` |

Click "Run" to execute.

#### Table 5: add_ons (Optional - for dynamic pricing)

**Purpose**: Stores service add-ons with pricing

```sql
-- Create add_ons table
CREATE TABLE add_ons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  addon_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_cents INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create index
CREATE INDEX idx_add_ons_active ON add_ons(is_active);

-- Add comments
COMMENT ON TABLE add_ons IS 'Service add-ons with dynamic pricing';
COMMENT ON COLUMN add_ons.addon_key IS 'Unique key for code reference (e.g., dog_hair)';
COMMENT ON COLUMN add_ons.price_cents IS 'Price in cents (e.g., 5000 = $50.00)';

-- Insert example add-ons
INSERT INTO add_ons (addon_key, name, price_cents, is_active) VALUES
  ('dog_hair', 'Dog Hair Removal', 5000, true),
  ('wax', 'Wax & Polish', 7500, true),
  ('interior_shampoo', 'Interior Shampoo', 5000, true);
```

**Field Descriptions:**

| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `id` | UUID | Unique identifier | `770e8400-e29b-41d4-a716-446655440000` |
| `is_active` | BOOLEAN | Show in bot responses | `true` |
| `addon_key` | TEXT | Code reference key | `dog_hair` |
| `name` | TEXT | Display name | `Dog Hair Removal` |
| `price_cents` | INT | Price in cents | `5000` ($50.00) |
| `created_at` | TIMESTAMPTZ | Creation time | `2026-02-09 10:00:00+00` |

Click "Run" to execute.

### Step 2.3: Create Triggers for Auto-Update

```sql
-- Create function to auto-update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to bot_leads
CREATE TRIGGER update_bot_leads_updated_at 
  BEFORE UPDATE ON bot_leads
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to bot_convo_state
CREATE TRIGGER update_bot_convo_state_updated_at 
  BEFORE UPDATE ON bot_convo_state
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();
```

Click "Run" to execute.

### Step 2.4: Enable Row Level Security (RLS)

```sql
-- Enable RLS on all tables
ALTER TABLE bot_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_convo_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_message_dedupe ENABLE ROW LEVEL SECURITY;
ALTER TABLE add_ons ENABLE ROW LEVEL SECURITY;

-- Create policies (service_role only - worker uses service_role key)
CREATE POLICY "Service role full access" ON bot_leads 
  FOR ALL 
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON bot_convo_state 
  FOR ALL 
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON bot_messages 
  FOR ALL 
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON bot_message_dedupe 
  FOR ALL 
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access" ON add_ons 
  FOR ALL 
  USING (auth.role() = 'service_role');
```

Click "Run" to execute.

### Step 2.5: Get Supabase Credentials

1. In Supabase dashboard, go to **Settings** → **API**
2. Copy these values (you'll need them later):
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: `eyJhbGc...` (not needed for this bot)
   - **service_role key**: `eyJhbGc...` ⚠️ **KEEP SECRET!**

**Save these in a secure note:**
```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
```

---

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
    console.log('\n✅ Refresh Token:', tokens.refresh_token);
    
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

## PART 3: Meta (Facebook/Instagram) Setup (20 minutes)

### Step 3.1: Create Meta App

1. Go to [developers.facebook.com](https://developers.facebook.com/)
2. Click **My Apps** → **Create App**
3. Select **Business** as app type
4. Click **Next**
5. Fill in app details:
   - **App Name**: `Booking Bot` (or your choice)
   - **App Contact Email**: Your email
   - **Business Account**: Select or create one
6. Click **Create App**
7. You'll be redirected to the app dashboard

### Step 3.2: Add Messenger Product

1. In your app dashboard, find **Add Products**
2. Find **Messenger** and click **Set Up**
3. Messenger settings page will open

### Step 3.3: Get App Secret

1. In left sidebar, go to **Settings** → **Basic**
2. Find **App Secret** field
3. Click **Show** and copy the value
4. **Save this securely:**
```
META_APP_SECRET=abc123def456...
```

### Step 3.4: Create Verify Token

This is a random string you create yourself for webhook verification.

**Generate a secure random string:**
```bash
# On Mac/Linux
openssl rand -hex 32

# Or use any random string generator
# Example: my_super_secret_verify_token_2026
```

**Save this securely:**
```
META_VERIFY_TOKEN=your_random_string_here
```

### Step 3.5: Connect Facebook Page

1. In Messenger settings, scroll to **Access Tokens**
2. Click **Add or Remove Pages**
3. Select your Facebook Page (or create one if needed)
4. Grant all requested permissions
5. Click **Done**

### Step 3.6: Generate Page Access Token

1. Still in **Access Tokens** section
2. Find your page in the list
3. Click **Generate Token**
4. Copy the token (starts with `EAAA...`)
5. **Save this securely:**
```
FB_PAGE_ACCESS_TOKEN=EAAAxxxxxxxxxxxxxxx...
```

⚠️ **Important**: This token expires! For production, you should:
- Generate a permanent token (requires app review)
- Or regenerate periodically

### Step 3.7: Subscribe to Page Events

1. In **Access Tokens** section
2. Find your page
3. Click **Subscribe to Events**
4. This will be configured after deployment

**Summary of Meta credentials to save:**
```
META_APP_SECRET=abc123def456...
META_VERIFY_TOKEN=your_random_string_here
FB_PAGE_ACCESS_TOKEN=EAAAxxxxxxxxxxxxxxx...
```

---

## PART 4: Google Calendar API Setup (25 minutes)

### Step 4.1: Create Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Click **Select a project** → **New Project**
3. Fill in:
   - **Project name**: `booking-bot` (or your choice)
   - **Location**: Leave as default
4. Click **Create**
5. Wait for project creation (30 seconds)
6. Select your new project from the dropdown

### Step 4.2: Enable Google Calendar API

1. In left sidebar, go to **APIs & Services** → **Library**
2. Search for `Google Calendar API`
3. Click on **Google Calendar API**
4. Click **Enable**
5. Wait for API to enable (10 seconds)

### Step 4.3: Create OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Select **External** user type
3. Click **Create**
4. Fill in **App information**:
   - **App name**: `Booking Bot`
   - **User support email**: Your email
   - **Developer contact**: Your email
5. Click **Save and Continue**
6. **Scopes**: Click **Add or Remove Scopes**
   - Search for `calendar`
   - Check `https://www.googleapis.com/auth/calendar`
   - Click **Update**
   - Click **Save and Continue**
7. **Test users**: Click **Add Users**
   - Add your Gmail address
   - Click **Add**
   - Click **Save and Continue**
8. Click **Back to Dashboard**

### Step 4.4: Create OAuth Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Fill in:
   - **Application type**: Web application
   - **Name**: `Booking Bot OAuth`
   - **Authorized redirect URIs**: Click **Add URI**
     - Add: `http://localhost:3000/oauth2callback`
4. Click **Create**
5. A popup shows your credentials:
   - **Client ID**: Copy this (starts with numbers, ends with `.apps.googleusercontent.com`)
   - **Client Secret**: Copy this (starts with `GOCSPX-`)
6. Click **OK**

**Save these securely:**
```
GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
```

### Step 4.5: Get Refresh Token

Now we need to authorize the bot to access your calendar.

**Create a file `get-google-token.js` in your project root:**

```javascript
const http = require('http');
const url = require('url');
const { exec } = require('child_process');

// REPLACE THESE with your values from Step 4.4
const CLIENT_ID = 'YOUR_CLIENT_ID_HERE';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET_HERE';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

// Step 1: Generate authorization URL
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${REDIRECT_URI}&` +
  `response_type=code&` +
  `scope=https://www.googleapis.com/auth/calendar&` +
  `access_type=offline&` +
  `prompt=consent`;

console.log('\n🔐 STEP 1: Authorize the app\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n');

// Try to open browser automatically
const platform = process.platform;
const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
exec(`${command} "${authUrl}"`);

// Step 2: Start local server to receive callback
const server = http.createServer(async (req, res) => {
  const queryObject = url.parse(req.url, true).query;
  const code = queryObject.code;

  if (code) {
    console.log('\n✅ Authorization code received!\n');
    console.log('🔄 Exchanging code for tokens...\n');

    try {
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

      if (tokens.refresh_token) {
        console.log('✅ SUCCESS! Copy this refresh token:\n');
        console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
        console.log('\n');
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: Arial; padding: 50px; text-align: center;">
              <h1 style="color: green;">✅ Success!</h1>
              <p>Check your terminal for the refresh token.</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
      } else {
        console.error('❌ Error: No refresh token received');
        console.error('Response:', tokens);
        res.end('Error: No refresh token received. Check terminal.');
      }
    } catch (error) {
      console.error('❌ Error exchanging code:', error);
      res.end('Error: ' + error.message);
    }

    server.close();
  }
});

server.listen(3000, () => {
  console.log('🌐 Server listening on http://localhost:3000');
  console.log('⏳ Waiting for authorization...\n');
});
```

**Run the script:**

```bash
node get-google-token.js
```

**What happens:**
1. Browser opens to Google authorization page
2. Sign in with your Google account
3. Click **Allow** to grant calendar access
4. Browser redirects to localhost
5. Terminal shows your refresh token

**Copy the refresh token and save:**
```
GOOGLE_REFRESH_TOKEN=1//0gxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Step 4.6: Get Calendar ID

1. Open [Google Calendar](https://calendar.google.com/)
2. On the left, find your calendar (usually your email)
3. Click the three dots next to it → **Settings and sharing**
4. Scroll down to **Integrate calendar**
5. Copy the **Calendar ID** (usually your email address)

**Save this:**
```
GOOGLE_CALENDAR_ID=your-email@gmail.com
```

**Summary of Google credentials to save:**
```
GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
GOOGLE_REFRESH_TOKEN=1//0gxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GOOGLE_CALENDAR_ID=your-email@gmail.com
```

---

## PART 5: DeepSeek AI Setup (5 minutes)

### Step 5.1: Create DeepSeek Account

1. Go to [platform.deepseek.com](https://platform.deepseek.com/)
2. Click **Sign Up** or **Login**
3. Complete registration

### Step 5.2: Add Credits

1. Go to **Billing** or **Credits**
2. Add credits (minimum $5 recommended)
3. Pricing: ~$0.14 per 1M input tokens, ~$0.28 per 1M output tokens
4. Typical usage: $1-2 per 1000 conversations

### Step 5.3: Generate API Key

1. Go to **API Keys** section
2. Click **Create API Key**
3. Give it a name: `Booking Bot`
4. Click **Create**
5. Copy the key (starts with `sk-`)

⚠️ **Important**: Save immediately, you can't see it again!

**Save this:**
```
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## PART 6: Resend Email Setup (5 minutes) - OPTIONAL

This is optional. If you skip this, booking confirmations won't be emailed.

### Step 6.1: Create Resend Account

1. Go to [resend.com](https://resend.com/)
2. Click **Sign Up**
3. Verify your email

### Step 6.2: Add Domain (or use test mode)

**Option A: Use test mode (100 emails/day to your email only)**
- No setup needed
- Emails only go to your verified email

**Option B: Add your domain (unlimited emails)**
1. Go to **Domains** → **Add Domain**
2. Enter your domain: `yourdomain.com`
3. Add DNS records as shown
4. Wait for verification (5-60 minutes)

### Step 6.3: Generate API Key

1. Go to **API Keys**
2. Click **Create API Key**
3. Name: `Booking Bot`
4. Click **Create**
5. Copy the key (starts with `re_`)

**Save this:**
```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

If you skip Resend, the bot will still work but won't send email notifications.

---

## PART 7: Configure Cloudflare Worker (10 minutes)

### Step 7.1: Edit wrangler.toml

Open `wrangler.toml` and update the `[vars]` section with your business details:

```toml
name = "booking-bot-webhook"  # Change this to your preferred worker name
main = "src/index.ts"
compatibility_date = "2026-02-03"

[vars]
# CUSTOMIZE THESE FOR YOUR BUSINESS
GOOGLE_TIMEZONE = "America/Denver"     # Your timezone (see list below)
SERVICE_NAME = "Full Detail"           # Your service name
SERVICE_PRICE = "$229"                 # Your service price
```

**Common Timezones:**
- `America/New_York` - Eastern Time
- `America/Chicago` - Central Time
- `America/Denver` - Mountain Time
- `America/Los_Angeles` - Pacific Time
- `America/Phoenix` - Arizona (no DST)
- `Europe/London` - UK
- `Europe/Paris` - Central Europe
- `Australia/Sydney` - Sydney

[Full timezone list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

### Step 7.2: Login to Cloudflare

```bash
npx wrangler login
```

This opens a browser to authorize Wrangler CLI.

### Step 7.3: Set Secrets

Now we'll add all the credentials you saved earlier.

**Run each command and paste the value when prompted:**

```bash
# Meta/Facebook credentials
npx wrangler secret put META_VERIFY_TOKEN
# Paste: your_random_string_here

npx wrangler secret put META_APP_SECRET
# Paste: abc123def456...

npx wrangler secret put FB_PAGE_ACCESS_TOKEN
# Paste: EAAAxxxxxxxxxxxxxxx...

# Supabase credentials
npx wrangler secret put SUPABASE_URL
# Paste: https://xxxxx.supabase.co

npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# Paste: eyJhbGc...

# Google Calendar credentials
npx wrangler secret put GOOGLE_CALENDAR_ID
# Paste: your-email@gmail.com

npx wrangler secret put GOOGLE_CLIENT_ID
# Paste: 123456789-abc.apps.googleusercontent.com

npx wrangler secret put GOOGLE_CLIENT_SECRET
# Paste: GOCSPX-xxxxxxxxxxxxxxxx

npx wrangler secret put GOOGLE_REFRESH_TOKEN
# Paste: 1//0gxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# DeepSeek AI
npx wrangler secret put DEEPSEEK_API_KEY
# Paste: sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Resend (optional - skip if not using)
npx wrangler secret put RESEND_API_KEY
# Paste: re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Verify secrets were set:**
```bash
npx wrangler secret list
```

You should see all secret names (not values) listed.

---

## PART 8: Deploy to Cloudflare (5 minutes)

### Step 8.1: Deploy Worker

```bash
npm run deploy
```

**Expected output:**
```
⛅️ wrangler 4.63.0
───────────────────
Total Upload: 109.31 KiB / gzip: 21.40 KiB
Your Worker has access to the following bindings:
Binding                                     Resource
env.GOOGLE_TIMEZONE ("America/Denver")      Environment Variable
env.SERVICE_NAME ("Full Detail")            Environment Variable
env.SERVICE_PRICE ("$229")                  Environment Variable

Uploaded booking-bot-webhook (5.99 sec)
Deployed booking-bot-webhook triggers (3.11 sec)
  https://booking-bot-webhook.your-subdomain.workers.dev
Current Version ID: 87a06472-d770-4ee7-ab56-5c081bec947e
```

**Copy your worker URL:**
```
https://booking-bot-webhook.your-subdomain.workers.dev
```

### Step 8.2: Test Health Endpoint

```bash
curl https://booking-bot-webhook.your-subdomain.workers.dev/health
```

**Expected response:**
```json
{"status":"ok"}
```

✅ If you see this, your worker is deployed successfully!

---

## PART 9: Configure Meta Webhook (10 minutes)

### Step 9.1: Add Webhook URL

1. Go back to [developers.facebook.com](https://developers.facebook.com/)
2. Select your app
3. Go to **Messenger** → **Settings**
4. Scroll to **Webhooks** section
5. Click **Add Callback URL**

**Fill in:**
- **Callback URL**: `https://booking-bot-webhook.your-subdomain.workers.dev/webhook`
- **Verify Token**: (your `META_VERIFY_TOKEN` from earlier)

6. Click **Verify and Save**

✅ If successful, you'll see "Complete" status

❌ If it fails:
- Check your worker is deployed (`curl` the health endpoint)
- Verify the verify token matches exactly
- Check worker logs: `npm run tail`

### Step 9.2: Subscribe to Webhook Fields

Still in the Webhooks section:

1. Find your page in the list
2. Click **Add Subscriptions**
3. Check these fields:
   - ✅ `messages`
   - ✅ `messaging_postbacks`
   - ✅ `message_deliveries` (optional)
   - ✅ `message_reads` (optional)
4. Click **Save**

### Step 9.3: Subscribe Page to App

1. Scroll to **Access Tokens** section
2. Find your page
3. Click **Subscribe** (if not already subscribed)

---

## PART 10: Test the Bot (5 minutes)

### Step 10.1: Send Test Message

1. Open Facebook
2. Go to your Facebook Page
3. Click **Send Message** (or open Messenger)
4. Send: `Hello`

**Expected bot response:**
```
Hey! 👋 I can get you in for a Full Detail — it's $229. 
I've got Saturday at 12:30 PM available. Does that work, 
or tell me what date works best for you?
```

### Step 10.2: Test Booking Flow

Continue the conversation:

**You:** `Do you have next Wednesday?`

**Bot:** `Yep — I can do Wednesday, February 19th at 12:00 PM or 3:00 PM. Does one work, or what day would be better?`

**You:** `3:00`

**Bot:** `Awesome — holding Wednesday at 3:00 PM for you. What's the service address?`

**You:** `123 Main St, Salt Lake City, UT`

**Bot:** `Perfect — and what's the best phone number to reach you?`

**You:** `801-555-1234`

**Bot:** `Perfect — you're all set ✅ We'll see you Wednesday at 3:00 PM!`

### Step 10.3: Verify in Google Calendar

1. Open [Google Calendar](https://calendar.google.com/)
2. Check Wednesday, February 19th at 3:00 PM
3. You should see a new event with customer details

### Step 10.4: Verify in Supabase

1. Open Supabase dashboard
2. Go to **Table Editor** → `bot_leads`
3. You should see a new lead with:
   - `status`: `booked`
   - `booked_event_id`: (Google Calendar event ID)
   - `customer_address`: `123 Main St, Salt Lake City, UT`
   - `customer_phone`: `801-555-1234`
   - `bot_enabled`: `false` (bot won't respond anymore)

---

## Customization

### Change Service Details

Edit `wrangler.toml`:

```toml
[vars]
GOOGLE_TIMEZONE = "America/New_York"
SERVICE_NAME = "Premium Wash"
SERVICE_PRICE = "$150"
```

Redeploy: `npm run deploy`

### Add Service Add-ons

In Supabase SQL Editor:

```sql
INSERT INTO add_ons (addon_key, name, price_cents, is_active) VALUES
  ('wax', 'Wax & Polish', 7500, true),
  ('interior_shampoo', 'Interior Shampoo', 5000, true),
  ('engine_clean', 'Engine Bay Cleaning', 3500, true);
```

Bot will automatically include these in FAQ responses.

### Modify Conversation Flow

Edit `src/flow.ts` to customize:
- Message templates and variations
- Slot offering logic
- Question detection patterns
- Response tone and style

### Adjust Slot Generation

Edit `src/google.ts` → `generateTwoSlots()`:
- Change slot duration (default: 3 hours)
- Modify available hours (default: 9 AM - 5 PM)
- Adjust buffer times between appointments

---

## Monitoring and Logs

### View Real-Time Logs

```bash
npm run tail
```

This shows all worker logs in real-time.

### View Supabase Logs

1. Supabase dashboard → **Logs**
2. Select **Postgres Logs** or **API Logs**

### View Meta Webhook Logs

1. Meta App dashboard
2. **Messenger** → **Settings** → **Webhooks**
3. Click **Test** to send test events

---

## Troubleshooting

### Bot Not Responding

**Check 1: Webhook configured correctly**
```bash
# Test health endpoint
curl https://your-worker.workers.dev/health
```

**Check 2: Verify secrets**
```bash
npx wrangler secret list
```

**Check 3: View logs**
```bash
npm run tail
```

**Check 4: Meta webhook status**
- Go to Meta App → Messenger → Settings → Webhooks
- Verify "Complete" status

### Calendar Events Not Creating

**Check 1: Verify Google credentials**
- Ensure refresh token is valid
- Check calendar ID is correct
- Verify API is enabled in Google Cloud Console

**Check 2: Test calendar access**
- Open Google Calendar
- Verify you can create events manually

**Check 3: Check logs for errors**
```bash
npm run tail
```

Look for Google API errors.

### Database Errors

**Check 1: Verify Supabase credentials**
- Test connection from Supabase dashboard
- Verify service role key is correct

**Check 2: Check RLS policies**
```sql
-- In Supabase SQL Editor
SELECT * FROM bot_leads LIMIT 1;
```

Should return data (or empty if no leads yet).

**Check 3: View Supabase logs**
- Dashboard → Logs → Postgres Logs

### DeepSeek API Errors

**Check 1: Verify API key**
- Check key is valid in DeepSeek dashboard
- Verify you have credits

**Check 2: Bot falls back gracefully**
- If DeepSeek fails, bot uses deterministic responses
- Check logs for DeepSeek errors

---

## Environment Variables Reference

### Required Secrets (via `wrangler secret put`)

| Variable | Purpose | Where to Get | Example |
|----------|---------|--------------|---------|
| `META_VERIFY_TOKEN` | Webhook verification | Create your own random string | `my_verify_token_12345` |
| `META_APP_SECRET` | Signature verification | Meta App → Settings → Basic | `abc123def456...` |
| `FB_PAGE_ACCESS_TOKEN` | Send messages | Meta App → Messenger → Settings | `EAAAxxxxxxx...` |
| `SUPABASE_URL` | Database connection | Supabase → Settings → API | `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Database auth | Supabase → Settings → API | `eyJhbGc...` |
| `GOOGLE_CALENDAR_ID` | Calendar to use | Google Calendar → Settings | `your-email@gmail.com` |
| `GOOGLE_CLIENT_ID` | OAuth credentials | Google Cloud Console | `123-abc.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | OAuth credentials | Google Cloud Console | `GOCSPX-...` |
| `GOOGLE_REFRESH_TOKEN` | Calendar access | OAuth flow (see setup) | `1//0g...` |
| `DEEPSEEK_API_KEY` | AI responses | DeepSeek Platform | `sk-...` |
| `RESEND_API_KEY` | Email notifications | Resend Dashboard (optional) | `re_...` |

### Public Variables (in `wrangler.toml`)

| Variable | Purpose | Example |
|----------|---------|---------|
| `GOOGLE_TIMEZONE` | Slot generation timezone | `America/Denver` |
| `SERVICE_NAME` | Your service name | `Full Detail` |
| `SERVICE_PRICE` | Your service price | `$229` |

---

## Features in Detail

### Intelligent Date Parsing

Supports natural language:
- "next Wednesday" → 7+ days away (next week)
- "this Friday" → upcoming in current week (0-6 days)
- "tomorrow" → next day
- "the 17th" → specific date number
- "February 15" → month + date

### Smart Time Matching

Recognizes multiple formats:
- "3" → 3:00 PM
- "3:00" → 3:00 PM
- "3pm" → 3:00 PM
- "3:00 PM" → 3:00 PM
- "noon" → 12:00 PM
- "1" or "2" → First or second slot

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

---

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
├── wrangler.toml         # Cloudflare config
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
└── README.md             # This file
```

---

## Support

For issues or questions:
1. Check logs: `npm run tail`
2. Review Supabase logs in dashboard
3. Check Meta webhook logs in developer console
4. Verify all secrets are set correctly: `npx wrangler secret list`

---

## License

MIT

---

## Credits

Built with:
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Supabase](https://supabase.com/)
- [DeepSeek AI](https://www.deepseek.com/)
- [Google Calendar API](https://developers.google.com/calendar)
- [Resend](https://resend.com/)

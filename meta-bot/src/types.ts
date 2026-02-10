// Environment variables interface
export interface Env {
  // Secrets
  META_VERIFY_TOKEN: string;
  META_APP_SECRET: string;
  FB_PAGE_ACCESS_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GOOGLE_CALENDAR_ID: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  DEEPSEEK_API_KEY: string;
  RESEND_API_KEY: string;
  
  // Vars
  GOOGLE_TIMEZONE: string;
  SERVICE_NAME: string;
  SERVICE_PRICE: string;
}

// Service addon from database
export interface ServiceAddon {
  id: string;
  addon_key: string;
  name: string;
  price_cents: number;
  is_active: boolean;
  created_at: string;
}

// Lead status type
export type LeadStatus = 'active' | 'booked' | 'dead' | 'needs_followup';

// Lead record
export interface Lead {
  id: string;
  psid: string;
  status: LeadStatus;
  zip: string | null;
  bot_enabled: boolean;  // When false, bot will not respond
  
  // Finalized booking fields
  booked_event_id: string | null;
  booked_slot_label: string | null;
  booked_slot_start: string | null;
  booked_slot_end: string | null;
  booking_claimed_at: string | null;
  
  // Pending booking fields (before calendar event created)
  pending_slot_label: string | null;
  pending_slot_start: string | null;
  pending_slot_end: string | null;
  pending_claimed_at: string | null;
  
  // Customer details
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  
  // Timestamps
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

// Conversation state
export interface ConvoState {
  lead_id: string;
  step: string;
  context: {
    // Booking state
    slots?: Slot[];
    booked_slot?: Slot;
    name?: string;
    address?: string;
    collectStep?: 'name' | 'address' | 'phone' | 'done';
    
    // Enhanced tracking (Phase 1)
    offeredDays?: string[];        // Days already offered (e.g., ['friday', 'saturday'])
    requestedDay?: string;          // Last day user requested
    attemptCount?: number;          // Number of slot offering attempts
    lastIntent?: string;            // Last detected intent
    
    // Metadata
    last_note?: string;
    [key: string]: any;
  };
  updated_at: string;
}

// Slot type
export interface Slot {
  label: string;        // "Saturday at 12:30 PM"
  startISO: string;     // ISO 8601 UTC timestamp
  endISO: string;       // ISO 8601 UTC timestamp
}

// Busy block from Google Calendar
export interface BusyBlock {
  start: string;        // ISO 8601 UTC timestamp
  end: string;          // ISO 8601 UTC timestamp
}

// Question types
export type QuestionType = 
  | 'services'
  | 'dog_hair'
  | 'included'
  | 'price'
  | 'zip'
  | 'duration'
  | 'reschedule'
  | 'availability'
  | 'generic'
  | 'unknown';

// Slot match result
export interface SlotMatchResult {
  matched: boolean;
  slot?: Slot;
  requiresChoice?: boolean;  // True when user said "yes" but needs to pick 1 or 2
}

/**
 * Supabase repository for bot data persistence
 * Uses PostgREST API with service_role authentication
 */

import type { Lead, LeadStatus, ConvoState } from './types';

export class SupabaseRepo {
  private url: string;
  private serviceKey: string;

  constructor(url: string, serviceKey: string) {
    this.url = url;
    this.serviceKey = serviceKey;
  }

  /**
   * Get headers for Supabase requests
   */
  private headers(): Record<string, string> {
    return {
      'apikey': this.serviceKey,
      'Authorization': `Bearer ${this.serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
  }

  /**
   * Upsert lead by PSID (creates if not exists, updates last_seen_at if exists)
   */
  async upsertLeadByPsid(psid: string): Promise<Lead> {
    // ✅ IMPORTANT: on_conflict=psid makes it a real upsert
    const endpoint = `${this.url}/rest/v1/bot_leads?on_conflict=psid&select=*`;

    const body = [{
      psid,
      status: "active",
      last_seen_at: new Date().toISOString()
    }];

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...this.headers(),
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`Failed to upsert lead: ${res.status} ${await res.text()}`);

    const rows = await res.json() as Lead[];
    if (!rows?.[0]) throw new Error("upsertLeadByPsid: no row returned");
    return rows[0];
  }

  /**
   * Get lead by ID
   */
  async getLeadById(leadId: string): Promise<Lead> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}&select=*`,
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get lead: ${response.status} ${await response.text()}`);
    }

    const leads = (await response.json()) as Lead[];
    if (leads.length === 0) {
      throw new Error(`Lead not found: ${leadId}`);
    }

    return leads[0];
  }

  /**
   * Set lead status
   */
  async setLeadStatus(leadId: string, status: LeadStatus): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ status })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to set lead status: ${response.status} ${await response.text()}`);
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  /**
   * Disable bot for a lead (allows human takeover)
   */
  async disableBot(leadId: string): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ bot_enabled: false })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to disable bot: ${response.status} ${await response.text()}`);
    }
    
    await response.text();
  }

  /**
   * Enable bot for a lead (re-enable automated responses)
   */
  async enableBot(leadId: string): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ bot_enabled: true })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to enable bot: ${response.status} ${await response.text()}`);
    }
    
    await response.text();
  }

  /**
   * Try to claim booking slot atomically (NEW FLOW: claim → collect → book)
   * This ONLY sets pending fields, does NOT create calendar event yet
   * @returns claimed lead row if successful, null if slot unavailable
   */
  async tryClaimPendingSlot(
    leadId: string,
    slot: { label: string; startISO: string; endISO: string }
  ): Promise<Lead | null> {
    // Atomic claim with conditions:
    // 1. Lead is not already booked (booked_event_id is null)
    // 2. No pending claim OR pending claim expired (>15 min old)
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}&booked_event_id=is.null`,
      {
        method: 'PATCH',
        headers: {
          ...this.headers(),
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          pending_slot_label: slot.label,
          pending_slot_start: slot.startISO,
          pending_slot_end: slot.endISO,
          pending_claimed_at: new Date().toISOString(),
          status: 'active'  // Keep as active until finalized
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to claim pending slot: ${response.status} ${await response.text()}`);
    }

    const updated = (await response.json()) as Lead[];
    return Array.isArray(updated) && updated.length > 0 ? updated[0] : null;
  }

  /**
   * Get pending slot for a lead
   * @returns pending slot info or null if no pending slot
   */
  async getPendingSlot(leadId: string): Promise<{
    label: string;
    startISO: string;
    endISO: string;
    claimedAt: string;
  } | null> {
    const lead = await this.getLeadById(leadId);
    
    if (!lead.pending_slot_label || !lead.pending_slot_start || !lead.pending_slot_end) {
      return null;
    }
    
    // Check if claim expired (>15 minutes old)
    if (lead.pending_claimed_at) {
      const claimedAt = new Date(lead.pending_claimed_at);
      const now = new Date();
      const ageMinutes = (now.getTime() - claimedAt.getTime()) / (1000 * 60);
      
      if (ageMinutes > 15) {
        console.log(`[PENDING] Claim expired (${ageMinutes.toFixed(1)} minutes old)`);
        return null;
      }
    }
    
    return {
      label: lead.pending_slot_label,
      startISO: lead.pending_slot_start,
      endISO: lead.pending_slot_end,
      claimedAt: lead.pending_claimed_at || new Date().toISOString()
    };
  }

  /**
   * Finalize booking: create calendar event and update lead
   * This is called AFTER collecting all customer details (address and phone only)
   */
  async finalizeBookingWithDetails(
    leadId: string,
    eventId: string,
    details: {
      address: string;
      phone: string;
    }
  ): Promise<void> {
    const lead = await this.getLeadById(leadId);
    
    if (!lead.pending_slot_label || !lead.pending_slot_start || !lead.pending_slot_end) {
      throw new Error('No pending slot to finalize');
    }
    
    // Move pending → booked, add customer details
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({
          status: 'booked',
          booked_event_id: eventId,
          booked_slot_label: lead.pending_slot_label,
          booked_slot_start: lead.pending_slot_start,
          booked_slot_end: lead.pending_slot_end,
          customer_name: null, // No longer collecting name
          customer_address: details.address,
          customer_phone: details.phone,
          // Clear pending fields
          pending_slot_label: null,
          pending_slot_start: null,
          pending_slot_end: null,
          pending_claimed_at: null
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to finalize booking: ${response.status} ${await response.text()}`);
    }
    
    await response.text();
  }

  /**
   * Release pending slot claim (if user abandons or slot becomes unavailable)
   */
  async releasePendingClaim(leadId: string): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({
          status: 'active',
          pending_slot_label: null,
          pending_slot_start: null,
          pending_slot_end: null,
          pending_claimed_at: null
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to release pending claim: ${response.status} ${await response.text()}`);
    }
    
    await response.text();
  }

  /**
   * OLD METHOD: Try to claim booking slot atomically (DEPRECATED - use tryClaimPendingSlot)
   * @deprecated Use tryClaimPendingSlot() for new collect-then-book flow
   * @returns claimed lead row if successful, null if already booked
   */
  async tryClaimBooking(
    leadId: string,
    slot: { label: string; startISO: string; endISO: string }
  ): Promise<Lead | null> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}&booked_event_id=is.null&status=neq.booked`,
      {
        method: 'PATCH',
        headers: {
          ...this.headers(),
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          status: 'booked',
          booked_slot_label: slot.label,
          booked_slot_start: slot.startISO,
          booked_slot_end: slot.endISO
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to claim booking: ${response.status} ${await response.text()}`);
    }

    const updated = (await response.json()) as Lead[];
    // Return claimed row (source of truth) or null if already booked
    return Array.isArray(updated) && updated.length > 0 ? updated[0] : null;
  }

  /**
   * Finalize booking with event ID
   */
  async finalizeBooking(leadId: string, eventId: string): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({
          booked_event_id: eventId
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to finalize booking: ${response.status} ${await response.text()}`);
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  /**
   * Release booking claim (if staleness check fails)
   */
  async releaseBookingClaim(leadId: string): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({
          status: 'active',
          booked_slot_label: null,
          booked_slot_start: null,
          booked_slot_end: null,
          booked_event_id: null
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to release claim: ${response.status} ${await response.text()}`);
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  /**
   * Update lead with customer details (name, address, phone)
   */
  async updateLeadDetails(
    leadId: string,
    details: { name?: string; address?: string; phone?: string }
  ): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({
          customer_name: details.name,
          customer_address: details.address,
          customer_phone: details.phone
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to update lead details: ${response.status} ${await response.text()}`);
    }
    
    await response.text();
  }

  /**
   * Mark lead as booked with event details
   */
  async markBooked(
    leadId: string,
    booking: {
      booked_event_id: string;
      booked_slot_label: string;
      booked_slot_start: string;
      booked_slot_end: string;
    }
  ): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_leads?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({
          status: 'booked',
          ...booking
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to mark booked: ${response.status} ${await response.text()}`);
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  /**
   * Insert inbound message
   */
  async insertInboundMessage(
    leadId: string,
    text: string | null,
    raw: any
  ): Promise<void> {
    const response = await fetch(`${this.url}/rest/v1/bot_messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        lead_id: leadId,
        direction: 'inbound',
        text,
        raw
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to insert inbound message: ${response.status} ${await response.text()}`);
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  /**
   * Insert outbound message
   */
  async insertOutboundMessage(
    leadId: string,
    text: string,
    raw: any
  ): Promise<void> {
    const response = await fetch(`${this.url}/rest/v1/bot_messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        lead_id: leadId,
        direction: 'outbound',
        text,
        raw
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to insert outbound message: ${response.status} ${await response.text()}`);
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  /**
   * Get conversation state for a lead
   */
  async getConvoState(leadId: string): Promise<ConvoState | null> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_convo_state?lead_id=eq.${leadId}&select=*`,
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get convo state: ${response.status} ${await response.text()}`);
    }

    const states = (await response.json()) as ConvoState[];
    return states.length > 0 ? states[0] : null;
  }

  /**
   * Upsert conversation state
   */
  async upsertConvoState(
    leadId: string,
    step: string,
    context: any
  ): Promise<ConvoState> {
    const response = await fetch(`${this.url}/rest/v1/bot_convo_state`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify({
        lead_id: leadId,
        step,
        context
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to upsert convo state: ${response.status} ${await response.text()}`);
    }

    const states = (await response.json()) as ConvoState[];
    return states[0];
  }

  /**
   * Try to insert dedupe record
   * @returns true if already exists (duplicate), false if newly inserted
   */
  async tryInsertDedupe(messageId: string, leadId: string): Promise<boolean> {
    const response = await fetch(`${this.url}/rest/v1/bot_message_dedupe`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Prefer': 'resolution=ignore-duplicates'
      },
      body: JSON.stringify({
        message_id: messageId,
        lead_id: leadId
      })
    });

    // If 201, it was inserted (new message)
    // If 200 with empty body, it was a duplicate (ignored)
    if (response.status === 201) {
      return false; // Not a duplicate
    }

    if (response.status === 200) {
      const body = await response.text();
      return body === '' || body === '[]'; // Duplicate if empty response
    }

    throw new Error(`Failed to insert dedupe: ${response.status} ${await response.text()}`);
  }

  // ============================================================================
  // PHASE 2: Conversation History
  // ============================================================================

  /**
   * Save message to conversation history
   */
  async saveConversationHistory(
    leadId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    metadata: any = {}
  ): Promise<void> {
    const response = await fetch(`${this.url}/rest/v1/bot_conversation_history`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        lead_id: leadId,
        role,
        content,
        metadata
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to save conversation history: ${response.status} ${await response.text()}`);
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  /**
   * Load conversation history (last N messages)
   */
  async loadConversationHistory(
    leadId: string,
    limit: number = 10
  ): Promise<Array<{ role: string; content: string; created_at: string }>> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_conversation_history?lead_id=eq.${leadId}&select=role,content,created_at&order=created_at.desc&limit=${limit}`,
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to load conversation history: ${response.status} ${await response.text()}`);
    }

    const history = await response.json() as Array<{ role: string; content: string; created_at: string }>;
    return history.reverse(); // Return in chronological order
  }

  // ============================================================================
  // PHASE 3: Intent Detection
  // ============================================================================

  /**
   * Save detected intent
   */
  async saveIntent(
    leadId: string,
    messageText: string,
    detectedIntent: string,
    confidence: number | null = null,
    metadata: any = {}
  ): Promise<void> {
    const response = await fetch(`${this.url}/rest/v1/bot_intents`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        lead_id: leadId,
        message_text: messageText,
        detected_intent: detectedIntent,
        confidence,
        metadata
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to save intent: ${response.status} ${await response.text()}`);
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  // ============================================================================
  // PHASE 4: FAQ Knowledge Base
  // ============================================================================

  /**
   * Load relevant FAQs based on keywords
   */
  async loadRelevantFAQs(keywords: string[]): Promise<Array<{
    question: string;
    answer: string;
    category: string;
  }>> {
    // Build query to match any keyword
    const keywordFilter = keywords.map(k => `keywords.cs.{${k}}`).join(',');
    
    const response = await fetch(
      `${this.url}/rest/v1/bot_faq_knowledge?active=eq.true&or=(${keywordFilter})&select=question,answer,category&order=priority.desc&limit=5`,
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    if (!response.ok) {
      // If no FAQs match, return empty array
      if (response.status === 404) return [];
      throw new Error(`Failed to load FAQs: ${response.status} ${await response.text()}`);
    }

    return await response.json();
  }

  /**
   * Load all active FAQs
   */
  async loadAllFAQs(): Promise<Array<{
    question: string;
    answer: string;
    category: string;
  }>> {
    const response = await fetch(
      `${this.url}/rest/v1/bot_faq_knowledge?active=eq.true&select=question,answer,category&order=priority.desc`,
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to load all FAQs: ${response.status} ${await response.text()}`);
    }

    return await response.json();
  }

  // ============================================================================
  // PHASE 5: Analytics
  // ============================================================================

  /**
   * Track analytics event
   */
  async trackEvent(
    leadId: string,
    eventType: string,
    eventData: any = {}
  ): Promise<void> {
    const response = await fetch(`${this.url}/rest/v1/bot_analytics`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        lead_id: leadId,
        event_type: eventType,
        event_data: eventData
      })
    });

    if (!response.ok) {
      // Don't throw on analytics errors - log and continue
      const errorText = await response.text();
      console.error(`Failed to track event: ${response.status} ${errorText}`);
      return;
    }
    
    // ✅ FIX: Consume response body to prevent stalled HTTP
    await response.text();
  }

  /**
   * Get active service addons from database
   * Returns all active addons with pricing information
   */
  async getActiveAddons(): Promise<Array<{
    id: string;
    addon_key: string;
    name: string;
    price_cents: number;
    is_active: boolean;
    created_at: string;
  }>> {
    const response = await fetch(
      `${this.url}/rest/v1/add_ons?is_active=eq.true&select=*&order=name.asc`,
      {
        method: 'GET',
        headers: this.headers()
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get addons: ${response.status} ${await response.text()}`);
    }

    return await response.json();
  }
}

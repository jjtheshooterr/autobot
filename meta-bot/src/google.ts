/**
 * Google Calendar API client
 * Handles OAuth refresh, FreeBusy queries, and event creation
 * Uses FIXED 3-hour windows: 12-3 PM and 3-6 PM only
 */

import type { Slot, BusyBlock, Env } from './types';

/**
 * De-duplicate slots by start+end timestamps
 * Prevents duplicate slots from being returned
 */
function dedupeSlots(slots: Slot[]): Slot[] {
  const seen = new Set<string>();
  const out: Slot[] = [];
  
  for (const s of slots) {
    const key = `${s.startISO}|${s.endISO}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  
  return out;
}

export class GoogleCalendar {
  private calendarId: string;
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private timeZone: string;
  private accessToken: string | null = null;

  constructor(env: Env) {
    this.calendarId = env.GOOGLE_CALENDAR_ID;
    this.clientId = env.GOOGLE_CLIENT_ID;
    this.clientSecret = env.GOOGLE_CLIENT_SECRET;
    this.refreshToken = env.GOOGLE_REFRESH_TOKEN;
    this.timeZone = env.GOOGLE_TIMEZONE;
  }

  /**
   * Get access token (refresh if needed)
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token'
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh token: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { access_token: string };
    this.accessToken = data.access_token;
    return this.accessToken;
  }

  /**
   * Query FreeBusy API for busy blocks
   */
  async freeBusy(timeMinISO: string, timeMaxISO: string): Promise<BusyBlock[]> {
    const token = await this.getAccessToken();

    const response = await fetch(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          timeMin: timeMinISO,
          timeMax: timeMaxISO,
          items: [{ id: this.calendarId }]
        })
      }
    );

    if (!response.ok) {
      throw new Error(`FreeBusy API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    const calendar = data.calendars?.[this.calendarId];
    
    if (!calendar || !calendar.busy) {
      return [];
    }

    return calendar.busy.map((block: any) => ({
      start: block.start,
      end: block.end
    }));
  }

  /**
   * Check if a specific slot is still free
   */
  async isSlotStillFree(slot: Slot): Promise<boolean> {
    const busyBlocks = await this.freeBusy(slot.startISO, slot.endISO);
    
    // If any busy block overlaps with the slot, it's not free
    for (const busy of busyBlocks) {
      if (this.overlapsStrings(slot.startISO, slot.endISO, busy.start, busy.end)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Create a calendar event using slot's full 3-hour window
   * @returns Event ID
   */
  async createEvent(
    slot: Slot,
    summary: string,
    description: string
  ): Promise<string> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          summary,
          description,
          start: {
            dateTime: slot.startISO,
            timeZone: this.timeZone
          },
          end: {
            dateTime: slot.endISO,
            timeZone: this.timeZone
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to create event: ${response.status} ${await response.text()}`);
    }

    const event = await response.json() as { id: string };
    return event.id;
  }

  /**
   * Update a calendar event's description
   * @returns Updated event ID
   */
  async updateEventDescription(
    eventId: string,
    description: string
  ): Promise<void> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          description
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to update event: ${response.status} ${await response.text()}`);
    }

    await response.json();
  }

  /**
   * Generate two available slots using FIXED windows (12-3 PM and 3-6 PM)
   * Tries daysPrimary first, falls back to daysFallback if needed
   * @param timezone - Target timezone
   * @param options - Search options
   * @param forcedDate - Optional: Force search to specific date only
   * @param startOffset - Number of days to skip from today (default: 3 to skip today + next 2 days)
   */
  async generateTwoSlots(
    timezone: string,
    options: { daysPrimary: number; daysFallback: number },
    forcedDate?: Date,
    startOffset: number = 3
  ): Promise<Slot[]> {
    // If forced date provided, search that date first, then extend if needed
    if (forcedDate) {
      console.log(`[GCAL] Forced date search: ${forcedDate.toISOString()}`);
      const dateSlots = await this.generateSlotsForSpecificDate(forcedDate);
      
      // If we got 2+ slots on the requested date, return them
      if (dateSlots.length >= 2) {
        return dedupeSlots(dateSlots).slice(0, 2);
      }
      
      // If only 1 slot on requested date, search forward for the 2nd slot
      if (dateSlots.length === 1) {
        console.log(`[GCAL] Only 1 slot on requested date, searching forward for 2nd slot`);
        const { y, m, d } = this.ymdInTZ(forcedDate, this.timeZone);
        
        // Search next 14 days for additional slots
        for (let i = 1; i <= 14 && dateSlots.length < 2; i++) {
          const nextDay = new Date(Date.UTC(y, m - 1, d + i, 12, 0, 0));
          const nextSlots = await this.generateSlotsForSpecificDate(nextDay);
          
          // Add first available slot from next day
          if (nextSlots.length > 0) {
            dateSlots.push(nextSlots[0]);
            console.log(`[GCAL] Added 2nd slot from next available day: ${nextSlots[0].label}`);
            break;
          }
        }
      }
      
      return dedupeSlots(dateSlots).slice(0, 2);
    }
    
    // Try primary window first (with startOffset)
    let slots = await this.generateTwoSlotsFixedWindows(options.daysPrimary, [], 999, startOffset);
    
    if (slots.length >= 2) {
      return dedupeSlots(slots).slice(0, 2);
    }

    // Fallback to extended window (with startOffset)
    slots = await this.generateTwoSlotsFixedWindows(options.daysFallback, [], 999, startOffset);
    return dedupeSlots(slots).slice(0, 2);
  }

  /**
   * Generate slots for a specific date only
   * Used when user requests explicit date like "the 17th"
   */
  async generateSlotsForSpecificDate(targetDate: Date): Promise<Slot[]> {
    const { y, m, d } = this.ymdInTZ(targetDate, this.timeZone);
    
    console.log(`[GCAL] Searching specific date: ${y}-${m}-${d}`);
    
    // Create start/end of day for FreeBusy query
    const dayStart = this.makeDateInTZ(this.timeZone, y, m, d, 0, 0);
    const dayEnd = this.makeDateInTZ(this.timeZone, y, m, d, 23, 59);
    
    // Query busy blocks for this specific day
    const busy = await this.freeBusy(dayStart.toISOString(), dayEnd.toISOString());
    console.log(`[GCAL] Found ${busy.length} busy blocks for ${y}-${m}-${d}`);
    
    const now = new Date();
    const out: Slot[] = [];
    
    // ONLY TWO WINDOWS: 12-3 PM and 3-6 PM
    const s1 = this.makeDateInTZ(this.timeZone, y, m, d, 12, 0);
    const e1 = this.makeDateInTZ(this.timeZone, y, m, d, 15, 0);
    
    const s2 = this.makeDateInTZ(this.timeZone, y, m, d, 15, 0);
    const e2 = this.makeDateInTZ(this.timeZone, y, m, d, 18, 0);
    
    const candidates = [
      { start: s1, end: e1 },
      { start: s2, end: e2 },
    ].filter((c) => c.end > now); // no past windows
    
    for (const c of candidates) {
      const isBusy = busy.some((b) => 
        this.overlapsDates(c.start, c.end, new Date(b.start), new Date(b.end))
      );
      
      if (!isBusy) {
        const slot = {
          label: this.formatSlotLabel(c.start),
          startISO: c.start.toISOString(),
          endISO: c.end.toISOString()
        };
        console.log(`[GCAL] ✅ Available on requested date: ${slot.label}`);
        out.push(slot);
      } else {
        const slot = {
          label: this.formatSlotLabel(c.start),
          startISO: c.start.toISOString(),
          endISO: c.end.toISOString()
        };
        console.log(`[GCAL] ❌ Busy on requested date: ${slot.label}`);
      }
    }
    
    console.log(`[GCAL] Found ${out.length} available slots on requested date`);
    return out;
  }

  /**
   * Generate slots using ONLY fixed 3-hour windows: 12-3 PM and 3-6 PM
   * Made public to allow targeted day searches
   * @param days - Number of days to search forward
   * @param excludeDays - Optional array of day names to exclude (e.g., ['friday', 'saturday'])
   * @param maxSlots - Maximum number of slots to return (default: unlimited for searching)
   * @param startOffset - Number of days to skip from today (default: 0)
   */
  async generateTwoSlotsFixedWindows(days: number, excludeDays: string[] = [], maxSlots: number = 999, startOffset: number = 0): Promise<Slot[]> {
    const now = new Date();
    
    // Get current date in target timezone
    const startYMD = this.ymdInTZ(now, this.timeZone);
    // Add startOffset to skip days
    const rangeStart = this.makeDateInTZ(this.timeZone, startYMD.y, startYMD.m, startYMD.d + startOffset, 0, 0);
    const rangeEnd = new Date(rangeStart.getTime() + days * 24 * 60 * 60 * 1000);

    console.log(`[GCAL] Searching ${days} days from ${rangeStart.toISOString()} to ${rangeEnd.toISOString()}`);
    console.log(`[GCAL] Excluding days:`, excludeDays);

    // Query busy blocks once for the whole range
    const busy = await this.freeBusy(rangeStart.toISOString(), rangeEnd.toISOString());
    console.log(`[GCAL] Found ${busy.length} busy blocks`);

    const out: Slot[] = [];
    const allSlots: Array<{day: string, slot: Slot, isBusy: boolean}> = [];

    for (let i = 0; i < days; i++) {
      const day = new Date(rangeStart.getTime() + i * 24 * 60 * 60 * 1000);
      const { y, m, d } = this.ymdInTZ(day, this.timeZone);

      // Check if this day should be excluded
      const dayName = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        timeZone: this.timeZone
      }).format(day).toLowerCase();
      
      if (excludeDays.includes(dayName)) {
        console.log(`[GCAL] Skipping ${dayName} (excluded)`);
        continue; // Skip this day
      }

      // ONLY TWO WINDOWS: 12-3 PM and 3-6 PM
      const s1 = this.makeDateInTZ(this.timeZone, y, m, d, 12, 0);
      const e1 = this.makeDateInTZ(this.timeZone, y, m, d, 15, 0);

      const s2 = this.makeDateInTZ(this.timeZone, y, m, d, 15, 0);
      const e2 = this.makeDateInTZ(this.timeZone, y, m, d, 18, 0);

      const candidates = [
        { start: s1, end: e1 },
        { start: s2, end: e2 },
      ].filter((c) => c.end > now); // no past windows

      for (const c of candidates) {
        const isBusy = busy.some((b) => 
          this.overlapsDates(c.start, c.end, new Date(b.start), new Date(b.end))
        );
        
        const slot = {
          label: this.formatSlotLabel(c.start),
          startISO: c.start.toISOString(),
          endISO: c.end.toISOString()
        };
        
        allSlots.push({ day: dayName, slot, isBusy });
        
        // ✅ FIX #3: Check for duplicates BEFORE adding to output
        const isDuplicate = out.some(s => 
          s.startISO === slot.startISO && s.endISO === slot.endISO
        );
        
        if (!isBusy && !isDuplicate && out.length < maxSlots) {
          console.log(`[GCAL] ✅ Available: ${slot.label}`);
          out.push(slot);
        } else if (isBusy) {
          console.log(`[GCAL] ❌ Busy: ${slot.label}`);
        } else if (isDuplicate) {
          console.log(`[GCAL] ⚠️ Duplicate (skipped): ${slot.label}`);
        }
        
        if (out.length >= maxSlots) break;
      }
      
      if (out.length >= maxSlots) break;
    }

    console.log(`[GCAL] Generated ${out.length} available slots`);
    // Still call dedupeSlots as final safety net
    return dedupeSlots(out);
  }

  /**
   * Get year/month/day in target timezone
   */
  private ymdInTZ(date: Date, timeZone: string): { y: number; m: number; d: number } {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);

    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    return { y: +get("year"), m: +get("month"), d: +get("day") };
  }

  /**
   * Build a Date that represents a wall-clock time in the target timeZone
   * FIXED: Properly converts local timezone time to UTC
   */
  private makeDateInTZ(timeZone: string, y: number, m: number, d: number, hh: number, mm: number): Date {
    // Create a string representing the local time in the target timezone
    const localStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
    
    // Parse as UTC first
    const utcDate = new Date(`${localStr}Z`);
    
    // Format this UTC time as it would appear in the target timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(utcDate);
    const tzHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    
    // Calculate offset: how many hours difference between what we want and what UTC gives us
    const offsetHours = hh - tzHour;
    
    // Apply offset to get correct UTC time
    return new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm, 0));
  }

  /**
   * Format slot label as "Weekday at HH:MM AM/PM"
   * Shows start time of the 3-hour window (12:00 PM or 3:00 PM)
   */
  private formatSlotLabel(date: Date): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: this.timeZone
    });

    const parts = formatter.formatToParts(date);
    const weekday = parts.find(p => p.type === 'weekday')?.value || '';
    const hour = parts.find(p => p.type === 'hour')?.value || '';
    const minute = parts.find(p => p.type === 'minute')?.value || '';
    const dayPeriod = parts.find(p => p.type === 'dayPeriod')?.value || '';

    return `${weekday} at ${hour}:${minute} ${dayPeriod}`;
  }

  /**
   * Check if two time ranges overlap (Date objects)
   */
  private overlapsDates(s1: Date, e1: Date, s2: Date, e2: Date): boolean {
    return s1 < e2 && s2 < e1;
  }

  /**
   * Check if two time ranges overlap (ISO strings)
   */
  private overlapsStrings(
    start1: string,
    end1: string,
    start2: string,
    end2: string
  ): boolean {
    const s1 = new Date(start1).getTime();
    const e1 = new Date(end1).getTime();
    const s2 = new Date(start2).getTime();
    const e2 = new Date(end2).getTime();

    return s1 < e2 && s2 < e1;
  }
}

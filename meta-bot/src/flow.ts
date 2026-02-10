/**
 * Conversation flow logic
 * Message templates, intent detection, and slot matching
 * HUMANIZED VERSION: Natural, conversational, with tone variation
 */

import type { Env, Slot, QuestionType, SlotMatchResult } from './types';

// ============================================================================
// HELPER: RANDOM PICKER (with optional deterministic seed)
// ============================================================================

/**
 * Pick a random item from array
 * Optional seed for deterministic selection (prevents mid-conversation changes)
 */
function pick<T>(arr: T[], seed?: string): T {
  if (seed) {
    // Simple hash for deterministic selection
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return arr[Math.abs(hash) % arr.length];
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Extract actual date from slot (e.g., "February 10th" from startISO)
 */
function getSlotDate(slot: Slot, timezone: string = 'America/Denver'): string {
  const date = new Date(slot.startISO);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: timezone }).format(date);
  const day = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: timezone }).format(date);
  const ordinal = getOrdinalSuffix(parseInt(day));
  return `${month} ${day}${ordinal}`;
}

// ============================================================================
// MESSAGE TEMPLATES (HUMANIZED WITH VARIATION)
// ============================================================================

/**
 * Initial hard close message with price
 * HUMANIZED: Friendly, confident
 * - If 2 DIFFERENT slots on same day: "Wednesday at 12 or 3"
 * - If 1 slot or duplicate times: "Wednesday at 12"
 */
export function hardClose(env: Env, slots: Slot[], seed?: string): string {
  if (slots.length < 1) {
    return "What day/time works best for you?";
  }

  // Check if we have 2 slots on the same day with DIFFERENT times
  if (slots.length >= 2) {
    const date1 = getSlotDate(slots[0]);
    const date2 = getSlotDate(slots[1]);
    const time1 = slots[0].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
    const time2 = slots[1].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
    
    // Only show both times if same day AND different times
    if (date1 === date2 && time1 !== time2) {
      const dayName = slots[0].label.match(/^(\w+day)/i)?.[1] || '';
      
      const variants = [
        `Hey! 👋 I can get you in for a ${env.SERVICE_NAME} — it's ${env.SERVICE_PRICE}. I've got ${dayName} at ${time1} or ${time2}. Does one of those work, or tell me what date works best for you?`,
        
        `Perfect timing — ${env.SERVICE_NAME} is ${env.SERVICE_PRICE}. I can do ${dayName} at ${time1} or ${time2}. Which works better, or what day would you prefer?`,
        
        `Awesome. ${env.SERVICE_PRICE} for the ${env.SERVICE_NAME}. I've got ${dayName} at ${time1} or ${time2}. Want one of those, or tell me what date works for you?`,
        
        `Hey! ${env.SERVICE_NAME} is ${env.SERVICE_PRICE}. I can do ${dayName} at ${time1} or ${time2}. Does one work, or what day is better for you?`
      ];
      
      return pick(variants, seed);
    }
  }

  // Single slot or duplicate times - just offer first slot
  const slot = slots[0];
  
  const variants = [
    `Hey! 👋 I can get you in for a ${env.SERVICE_NAME} — it's ${env.SERVICE_PRICE}. I've got ${slot.label} available. Does that work, or tell me what date works best for you?`,
    
    `Perfect timing — ${env.SERVICE_NAME} is ${env.SERVICE_PRICE}. I can do ${slot.label}. Does that work, or what day would you prefer?`,
    
    `Awesome. ${env.SERVICE_PRICE} for the ${env.SERVICE_NAME}. I've got ${slot.label}. Want me to lock it in, or tell me what date works for you?`,
    
    `Hey! ${env.SERVICE_NAME} is ${env.SERVICE_PRICE}. I can do ${slot.label}. Does that work, or what day is better for you?`
  ];

  return pick(variants, seed);
}

/**
 * Re-close message (without price) - used after answering questions
 * HUMANIZED: Confirms understanding
 * - If 2 slots on same day with DIFFERENT times: "Wednesday at 12 or 3"
 * - If 1 slot or duplicate times: "Wednesday at 12"
 */
export function reClose(slots: Slot[], seed?: string, includeDate: boolean = false): string {
  if (slots.length < 1) {
    return "What day/time works best for you?";
  }

  // Check if we have 2 slots on the same day with DIFFERENT times
  if (slots.length >= 2) {
    const date1 = getSlotDate(slots[0]);
    const date2 = getSlotDate(slots[1]);
    const time1 = slots[0].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
    const time2 = slots[1].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
    
    // Only show both times if same day AND different times
    if (date1 === date2 && time1 !== time2) {
      const dayName = slots[0].label.match(/^(\w+day)/i)?.[1] || '';
      const dateStr = includeDate ? ` (${date1})` : '';
      
      const variants = [
        `I've got ${dayName}${dateStr} at ${time1} or ${time2}. Does one work, or tell me what date works best for you?`,
        `I can do ${dayName}${dateStr} at ${time1} or ${time2}. Which is better, or what day would you prefer?`,
        `${dayName}${dateStr} at ${time1} or ${time2} is open. Want one of those, or what day works for you?`,
        `I've got ${dayName}${dateStr} at ${time1} or ${time2}. Does one work for you, or what day would be better?`
      ];
      
      return pick(variants, seed);
    }
  }

  // Single slot, duplicate times, or different days - just offer first slot
  const slot = slots[0];
  const dateStr = includeDate ? ` (${getSlotDate(slot)})` : '';
  
  const variants = [
    `I've got ${slot.label}${dateStr} available. Does that work, or tell me what date works best for you?`,
    `I can do ${slot.label}${dateStr}. Does that work, or what day would you prefer?`,
    `${slot.label}${dateStr} is open. Want me to lock it in, or what day is better?`,
    `I've got ${slot.label}${dateStr}. Does that work for you, or what day would be better?`
  ];
  
  return pick(variants, seed);
}

/**
 * Day-specific close (when user asks "Do you have Sunday?")
 * HUMANIZED: Confirms the day AND date
 * - If 2 slots with DIFFERENT times: "Sunday at 12 or 3"
 * - If 1 slot or duplicate times: "Sunday at 12"
 */
export function dayClose(dayName: string, slots: Slot[], seed?: string): string {
  if (slots.length < 1) {
    return `I don't have ${dayName} available. What other day works for you?`;
  }

  const actualDate = getSlotDate(slots[0]);
  
  // Check if we have 2 slots with DIFFERENT times
  if (slots.length >= 2) {
    const time1 = slots[0].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
    const time2 = slots[1].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
    
    // Only show both times if they're different
    if (time1 !== time2) {
      const variants = [
        `Yep — I can do ${dayName}, ${actualDate} at ${time1} or ${time2}. Does one work, or what day would be better?`,
        `Yes! ${dayName}, ${actualDate} works. I've got ${time1} or ${time2}. Which is better, or tell me what date you prefer?`,
        `For sure — ${dayName}, ${actualDate} at ${time1} or ${time2}. Want one of those, or what day works for you?`,
        `Yep! ${dayName}, ${actualDate}. I can do ${time1} or ${time2}. Does one work, or what day is better?`
      ];
      
      return pick(variants, seed);
    }
  }

  // Single slot or duplicate times
  const slot = slots[0];
  
  const variants = [
    `Yep — I can do ${dayName}, ${actualDate}. ${slot.label} is open. Does that work, or what day would be better?`,
    `Yes! ${dayName}, ${actualDate} works. I've got ${slot.label}. Want me to lock it in, or tell me what date you prefer?`,
    `For sure — ${dayName}, ${actualDate} is available. ${slot.label}. Does that work for you?`,
    `Yep! ${dayName}, ${actualDate}. I can do ${slot.label}. Want it, or what day is better?`
  ];
  
  return pick(variants, seed);
}

/**
 * Date-specific close (when user asks "Do you have the 17th?")
 * HUMANIZED: Confirms the specific date with month name
 * - If 2 slots with DIFFERENT times: "Friday, March the 17th at 12 or 3"
 * - If 1 slot or duplicate times: "Friday, March the 17th at 12"
 */
export function dateClose(dayName: string, monthName: string, dateNum: number, slots: Slot[], seed?: string): string {
  const ordinal = getOrdinalSuffix(dateNum);
  
  if (slots.length < 1) {
    return `That date is fully booked. What other day works for you?`;
  }

  // Check if we have 2 slots with DIFFERENT times
  if (slots.length >= 2) {
    const time1 = slots[0].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
    const time2 = slots[1].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
    
    // Only show both times if they're different
    if (time1 !== time2) {
      const variants = [
        `Yep — ${dayName}, ${monthName} the ${dateNum}${ordinal} at ${time1} or ${time2}. Does one work, or what day would be better?`,
        `Yes! ${dayName}, ${monthName} the ${dateNum}${ordinal}. I've got ${time1} or ${time2}. Which is better, or tell me what date you prefer?`,
        `For sure — ${dayName}, ${monthName} the ${dateNum}${ordinal} at ${time1} or ${time2}. Want one of those?`,
        `${dayName}, ${monthName} the ${dateNum}${ordinal} works. ${time1} or ${time2}. Does one work, or what day is better?`
      ];
      
      return pick(variants, seed);
    }
  }

  // Single slot or duplicate times
  const slot = slots[0];
  
  const variants = [
    `Yep — ${dayName}, ${monthName} the ${dateNum}${ordinal} works. ${slot.label} is open. Does that work, or what day would be better?`,
    `Yes! ${dayName}, ${monthName} the ${dateNum}${ordinal}. I've got ${slot.label}. Want me to lock it in, or tell me what date you prefer?`,
    `For sure — ${dayName}, ${monthName} the ${dateNum}${ordinal}. ${slot.label}. Does that work for you?`
  ];
  
  return pick(variants, seed);
}

/**
 * Attachment close message
 * HUMANIZED: Acknowledges attachment, offers ONE slot
 */
export function attachmentClose(slots: Slot[], seed?: string): string {
  if (slots.length < 1) {
    return "Got it — we can handle that. What day/time works best for you?";
  }

  // Always offer just the FIRST slot
  const slot = slots[0];
  
  const variants = [
    `Got it — we can handle that. I've got ${slot.label} available. Does that work, or what day would be better?`,
    `Perfect — we do that. ${slot.label} is open. Want me to lock it in, or tell me what date you prefer?`,
    `Yep, we handle that. I can do ${slot.label}. Does that work for you?`
  ];
  
  return pick(variants, seed);
}

/**
 * Hesitation fallback (when user doesn't pick)
 * HUMANIZED: Makes it easy to choose
 */
export function hesitationFallback(slots: Slot[], seed?: string): string {
  if (slots.length < 2) {
    return "Which time works best for you?";
  }

  // Extract just the time portions for easier choice
  const time1 = slots[0].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || slots[0].label;
  const time2 = slots[1].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || slots[1].label;

  const variants = [
    `No worries — which is easier for you, ${time1} or ${time2}? I can hold it for a minute.`,
    `All good — ${time1} or ${time2}? Which works better?`,
    `Take your time — ${time1} or ${time2}? I can lock either one in.`,
    `No rush — which is better, ${time1} or ${time2}?`
  ];

  return pick(variants, seed);
}

/**
 * STOP response
 */
export function stopResponse(): string {
  return "No problem — I'll stop messaging you.";
}

/**
 * HUMAN response
 */
export function humanResponse(): string {
  return "Sure — what's the best number to reach you?";
}

/**
 * Slot claimed - ask for address (NEW FLOW: skip name, collect address first)
 * HUMANIZED: Makes it feel like we're holding the slot for them
 */
export function claimedAskAddress(slotLabel: string, seed?: string): string {
  const variants = [
    `Perfect — I can hold ${slotLabel} for you. What's the address for the service?`,
    `Got it — ${slotLabel} is yours. Where should we come to?`,
    `Awesome — holding ${slotLabel} for you. What's the service address?`,
    `Great! ${slotLabel} is reserved. What address?`
  ];

  return pick(variants, seed);
}

/**
 * Address collected - ask for phone
 * HUMANIZED: Final step before booking
 */
export function collectedAddressAskPhone(seed?: string): string {
  const variants = [
    `Perfect — and what's the best phone number to reach you?`,
    `Got it — what's your phone number?`,
    `Great — phone number?`,
    `Awesome — best number to call you?`
  ];

  return pick(variants, seed);
}

/**
 * All details collected - booking finalized
 * HUMANIZED: Celebration with checkmark
 */
export function finalizedBooking(slotLabel: string, seed?: string): string {
  const variants = [
    `Perfect — you're all set ✅ We'll see you ${slotLabel}!`,
    `Done ✅ — booked for ${slotLabel}. See you then!`,
    `You're booked ✅ — ${slotLabel}. Looking forward to it!`,
    `All set ✅ — ${slotLabel} is confirmed. See you soon!`
  ];

  return pick(variants, seed);
}

/**
 * Pending slot expired - need to restart
 * HUMANIZED: Apologetic but helpful, offers ONE new slot
 */
export function pendingExpired(slots: Slot[], seed?: string): string {
  if (slots.length < 1) {
    return "Sorry — that time got away. What day works best for you?";
  }

  // Always offer just the FIRST slot
  const slot = slots[0];
  
  const variants = [
    `Sorry — that slot got taken. I've got ${slot.label} available now. Does that work, or what day is better?`,
    `Ah — someone grabbed that time. I can do ${slot.label}. Want me to lock it in, or tell me what date you prefer?`,
    `That slot filled up — but I have ${slot.label}. Does that work for you?`
  ];

  return pick(variants, seed);
}

/**
 * Booking confirmation message
 * HUMANIZED: Makes it feel real with checkmark
 */
export function bookedAskInfo(slotLabel: string, seed?: string): string {
  const variants = [
    `Got you ✅ — you're booked for ${slotLabel}. What name should I put it under?`,
    `Perfect ✅ — locked in for ${slotLabel}. What's the best name for the booking?`,
    `Done ✅ — you're set for ${slotLabel}. Name for the appointment?`,
    `Booked ✅ — ${slotLabel} is yours. What name should I use?`
  ];

  return pick(variants, seed);
}

/**
 * Get ordinal suffix for day number (1st, 2nd, 3rd, 4th, etc.)
 */
function getOrdinalSuffix(day: number): string {
  if (day > 3 && day < 21) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

// ============================================================================
// INTENT DETECTION
// ============================================================================

/**
 * Detect STOP keywords (including cancel)
 */
export function detectStop(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  const stopKeywords = [
    'stop', 
    'unsubscribe', 
    'quit', 
    "don't message", 
    'dont message',
    'cancel',
    'nevermind',
    'never mind',
    'not interested'
  ];
  
  return stopKeywords.some(keyword => normalized.includes(keyword));
}

/**
 * Detect HUMAN keywords
 */
export function detectHuman(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  const humanKeywords = ['human', 'agent', 'call me', 'speak to someone', 'talk to someone'];
  
  return humanKeywords.some(keyword => normalized.includes(keyword));
}

/**
 * Detect gratitude/acknowledgment (thanks, appreciate, etc.)
 * Used to respond naturally without pushing for another booking
 */
export function detectGratitude(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  const gratitudeKeywords = [
    'thanks',
    'thank you',
    'appreciate',
    'perfect',
    'awesome',
    'great',
    'sounds good',
    'ok thanks',
    'okay thanks',
    'cool thanks',
    'got it thanks'
  ];
  
  return gratitudeKeywords.some(keyword => normalized.includes(keyword));
}

/**
 * Gratitude response - acknowledges thanks without pushing for more bookings
 * HUMANIZED: Friendly, brief, leaves door open
 */
export function gratitudeResponse(seed?: string): string {
  const variants = [
    "You're all set! 🙌 Hit me up if you need anything else.",
    "Perfect! See you then. Let me know if anything comes up.",
    "Awesome! You're good to go. Reach out if you need to adjust anything.",
    "You got it! See you soon. 👍",
    "All set! Let me know if you need anything before then.",
    "Perfect! Looking forward to it. Hit me up if plans change."
  ];
  
  return pick(variants, seed);
}

/**
 * Detect change/reschedule request
 */
export function detectChangeRequest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  const changeKeywords = [
    'change',
    'reschedule',
    'different day',
    'different time',
    'move it',
    'switch',
    'adjust',
    'modify',
    'update'
  ];
  
  return changeKeywords.some(keyword => normalized.includes(keyword));
}

/**
 * Detect slot regeneration request (user wants different options)
 * IMPORTANT: Only match EXPLICIT requests for different options
 * Do NOT match questions like "Sunday?" or "Other days?"
 */
export function detectRegenerateSlots(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  
  // Exclude questions (ending with ?)
  if (normalized.endsWith('?')) {
    return false;
  }
  
  // Exclude single-word responses
  if (normalized.split(/\s+/).length <= 2) {
    return false;
  }
  
  const regenerateKeywords = [
    'different time',
    'another time',
    'other options',
    'something else',
    'neither',
    'not those',
    'different day',
    'show me more',
    'what else',
    'any other',
    'anything else',
    'give me other',
    'show other'
  ];
  
  return regenerateKeywords.some(keyword => normalized.includes(keyword));
}

/**
 * Detect question type
 */
export function detectQuestionType(text: string): QuestionType {
  const normalized = text.toLowerCase().trim();

  // Service inquiry (what services, tell me about services, help, etc.)
  if (normalized.includes('what services') || normalized.includes('what service') ||
      normalized.includes('tell me about') || normalized.includes('what do you do') ||
      normalized.includes('what can you do') || normalized.includes('services do you') ||
      normalized.includes('help') || normalized.includes('info') || normalized.includes('information') ||
      (normalized.includes('service') && normalized.includes('?'))) {
    return 'services';
  }

  // Dog hair
  if (normalized.includes('dog') || normalized.includes('pet') || normalized.includes('hair') || normalized.includes('fur')) {
    return 'dog_hair';
  }

  // What's included
  if (normalized.includes('include') || normalized.includes('what do you') || normalized.includes('what does') || 
      normalized.includes('what is included') || normalized.includes('what comes with')) {
    return 'included';
  }

  // Price
  if (normalized.includes('price') || normalized.includes('cost') || normalized.includes('how much') || 
      normalized.includes('charge') || normalized.includes('fee')) {
    return 'price';
  }

  // ZIP/location
  if (normalized.includes('zip') || normalized.includes('location') || normalized.includes('where') || 
      normalized.includes('area') || normalized.includes('service area') || normalized.includes('come to')) {
    return 'zip';
  }

  // Duration
  if (normalized.includes('long') || normalized.includes('duration') || normalized.includes('how many hours') ||
      normalized.includes('take') && normalized.includes('time')) {
    return 'duration';
  }

  // Reschedule
  if (normalized.includes('reschedule') || normalized.includes('cancel') || normalized.includes('change')) {
    return 'reschedule';
  }

  // Availability questions (e.g., "Sunday?", "Other days?", "What about Monday?", "February 15th?")
  if (normalized.endsWith('?') && (
    normalized.includes('day') || 
    normalized.includes('time') ||
    normalized.includes('sunday') || 
    normalized.includes('monday') || 
    normalized.includes('tuesday') || 
    normalized.includes('wednesday') || 
    normalized.includes('thursday') || 
    normalized.includes('friday') || 
    normalized.includes('saturday') ||
    normalized.includes('other') ||
    normalized.includes('available') ||
    normalized.includes('when') ||
    normalized.includes('january') ||
    normalized.includes('february') ||
    normalized.includes('march') ||
    normalized.includes('april') ||
    normalized.includes('may') ||
    normalized.includes('june') ||
    normalized.includes('july') ||
    normalized.includes('august') ||
    normalized.includes('september') ||
    normalized.includes('october') ||
    normalized.includes('november') ||
    normalized.includes('december') ||
    /\d{1,2}(st|nd|rd|th)?/.test(normalized) // Matches "15th", "1st", "22nd", etc.
  )) {
    return 'availability';
  }

  // Generic question (ends with ?)
  if (normalized.endsWith('?')) {
    return 'generic';
  }

  return 'unknown';
}

/**
 * Generate answer for question type
 * HUMANIZED: Natural, conversational responses
 */
export function answerQuestion(
  env: Env, 
  qType: QuestionType, 
  addons: Array<{ addon_key: string; name: string; price_cents: number }>,
  seed?: string
): string {
  switch (qType) {
    case 'services': {
      // When asking about services, provide the same detailed breakdown as 'included'
      // This is what's in the Full Detail service
      return `Interior — thorough vacuuming, door and seat jams cleaned, plastics and rubber treated, floor mats cleaned, and windows streak-free.\n\nExterior — Foam cannon pre-wash, hand wash, towel dry, wheels and tires cleaned and dressed.`;
    }
    
    case 'dog_hair': {
      // Find dog hair addon
      const dogHairAddon = addons.find(a => a.addon_key === 'dog_hair');
      if (dogHairAddon) {
        const price = `$${(dogHairAddon.price_cents / 100).toFixed(0)}`;
        const variants = [
          `Totally — that's exactly what we do. For dog hair, it's an additional ${price}.`,
          `Yep, we handle that all the time. Dog hair removal is ${price} extra.`,
          `For sure. Dog hair is ${price} extra.`
        ];
        return pick(variants, seed);
      }
      // Fallback if addon not found
      return `Yep, we handle dog hair removal. It's an additional charge depending on severity.`;
    }
    
    case 'included': {
      // Always provide the detailed breakdown
      return `Interior — thorough vacuuming, door and seat jams cleaned, plastics and rubber treated, floor mats cleaned, and windows streak-free.\n\nExterior — Foam cannon pre-wash, hand wash, towel dry, wheels and tires cleaned and dressed.`;
    }
    
    case 'price': {
      const variants = [
        `The ${env.SERVICE_NAME} is ${env.SERVICE_PRICE}.`,
        `${env.SERVICE_PRICE} for the ${env.SERVICE_NAME}.`,
        `It's ${env.SERVICE_PRICE} for the full ${env.SERVICE_NAME}.`
      ];
      return pick(variants, seed);
    }
    
    case 'zip': {
      const variants = [
        `We're mobile — we come to you! We serve Northern Utah. What's your ZIP code?`,
        `We come to your location. We cover Northern Utah. What ZIP are you in?`,
        `Mobile service — we come to you in Northern Utah. What's your ZIP?`
      ];
      return pick(variants, seed);
    }
    
    case 'duration': {
      const variants = [
        `The service typically takes 2-3 hours.`,
        `Usually 2-3 hours depending on the vehicle.`,
        `About 2-3 hours for the full detail.`
      ];
      return pick(variants, seed);
    }
    
    case 'reschedule': {
      const variants = [
        `No problem, we can adjust your appointment.`,
        `Sure thing — we can move it.`,
        `Totally — let's reschedule.`
      ];
      return pick(variants, seed);
    }
    
    case 'availability': {
      const variants = [
        `Let me check what else is available.`,
        `Sure — let me see what I've got.`,
        `Yep, let me pull up the schedule.`
      ];
      return pick(variants, seed);
    }
    
    case 'generic': {
      const variants = [
        `Got it.`,
        `Yep.`,
        `For sure.`,
        `Totally.`
      ];
      return pick(variants, seed);
    }
    
    default:
      return "Got it.";
  }
}

// ============================================================================
// SLOT MATCHING
// ============================================================================

/**
 * Try to match user text to a slot
 * Hierarchy: exact label → day+time → time only → "1"/"2"
 */
export function tryMatchSlot(text: string, slots: Slot[]): SlotMatchResult {
  if (!slots || slots.length === 0) {
    return { matched: false };
  }

  const normalized = text.toLowerCase().trim();

  // Handle confirmation words - but ONLY if we showed a single slot
  // If we showed 2 slots (e.g., "12 or 3"), require them to pick a number
  const confirmWords = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'sounds good', 'that works', 'perfect', 'great'];
  const isConfirmWord = confirmWords.some(word => normalized === word || normalized.includes(word));
  
  if (isConfirmWord) {
    // Only auto-match if we have exactly 1 slot OR if both slots have the same time (duplicate)
    if (slots.length === 1) {
      return { matched: true, slot: slots[0] };
    } else if (slots.length >= 2) {
      // Check if both slots have different times
      const time1 = slots[0].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
      const time2 = slots[1].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || '';
      
      if (time1 === time2) {
        // Same time (duplicate) - auto-match first slot
        return { matched: true, slot: slots[0] };
      } else {
        // Different times - don't match, let them pick 1 or 2
        return { matched: false, requiresChoice: true };
      }
    }
  }

  // Try exact match: "1" or "2"
  if (normalized === '1' && slots.length >= 1) {
    return { matched: true, slot: slots[0] };
  }
  if (normalized === '2' && slots.length >= 2) {
    return { matched: true, slot: slots[1] };
  }

  // Try day name match (e.g., "Sunday", "Monday", "I want Sunday")
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const dayName of dayNames) {
    if (normalized.includes(dayName)) {
      // Find slot matching this day
      for (const slot of slots) {
        if (slot.label.toLowerCase().includes(dayName)) {
          return { matched: true, slot };
        }
      }
    }
  }

  // Try exact label match (case-insensitive)
  for (const slot of slots) {
    if (normalized === slot.label.toLowerCase()) {
      return { matched: true, slot };
    }
  }

  // Try time-only match (e.g., "3pm", "3:00 PM", "12:00", "noon", "12", "3", "3:00")
  // Normalize user input to match slot times
  let userTime = normalized.replace(/\s/g, ''); // Remove spaces
  
  // Handle "3:00" or "12:00" (without AM/PM) - try matching against slots
  if (/^\d{1,2}:\d{2}$/.test(userTime)) {
    const [hourStr, minutes] = userTime.split(':');
    const hour = parseInt(hourStr, 10);
    
    if (hour >= 1 && hour <= 12) {
      // Try matching against both AM and PM slots
      for (const slot of slots) {
        const slotLower = slot.label.toLowerCase();
        const timeMatch = slotLower.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
        
        if (timeMatch) {
          const slotHour = parseInt(timeMatch[1], 10);
          const slotMinutes = timeMatch[2];
          
          // Match if hour and minutes match
          if (slotHour === hour && slotMinutes === minutes) {
            return { matched: true, slot };
          }
        }
      }
    }
  }
  
  // Handle bare numbers that could be times (12, 3, etc.)
  // Only if they're reasonable appointment times (1-12)
  if (/^\d{1,2}$/.test(userTime)) {
    const hour = parseInt(userTime, 10);
    if (hour >= 1 && hour <= 12) {
      // Try matching as both AM and PM
      for (const slot of slots) {
        const slotLower = slot.label.toLowerCase();
        const timeMatch = slotLower.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
        
        if (timeMatch) {
          const slotHour = parseInt(timeMatch[1], 10);
          const slotMinutes = timeMatch[2];
          
          // Match if hour matches and minutes are :00
          if (slotHour === hour && slotMinutes === '00') {
            return { matched: true, slot };
          }
        }
      }
    }
  }
  
  // Handle "3pm" → "3:00pm"
  if (/^\d{1,2}(am|pm)$/i.test(userTime)) {
    userTime = userTime.replace(/^(\d{1,2})(am|pm)$/i, '$1:00$2');
  }
  
  // Handle "noon" → "12:00pm"
  if (userTime === 'noon') {
    userTime = '12:00pm';
  }
  
  // Handle "midnight" → "12:00am"
  if (userTime === 'midnight') {
    userTime = '12:00am';
  }
  
  // Now try to match against slot times
  for (const slot of slots) {
    const slotLower = slot.label.toLowerCase();
    const timeMatch = slotLower.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
    
    if (timeMatch) {
      const slotTime = timeMatch[1].replace(/\s/g, '').toLowerCase();
      
      // Check if user time matches slot time
      if (userTime === slotTime) {
        return { matched: true, slot };
      }
    }
  }

  // Try day + time match
  for (const slot of slots) {
    const slotLower = slot.label.toLowerCase();
    
    // Extract day and time from slot label
    // Format: "Saturday at 12:30 PM"
    const dayMatch = slotLower.match(/^(\w+day)/);
    const timeMatch = slotLower.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
    
    if (dayMatch && timeMatch) {
      const day = dayMatch[1];
      const time = timeMatch[1].replace(/\s/g, '');
      
      // Check if user text contains both day and time
      const normalizedNoSpaces = normalized.replace(/\s/g, '');
      if (normalized.includes(day) && normalizedNoSpaces.includes(time.toLowerCase())) {
        return { matched: true, slot };
      }
    }
  }

  return { matched: false };
}

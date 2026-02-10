/**
 * Meta Messenger Bot - Cloudflare Worker
 * Main entry point with route handlers and message processing
 */

import { verifyMetaSignatureOrThrow } from './security';
import { sendTextMessage } from './meta';
import { SupabaseRepo } from './supabase';
import { GoogleCalendar } from './google';
import { deepSeekAnswer, classifyIntent } from './deepseek';
import { extractRequestedDate } from './dateParser';
import { sendChatbotBookingEmail } from './resend';
import {
  hardClose,
  reClose,
  dayClose,
  dateClose,
  attachmentClose,
  hesitationFallback,
  stopResponse,
  humanResponse,
  bookedAskInfo,
  claimedAskAddress,
  collectedAddressAskPhone,
  finalizedBooking,
  pendingExpired,
  detectStop,
  detectHuman,
  detectGratitude,
  gratitudeResponse,
  detectChangeRequest,
  detectRegenerateSlots,
  detectQuestionType,
  answerQuestion,
  tryMatchSlot
} from './flow';
import {
  initializeContext,
  trackOfferedSlots,
  trackRequestedDay,
  trackIntent,
  shouldTriggerGracefulDegradation,
  shouldAskOpenEnded,
  resetAttemptCount,
  getExcludedDays,
  getDaysFromSlots
} from './context';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Webhook endpoint
    if (url.pathname === '/webhook') {
      // GET: Meta verification handshake
      if (request.method === 'GET') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');

        if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
          return new Response(challenge, { status: 200 });
        }

        return new Response('Forbidden', { status: 403 });
      }

      // POST: Message webhook
      if (request.method === 'POST') {
        try {
          // Read raw body for signature verification
          const rawBody = await request.arrayBuffer();

          // Verify signature
          await verifyMetaSignatureOrThrow(request, env.META_APP_SECRET, rawBody);

          // Parse JSON
          const payload = JSON.parse(new TextDecoder().decode(rawBody));

          // Return 200 immediately
          const response = new Response('OK', { status: 200 });

          // Process async
          ctx.waitUntil(processPayload(payload, env));

          return response;
        } catch (error) {
          console.error('Webhook error:', error);
          return new Response('Unauthorized', { status: 401 });
        }
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

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

/**
 * Process webhook payload asynchronously
 */
async function processPayload(payload: any, env: Env): Promise<void> {
  const repo = new SupabaseRepo(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const gcal = new GoogleCalendar(env);

  // Fetch active addons once for all messages in this payload
  let addons: Array<{ addon_key: string; name: string; price_cents: number }> = [];
  try {
    addons = await repo.getActiveAddons();
    console.log(`[ADDONS] Loaded ${addons.length} active addons`);
  } catch (addonError) {
    console.error('[ADDONS] Failed to load addons:', addonError);
    // Continue with empty addons array - bot will still work without addon pricing
  }

  for (const entry of payload.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      try {
        // Skip non-message events
        if (ev.delivery || ev.read || ev.message?.is_echo) continue;
        if (!ev.sender?.id) continue;

        const psid = ev.sender.id;

        // ✅ FIX #1: Upsert lead FIRST (before dedupe)
        const lead = await repo.upsertLeadByPsid(psid);

        // Dedup key (with fallback if mid is missing)
        const text = ev.message?.text ?? null;
        
        // ✅ FIX #7: Hash attachments for non-text messages
        let fallbackKey = `fallback:${psid}:${ev.timestamp}`;
        if (text) {
          fallbackKey += `:${text}`;
        } else if (ev.message?.attachments) {
          // Create stable fingerprint from attachments (normalize to stable fields)
          const attachments = ev.message.attachments.map((att: any) => ({
            type: att.type,
            // Use stable IDs if available (stickers, reusable attachments)
            id: att.payload?.attachment_id ?? att.payload?.sticker_id ?? '',
            url: att.payload?.url ?? att.payload?.reusable_url ?? '',
            title: att.payload?.title ?? ''
          }));
          const attachmentHash = JSON.stringify(attachments);
          fallbackKey += `:att:${attachmentHash.substring(0, 50)}`;
        } else {
          fallbackKey += ':no_content';
        }
        
        const dedupeKey = ev.message?.mid ?? fallbackKey;

        // Dedup AFTER lead exists
        const alreadyProcessed = await repo.tryInsertDedupe(dedupeKey, lead.id);
        if (alreadyProcessed) continue;

        // Log inbound BEFORE logic
        await repo.insertInboundMessage(lead.id, text, ev);
        
        // Phase 2: Save to conversation history (non-blocking)
        try {
          await repo.saveConversationHistory(lead.id, 'user', text);
        } catch (historyError) {
          console.error('[History] Failed to save:', historyError);
        }
        
        // Phase 5: Track conversation started event (non-blocking)
        try {
          const existingHistory = await repo.loadConversationHistory(lead.id, 1);
          if (existingHistory.length === 0) {
            await repo.trackEvent(lead.id, 'conversation_started', { psid });
          }
        } catch (analyticsError) {
          console.error('[Analytics] Failed to track conversation start:', analyticsError);
        }

        // ✅ CHECK: If bot is disabled for this lead, ignore the message (let human handle)
        if (lead.bot_enabled === false) {
          console.log('[BOT DISABLED] Ignoring message - bot_enabled is false for lead:', lead.id);
          // Don't send any response - let human take over
          continue;
        }

        // ✅ FIX #3: Handle attachments / no-text EARLY (before state machine)
        if (!ev.message?.text) {
          let state = await repo.getConvoState(lead.id);
          if (!state) state = await repo.upsertConvoState(lead.id, 'start', {});

          // Ensure slots exist
          if (!Array.isArray(state.context.slots) || state.context.slots.length < 2) {
            const slots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
              daysPrimary: 7,
              daysFallback: 14
            });
            state.context.slots = slots;
            state.step = 'closing';
            await repo.upsertConvoState(lead.id, state.step, state.context);
          }

          const reply = attachmentClose(state.context.slots);
          await repo.insertOutboundMessage(lead.id, reply, { psid, kind: 'attachment_close' });
          await sendTextMessage(psid, reply, env.FB_PAGE_ACCESS_TOKEN);
          continue;
        }

        // Load state
        let state = await repo.getConvoState(lead.id);
        if (!state) state = await repo.upsertConvoState(lead.id, 'start', {});
        
        // Initialize context with defaults
        state.context = initializeContext(state.context);

        // Reset conversation on greetings (fixes stuck state)
        // NOTE: "help" is NOT a greeting - it's a question about services
        const greetings = ['hi', 'hello', 'hey', 'start', 'restart', 'reset'];
        if (greetings.includes(text.toLowerCase().trim())) {
          console.log('[RESET] Conversation reset for greeting:', text);
          
          // Release any existing booking
          await repo.releaseBookingClaim(lead.id);
          await repo.setLeadStatus(lead.id, 'active');
          console.log('[RESET] Released any existing booking');
          
          state.step = 'start';
          state.context = initializeContext({});
        }

        // State machine
        let reply = '';

        if (state.step === 'start') {
          // ✅ PRIORITY 0: Check for service inquiry FIRST
          // If user asks about services, answer before pushing booking
          const qType = detectQuestionType(text);
          if (qType === 'services') {
            console.log('[SERVICE INQUIRY] User asking about services');
            state.context = trackIntent(state.context, 'service_inquiry');
            
            // Fetch addons for potential follow-up questions
            const addons = await repo.getActiveAddons();
            
            // Answer the service question
            const answer = answerQuestion(env, qType, addons, psid);
            reply = answer;
            
            // Move to closing state so next message can book
            state.step = 'closing';
            
            // Generate slots for when they're ready to book
            const slots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
              daysPrimary: 7,
              daysFallback: 14
            });
            if (slots && slots.length >= 2) {
              state.context = trackOfferedSlots(state.context, slots);
            }
          }
          // ✅ PRIORITY 1: Check for gratitude/acknowledgment
          // If user just said thanks after booking, don't push for another booking
          else if (detectGratitude(text)) {
            console.log('[GRATITUDE] User expressing thanks, responding naturally');
            state.context = trackIntent(state.context, 'gratitude');
            reply = gratitudeResponse(psid);
            // Stay in start state but don't generate slots
          } else {
            // Generate slots
            console.log('[START] Generating initial slots');
            const slots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
              daysPrimary: 7,
              daysFallback: 14
            });
            console.log('[START] Generated slots:', slots?.map(s => s.label));

            if (!slots || slots.length < 1) {
              reply = 'What day/time works for you?';
            } else {
              // Track offered slots in context - store both slots if available
              state.context = trackOfferedSlots(state.context, slots.length >= 2 ? [slots[0], slots[1]] : [slots[0]]);
              state.step = 'closing';
              reply = hardClose(env, slots.length >= 2 ? [slots[0], slots[1]] : [slots[0]], psid);
            }
          }
        } else if (state.step === 'closing') {
          // PRIORITY 0: Check for FAQ questions FIRST (before graceful degradation)
          const qType = detectQuestionType(text);
          
          if (qType !== 'unknown' && qType !== 'availability' && !detectStop(text) && !detectHuman(text) && !detectRegenerateSlots(text)) {
            // FAQ question - answer it and re-offer slots
            console.log('[FAQ] Detected question type:', qType);
            state.context = trackIntent(state.context, `faq_${qType}`);
            const slots = state.context.slots ?? [];
            
            // CRITICAL: Ensure exactly 2 slots for DeepSeek
            let slotLabels: string[];
            if (slots.length >= 2) {
              slotLabels = [slots[0].label, slots[1].label];
            } else if (slots.length === 1) {
              slotLabels = [slots[0].label, slots[0].label]; // Duplicate if only 1
            } else {
              // No slots - generate them first
              const newSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                daysPrimary: 7,
                daysFallback: 14
              });
              state.context.slots = newSlots;
              slotLabels = newSlots.length >= 2 
                ? [newSlots[0].label, newSlots[1].label]
                : ["available time", "available time"];
            }
            
            try {
              const faqAnswer = await deepSeekAnswer({
                env,
                question: text,
                serviceName: env.SERVICE_NAME,
                servicePrice: env.SERVICE_PRICE,
                addons,
                slotLabels, // Always exactly 2
              });
              reply = faqAnswer;
              console.log('[FAQ] DeepSeek answer provided');
            } catch (e) {
              console.error('[FAQ] DeepSeek failed:', e);
              const answer = answerQuestion(env, qType, addons, psid); // Use PSID as seed
              reply = `${answer} ${reClose(state.context.slots ?? [], psid)}`;
            }
          } else if (shouldTriggerGracefulDegradation(state.context)) {
            // Check for graceful degradation AFTER FAQ check
            console.log('[GRACEFUL] Triggering human handoff after 3 attempts');
            await repo.setLeadStatus(lead.id, 'needs_followup');
            
            try {
              await repo.trackEvent(lead.id, 'human_handoff_requested', {
                reason: 'repeated_failure',
                attemptCount: state.context.attemptCount
              });
            } catch (analyticsError) {
              console.error('[Analytics] Failed to track handoff:', analyticsError);
            }
            
            state.context = resetAttemptCount(state.context);
            reply = "I'm having trouble finding the perfect time for you. Let me have someone call you to schedule. What's the best number to reach you?";
          } else if (detectStop(text)) {
            state.context = trackIntent(state.context, 'stop');
            await repo.setLeadStatus(lead.id, 'dead');
            reply = stopResponse();
          } else if (detectHuman(text)) {
            state.context = trackIntent(state.context, 'human_request');
            await repo.setLeadStatus(lead.id, 'needs_followup');
            reply = humanResponse();
          } else if (detectRegenerateSlots(text)) {
            // User wants different options - generate new slots
            state.context = trackIntent(state.context, 'regenerate_slots');
            
            const excludeDays = getExcludedDays(state.context);
            const newSlots = await gcal.generateTwoSlotsFixedWindows(14, excludeDays, 2);
            
            if (newSlots.length >= 2) {
              state.context = trackOfferedSlots(state.context, newSlots);
              reply = `Sure! ${reClose(newSlots, psid)}`; // Use PSID as seed
            } else {
              reply = "What day works best for you?";
            }
          } else {
            const slots = state.context.slots ?? [];
            
            // CRITICAL: Check for explicit date requests FIRST (before slot matching)
            // This prevents "next Wednesday" from matching the current "Wednesday" slot
            const requestedDate = extractRequestedDate(text, new Date(), env.GOOGLE_TIMEZONE);
            
            console.log(`[Date/Day Detection] User text: "${text}"`);
            console.log(`[Date/Day Detection] Requested date from parser:`, requestedDate ? requestedDate.toISOString() : 'NULL');
            
            if (requestedDate) {
              // User requested specific date - FORCE search to that date only
              console.log(`[Date Request] User wants specific date: ${requestedDate.toISOString()}`);
              state.context = trackIntent(state.context, 'date_request');
              
              // Generate slots ONLY for that specific date
              const dateSlots = await gcal.generateTwoSlots(
                env.GOOGLE_TIMEZONE,
                { daysPrimary: 7, daysFallback: 14 },
                requestedDate // Force this date
              );
              
              console.log(`[Date Request] Found ${dateSlots.length} slots for requested date`);
              
              if (dateSlots.length >= 2) {
                // Found 2+ slots on requested date - SUCCESS!
                state.context = trackOfferedSlots(state.context, dateSlots.slice(0, 2), true);
                const dayName = new Intl.DateTimeFormat('en-US', {
                  weekday: 'long',
                  timeZone: env.GOOGLE_TIMEZONE
                }).format(requestedDate);
                const monthName = new Intl.DateTimeFormat('en-US', {
                  month: 'long',
                  timeZone: env.GOOGLE_TIMEZONE
                }).format(requestedDate);
                reply = dateClose(dayName, monthName, requestedDate.getUTCDate(), state.context.slots!, psid);
              } else if (dateSlots.length === 1) {
                // Found 1 slot on requested date
                state.context = trackOfferedSlots(state.context, [dateSlots[0]], true);
                const dayName = new Intl.DateTimeFormat('en-US', {
                  weekday: 'long',
                  timeZone: env.GOOGLE_TIMEZONE
                }).format(requestedDate);
                const monthName = new Intl.DateTimeFormat('en-US', {
                  month: 'long',
                  timeZone: env.GOOGLE_TIMEZONE
                }).format(requestedDate);
                reply = `I have ${dayName}, ${monthName} ${requestedDate.getUTCDate()} at ${dateSlots[0].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1]}. Does that work?`;
              } else {
                // No slots on requested date - offer closest alternatives
                console.log(`[Date Request] No slots on requested date, offering alternatives`);
                const altSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                  daysPrimary: 7,
                  daysFallback: 14
                });
                
                if (altSlots.length >= 2) {
                  state.context = trackOfferedSlots(state.context, altSlots, false);
                  reply = `That date is fully booked. The closest I have is ${reClose(altSlots, psid)}`;
                } else {
                  reply = "That date is fully booked. What other day works for you?";
                }
              }
              
              console.log(`[Date Request] ✅ Date handled - skipping slot matching`);
              
            } else {
              // No explicit date request - try slot matching
              const match = tryMatchSlot(text, slots);

              if (match?.requiresChoice) {
                // User said "yes" but we need them to pick 1 or 2
                console.log('[CHOICE REQUIRED] User needs to pick between 2 slots');
                const time1 = slots[0].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || slots[0].label;
                const time2 = slots[1].label.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i)?.[1] || slots[1].label;
                reply = `Great! Which time works better — 1 for ${time1} or 2 for ${time2}?`;
              } else if (match?.matched && match.slot) {
                console.log('[BOOKING] User selected slot:', match.slot.label);
              
              // ✅ NEW FLOW: Claim slot → Collect details → Create event
              // Step 1: Check if slot is STILL free
              console.log('[BOOKING] Checking if slot is still available...');
              const stillFree = await gcal.isSlotStillFree(match.slot);
              console.log('[BOOKING] Slot availability:', stillFree);
              
              if (!stillFree) {
                // Slot is no longer available - regenerate
                console.log('[BOOKING] Slot is no longer available, generating new slots');
                const newSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                  daysPrimary: 7,
                  daysFallback: 14
                });
                state.context.slots = newSlots;
                reply = `That slot is no longer available. ${reClose(newSlots, psid)}`;
              } else {
                // Step 2: Claim slot as PENDING (no calendar event yet)
                console.log('[BOOKING] Slot is free, claiming as pending...');
                const claimed = await repo.tryClaimPendingSlot(lead.id, match.slot);

                if (!claimed) {
                  // Already has a pending or booked slot
                  console.log('[BOOKING] Already has pending/booked slot');
                  const freshLead = await repo.getLeadById(lead.id);
                  
                  if (freshLead.pending_slot_label) {
                    // Has pending slot - continue collecting (skip name, go to address)
                    reply = `I'm holding ${freshLead.pending_slot_label} for you. What's the service address?`;
                    state.step = 'post_book_collect';
                    state.context.collectStep = 'address'; // Skip name
                  } else if (freshLead.booked_slot_label) {
                    // Already finalized - shouldn't happen but handle gracefully
                    reply = `You're already booked for ${freshLead.booked_slot_label}. Need to change it?`;
                    state.step = 'post_book_collect';
                    state.context.collectStep = 'done';
                  } else {
                    // Edge case - regenerate
                    const newSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                      daysPrimary: 7,
                      daysFallback: 14
                    });
                    state.context.slots = newSlots;
                    reply = reClose(newSlots, psid);
                  }
                } else {
                  // Step 3: Claim succeeded - start collecting details (skip name, go to address)
                  console.log('[BOOKING] Pending claim succeeded, collecting details...');
                  state.step = 'post_book_collect';
                  state.context.collectStep = 'address'; // Skip name, start with address
                  reply = claimedAskAddress(match.slot.label, psid); // Use PSID as seed
                  
                  // Track pending booking (non-blocking)
                  try {
                    await repo.trackEvent(lead.id, 'slot_claimed_pending', {
                      slot: match.slot.label
                    });
                  } catch (analyticsError) {
                    console.error('[Analytics] Failed to track pending claim:', analyticsError);
                  }
                }
              }
            } else {
              // PRIORITY 1: Check if user mentioned a specific day (without "next" or "this")
              const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
              const normalizedText = text.toLowerCase().trim();
              let mentionedDay: string | null = null;
              
              // Check for explicit day names
              for (const day of dayNames) {
                if (normalizedText.includes(day)) {
                  mentionedDay = day;
                  console.log(`[Day Detection] Found day name: ${mentionedDay}`);
                  break;
                }
              }
              
              if (mentionedDay) {
                  // Track requested day
                  state.context = trackRequestedDay(state.context, mentionedDay!);
                  state.context = trackIntent(state.context, 'day_request');
                  
                  // User mentioned a specific day - check if it's in current slots
                  const hasDay = slots.some(s => s.label.toLowerCase().includes(mentionedDay!));
                
                if (!hasDay) {
                  // Day not in current slots - search calendar for it
                  console.log(`[Day Request] User wants ${mentionedDay}, checking availability`);
                  console.log(`[Day Request] Current slots:`, slots?.map(s => s.label));
                  
                  // Get excluded days from context
                  const excludeDays = getExcludedDays(state.context);
                  console.log(`[Day Request] Excluded days:`, excludeDays);
                  
                  // Generate more slots to try to find the requested day (DON'T exclude the requested day!)
                  console.log(`[Day Request] Generating extended slots (14 days) WITHOUT excluding ${mentionedDay}`);
                  const extendedSlots = await gcal.generateTwoSlotsFixedWindows(14, [], 999); // Get ALL slots!
                  console.log(`[Day Request] Extended slots:`, extendedSlots?.map(s => s.label));
                  console.log(`[Day Request] Extended slots count:`, extendedSlots?.length);
                  
                  // Filter for the requested day
                  let daySlots = extendedSlots.filter(s => 
                    s.label.toLowerCase().includes(mentionedDay!)
                  );
                  
                  // ✅ Dedupe day slots (removes duplicates from multiple weeks)
                  const seen = new Set<string>();
                  daySlots = daySlots.filter(s => {
                    const key = `${s.startISO}|${s.endISO}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  });
                  
                  console.log(`[Day Request] Found ${daySlots.length} slots for ${mentionedDay}`);
                  console.log(`[Day Request] Day slots:`, daySlots?.map(s => s.label));
                  
                  if (daySlots.length >= 2) {
                    // Found multiple slots for requested day - SUCCESS!
                    console.log(`[Day Request] SUCCESS - Found 2+ slots for ${mentionedDay}`);
                    state.context = trackOfferedSlots(state.context, daySlots.slice(0, 2), true); // true = successful match
                    reply = dayClose(mentionedDay!, state.context.slots!, psid); // Use humanized dayClose
                  } else if (daySlots.length === 1) {
                    // Found one slot for requested day, add another from extended slots
                    console.log(`[Day Request] PARTIAL - Found 1 slot for ${mentionedDay}`);
                    const otherSlot = extendedSlots.find(s => 
                      !s.label.toLowerCase().includes(mentionedDay!)
                    );
                    if (otherSlot) {
                      state.context = trackOfferedSlots(state.context, [daySlots[0], otherSlot], true); // true = successful match
                      reply = `I have one ${mentionedDay} slot available. ${reClose(state.context.slots!)}`;
                    } else {
                      state.context = trackOfferedSlots(state.context, [daySlots[0]], true); // true = successful match
                      reply = `I have ${daySlots[0].label} available. Does that work?`;
                    }
                  } else {
                    // No slots found for requested day - offer FRESH alternatives (FAILED match)
                    console.log(`[Day Request] FAILED - No slots found for ${mentionedDay}`);
                    console.log(`[Day Request] ${mentionedDay} not available, generating fresh slots`);
                    
                    // CRITICAL: Exclude the requested day since it's not available
                    const excludeDaysWithRequested = [...excludeDays, mentionedDay];
                    console.log(`[Day Request] Excluding days:`, excludeDaysWithRequested);
                    
                    const freshSlots = await gcal.generateTwoSlotsFixedWindows(14, excludeDaysWithRequested, 2); // Get 2 slots
                    console.log(`[Day Request] Fresh slots:`, freshSlots?.map(s => s.label));
                    
                    if (freshSlots.length >= 2) {
                      state.context = trackOfferedSlots(state.context, freshSlots, false); // false = failed match
                      reply = `I don't have ${mentionedDay} available. How about ${reClose(freshSlots)}`;
                    } else if (freshSlots.length === 1) {
                      state.context = trackOfferedSlots(state.context, [freshSlots[0]], false); // false = failed match                      reply = `I don't have ${mentionedDay} available. I have ${freshSlots[0].label}. Does that work?`;
                    } else {
                      // Check if should ask open-ended
                      if (shouldAskOpenEnded(state.context)) {
                        reply = `What day works best for you? I'll check my calendar and find the best times.`;
                      } else {
                        reply = `I don't have ${mentionedDay} available. What other day works for you?`;
                      }
                    }
                  }
                } else {
                  // Day is in slots but didn't match - clarify
                  reply = `Which time on ${mentionedDay}? Reply with 1 or 2.`;
                }
              } else {
                // PRIORITY 2: No specific day mentioned - check for other patterns
                const qType = detectQuestionType(text);
                console.log('[Question] Detected type:', qType, 'for text:', text);
                
                if (qType === 'availability') {
                  // General availability question - just offer fresh slots
                  console.log('[Availability] User asking about other times, generating fresh slots');
                  state.context = trackIntent(state.context, 'availability_question');
                  
                  const excludeDays = getExcludedDays(state.context);
                  const newSlots = await gcal.generateTwoSlotsFixedWindows(14, excludeDays, 2);
                  
                  if (newSlots.length >= 2) {
                    state.context = trackOfferedSlots(state.context, newSlots);
                    reply = `Sure! ${reClose(newSlots)}`;
                  } else {
                    reply = "What day works best for you?";
                  }
                } else if (qType !== 'unknown') {
                  // FAQ questions - use DeepSeek for intelligent response
                  state.context = trackIntent(state.context, `faq_${qType}`);
                  
                  // CRITICAL: Ensure exactly 2 slots for DeepSeek
                  let slotLabels: string[];
                  if (slots.length >= 2) {
                    slotLabels = [slots[0].label, slots[1].label];
                  } else if (slots.length === 1) {
                    slotLabels = [slots[0].label, slots[0].label];
                  } else {
                    // Generate slots if missing
                    const newSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                      daysPrimary: 7,
                      daysFallback: 14
                    });
                    state.context.slots = newSlots;
                    slotLabels = newSlots.length >= 2
                      ? [newSlots[0].label, newSlots[1].label]
                      : ["available time", "available time"];
                  }
                  
                  console.log('[DeepSeek] Calling API for FAQ with exactly 2 slots:', slotLabels);
                  
                  try {
                    reply = await deepSeekAnswer({
                      env,
                      question: text,
                      serviceName: env.SERVICE_NAME,
                      servicePrice: env.SERVICE_PRICE,
                      addons,
                      slotLabels, // Always exactly 2
                    });
                    console.log('[DeepSeek] SUCCESS:', reply.substring(0, 100) + '...');
                  } catch (e) {
                    console.error('[DeepSeek] FAILED:', e);
                    // Fall back to deterministic answer + hard close
                    const answer = answerQuestion(env, qType, addons);
                    reply = `${answer} ${reClose(slots)}`;
                    console.log('[DeepSeek] Using fallback response');
                  }
                } else if (normalizedText.includes('works') || normalizedText.includes('good') || normalizedText.includes('fine')) {
                  // Ambiguous affirmative - ask for clarification
                  state.context = trackIntent(state.context, 'ambiguous_confirmation');
                  reply = `Great! Which one? Reply with 1 for ${slots[0].label} or 2 for ${slots[1].label}.`;
                } else {
                  // Unknown input - just re-close
                  console.log('[Unknown] Using reClose');
                  state.context = trackIntent(state.context, 'unknown');
                  reply = reClose(slots, psid);
                }
              }
            }
          }
        }
        } else if (state.step === 'post_book_collect') {
          // Honor STOP/HUMAN commands even in post_book_collect (production safety)
          if (detectStop(text)) {
            await repo.setLeadStatus(lead.id, 'dead');
            reply = stopResponse();
          } else if (detectHuman(text)) {
            await repo.setLeadStatus(lead.id, 'needs_followup');
            reply = humanResponse();
          } else if (detectChangeRequest(text)) {
            // User wants to change/reschedule their booking
            console.log('[CHANGE] User requesting to change booking');
            
            // Check if they mentioned a specific day
            const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const normalizedText = text.toLowerCase().trim();
            let mentionedDay = null;
            
            for (const day of dayNames) {
              if (normalizedText.includes(day)) {
                mentionedDay = day;
                break;
              }
            }
            
            // Release current booking
            await repo.releaseBookingClaim(lead.id);
            await repo.setLeadStatus(lead.id, 'active');
            
            // Reset to closing state
            state.step = 'closing';
            state.context.collectStep = undefined;
            state.context.name = undefined;
            state.context.address = undefined;
            
            if (mentionedDay) {
              // User wants a specific day - search for it
              console.log(`[CHANGE] User wants ${mentionedDay}`);
              state.context = trackRequestedDay(state.context, mentionedDay);
              
              const excludeDays = getExcludedDays(state.context);
              const extendedSlots = await gcal.generateTwoSlotsFixedWindows(14, [], 999);
              
              const daySlots = extendedSlots.filter(s => 
                s.label.toLowerCase().includes(mentionedDay)
              );
              
              if (daySlots.length >= 2) {
                state.context = trackOfferedSlots(state.context, daySlots.slice(0, 2));
                reply = `No problem! For ${mentionedDay}, ${reClose(state.context.slots!)}`;
              } else if (daySlots.length === 1) {
                const otherSlot = extendedSlots.find(s => 
                  !s.label.toLowerCase().includes(mentionedDay)
                );
                if (otherSlot) {
                  state.context = trackOfferedSlots(state.context, [daySlots[0], otherSlot]);
                  reply = `No problem! I have one ${mentionedDay} slot. ${reClose(state.context.slots!)}`;
                } else {
                  state.context = trackOfferedSlots(state.context, [daySlots[0]]);
                  reply = `No problem! I have ${daySlots[0].label} available. Does that work?`;
                }
              } else {
                const freshSlots = await gcal.generateTwoSlotsFixedWindows(14, excludeDays, 2);
                if (freshSlots.length >= 2) {
                  state.context = trackOfferedSlots(state.context, freshSlots);
                  reply = `No problem! I don't have ${mentionedDay} available. How about ${reClose(freshSlots)}`;
                } else {
                  reply = "No problem! What day works best for you?";
                }
              }
            } else {
              // Generic change request - offer new slots
              const excludeDays = getExcludedDays(state.context);
              const newSlots = await gcal.generateTwoSlotsFixedWindows(14, excludeDays, 2);
              
              if (newSlots.length >= 2) {
                state.context = trackOfferedSlots(state.context, newSlots);
                reply = `No problem, we can adjust your appointment. ${reClose(newSlots)}`;
              } else {
                reply = "No problem! What day works best for you?";
              }
            }
          } else {
            // OUT-OF-ORDER GUARD: Reject slot matches in post_book_collect
            const slots = state.context.slots ?? [];
            const match = tryMatchSlot(text, slots);
            
            if (match?.matched && match.slot) {
              // Late slot selection - check if they have pending or booked
              const freshLead = await repo.getLeadById(lead.id);
              
              if (freshLead.pending_slot_label) {
                reply = `I'm already holding ${freshLead.pending_slot_label} for you. What's the service address?`;
                state.context.collectStep = 'address'; // Skip name
              } else if (freshLead.booked_slot_label) {
                reply = `You're already booked for ${freshLead.booked_slot_label}. What's the address and phone for the service?`;
                state.context.collectStep = state.context.collectStep ?? 'address'; // Skip name
              } else {
                // No pending/booked - shouldn't happen but handle gracefully
                reply = "What's the service address?";
                state.context.collectStep = 'address'; // Skip name
              }
            } else {
              const qType = detectQuestionType(text);
              if (qType !== 'unknown') {
                const answer = answerQuestion(env, qType, addons);
                reply = `${answer} If you need to change it, tell me and I'll adjust`;
              } else {
                // ✅ NEW FLOW: Collect address → phone → THEN create calendar event
                const collectStep = state.context.collectStep ?? 'address'; // Start with address (skip name)
                
                if (collectStep === 'address') {
                  // Collect address
                  state.context.address = text;
                  state.context.collectStep = 'phone';
                  reply = collectedAddressAskPhone(psid); // Use PSID as seed
                  
                } else if (collectStep === 'phone') {
                  // ========== PHONE COLLECTION & BOOKING FINALIZATION ==========
                  console.log('[BOOKING] ========== PHONE COLLECTION STARTED ==========');
                  console.log('[BOOKING] collectStep:', state.context.collectStep);
                  console.log('[BOOKING] address:', state.context.address);
                  console.log('[BOOKING] phone (user input):', text);
                  console.log('[BOOKING] lead.id:', lead.id);
                  console.log('[BOOKING] psid:', psid);
                  
                  // Collect phone - NOW finalize booking
                  state.context.phone = text;
                  
                  console.log('[BOOKING] All details collected, starting finalization...');
                  
                  // ===== STEP 1: Get pending slot =====
                  console.log('[BOOKING] Step 1: Retrieving pending slot...');
                  console.log('[BOOKING] Calling repo.getPendingSlot() for lead:', lead.id);
                  
                  const pending = await repo.getPendingSlot(lead.id);
                  
                  console.log('[BOOKING] Pending slot result:', pending ? {
                    label: pending.label,
                    startISO: pending.startISO,
                    endISO: pending.endISO,
                    claimedAt: pending.claimedAt,
                    ageMinutes: pending.claimedAt ? 
                      ((new Date().getTime() - new Date(pending.claimedAt).getTime()) / (1000 * 60)).toFixed(1) : 
                      'unknown'
                  } : 'NULL (expired or missing)');
                  
                  if (!pending) {
                    // Pending slot expired or missing - restart
                    console.log('[BOOKING] ⚠️ No pending slot found - expired or missing');
                    console.log('[BOOKING] Releasing pending claim and restarting flow...');
                    await repo.releasePendingClaim(lead.id);
                    
                    const newSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                      daysPrimary: 7,
                      daysFallback: 14
                    });
                    state.context.slots = newSlots;
                    state.step = 'closing';
                    state.context.collectStep = undefined;
                    reply = pendingExpired(newSlots, psid); // Use PSID as seed
                    console.log('[BOOKING] Flow restarted with new slots');
                    
                  } else {
                    // Validate pending slot structure
                    if (!pending.label || !pending.startISO || !pending.endISO) {
                      console.error('[BOOKING] ⚠️ Invalid pending slot data structure:', {
                        hasLabel: !!pending.label,
                        hasStartISO: !!pending.startISO,
                        hasEndISO: !!pending.endISO,
                        pending: pending
                      });
                      // Restart flow
                      await repo.releasePendingClaim(lead.id);
                      const newSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                        daysPrimary: 7,
                        daysFallback: 14
                      });
                      state.context.slots = newSlots;
                      state.step = 'closing';
                      state.context.collectStep = undefined;
                      reply = pendingExpired(newSlots, psid);
                      console.log('[BOOKING] Flow restarted due to invalid pending slot data');
                    } else {
                      console.log('[BOOKING] ✅ Pending slot data validated');
                      
                      // Validate customer details (address and phone only, no name needed)
                      if (!state.context.address || !state.context.phone) {
                        console.error('[BOOKING] ⚠️ Missing customer details:', {
                          hasAddress: !!state.context.address,
                          hasPhone: !!state.context.phone
                        });
                        
                        // Restart collection from missing field
                        if (!state.context.address) {
                          state.context.collectStep = 'address';
                          reply = "I'm missing your address. What's the service address?";
                        } else {
                          state.context.collectStep = 'phone';
                          reply = "I'm missing your phone number. What's the best number to reach you?";
                        }
                      } else {
                        console.log('[BOOKING] ✅ Customer details validated');
                        
                        // ===== STEP 2: Staleness check - is slot still free? =====
                        console.log('[BOOKING] Step 2: Checking if slot still free...');
                        console.log('[BOOKING] Slot to check:', {
                          label: pending.label,
                          startISO: pending.startISO,
                          endISO: pending.endISO
                        });
                        
                        const stillFree = await gcal.isSlotStillFree({
                          label: pending.label,
                          startISO: pending.startISO,
                          endISO: pending.endISO
                        });
                        
                        console.log('[BOOKING] Staleness check result:', stillFree ? '✅ STILL FREE' : '❌ TAKEN');
                        
                        if (!stillFree) {
                          // Slot got taken - restart
                          console.log('[BOOKING] ⚠️ Pending slot no longer available, restarting');
                          await repo.releasePendingClaim(lead.id);
                          
                          const newSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                            daysPrimary: 7,
                            daysFallback: 14
                          });
                          state.context.slots = newSlots;
                          state.step = 'closing';
                          state.context.collectStep = undefined;
                          reply = pendingExpired(newSlots, psid); // Use PSID as seed
                          console.log('[BOOKING] Flow restarted with new slots');
                          
                        } else {
                          // ===== STEP 3: Create calendar event =====
                          console.log('[BOOKING] Step 3: Creating calendar event...');
                          console.log('[BOOKING] Event details:', {
                            slot: {
                              label: pending.label,
                              startISO: pending.startISO,
                              endISO: pending.endISO
                            },
                            summary: env.SERVICE_NAME,
                            customerAddress: state.context.address,
                            customerPhone: state.context.phone,
                            psid: psid
                          });
                          
                          try {
                            const customerDetails = `Address: ${state.context.address}
Phone: ${state.context.phone}
PSID: ${psid}`;
                            
                            console.log('[BOOKING] Calling gcal.createEvent()...');
                            
                            const eventId = await gcal.createEvent(
                              {
                                label: pending.label,
                                startISO: pending.startISO,
                                endISO: pending.endISO
                              },
                              env.SERVICE_NAME,
                              customerDetails
                            );
                            
                            console.log('[BOOKING] ✅ Calendar event created successfully!');
                            console.log('[BOOKING] Event ID:', eventId);
                            console.log('[BOOKING] Event ID type:', typeof eventId);
                            console.log('[BOOKING] Event ID length:', eventId?.length);
                            
                            // Validate event ID
                            if (!eventId || typeof eventId !== 'string' || eventId.length === 0) {
                              console.error('[BOOKING] ⚠️ Invalid event ID returned from Google Calendar API:', {
                                eventId: eventId,
                                type: typeof eventId,
                                length: eventId?.length
                              });
                              throw new Error('Invalid event ID from Google Calendar API');
                            }
                            
                            console.log('[BOOKING] ✅ Event ID validated');
                            
                            // ===== STEP 4: Finalize in database =====
                            console.log('[BOOKING] Step 4: Finalizing booking in database...');
                            console.log('[BOOKING] Finalization params:', {
                              leadId: lead.id,
                              eventId: eventId,
                              address: state.context.address,
                              phone: state.context.phone
                            });
                            
                            await repo.finalizeBookingWithDetails(lead.id, eventId, {
                              address: state.context.address!,
                              phone: state.context.phone!
                            });
                            
                            console.log('[BOOKING] ✅ Booking finalized in database successfully!');
                            console.log('[BOOKING] ========== BOOKING COMPLETE ==========');
                            
                            // Send email notification (non-blocking)
                            try {
                              console.log('[EMAIL] Sending chatbot booking notification...');
                              await sendChatbotBookingEmail(env, {
                                slotLabel: pending.label,
                                address: state.context.address!,
                                phone: state.context.phone!,
                                psid: psid,
                                eventId: eventId
                              });
                            } catch (emailError) {
                              console.error('[EMAIL] Failed to send notification:', emailError);
                              // Don't fail the booking if email fails
                            }
                            
                            // Track booking completed (non-blocking) - BEFORE resetting context
                            try {
                              await repo.trackEvent(lead.id, 'booking_completed', {
                                slot: pending.label,
                                eventId,
                                address: state.context.address,
                                phone: state.context.phone
                              });
                            } catch (analyticsError) {
                              console.error('[Analytics] Failed to track booking:', analyticsError);
                            }
                            
                            // ✅ DISABLE BOT: Let human take over after booking is complete
                            console.log('[BOOKING] Disabling bot for this lead - human takeover');
                            await repo.disableBot(lead.id);
                            
                            // ✅ RESET STATE: Allow user to book again or ask new questions
                            console.log('[BOOKING] Resetting conversation state for fresh start');
                            state.step = 'start';
                            state.context = initializeContext({});
                            
                            reply = finalizedBooking(pending.label, psid); // Use PSID as seed
                            
                          } catch (eventError) {
                            // Calendar event creation failed - restart
                            console.error('[BOOKING] ❌❌❌ EVENT CREATION FAILED ❌❌❌');
                            console.error('[BOOKING] Error type:', (eventError as any)?.constructor?.name);
                            console.error('[BOOKING] Error message:', (eventError as Error)?.message);
                            console.error('[BOOKING] Error stack:', (eventError as Error)?.stack);
                            
                            // Try to stringify the error object
                            try {
                              console.error('[BOOKING] Full error object:', JSON.stringify(eventError, Object.getOwnPropertyNames(eventError), 2));
                            } catch (stringifyError) {
                              console.error('[BOOKING] Could not stringify error:', eventError);
                            }
                            
                            // Log the request that failed
                            console.error('[BOOKING] Failed request details:', {
                              slot: {
                                label: pending.label,
                                startISO: pending.startISO,
                                endISO: pending.endISO
                              },
                              summary: env.SERVICE_NAME,
                              hasCustomerDetails: !!(state.context.address && state.context.phone)
                            });
                            
                            await repo.releasePendingClaim(lead.id);
                            
                            const newSlots = await gcal.generateTwoSlots(env.GOOGLE_TIMEZONE, {
                              daysPrimary: 7,
                              daysFallback: 14
                            });
                            state.context.slots = newSlots;
                            state.step = 'closing';
                            state.context.collectStep = undefined;
                            reply = `Sorry — that slot got taken. ${reClose(newSlots, psid)}`;
                            console.log('[BOOKING] Flow restarted after event creation failure');
                          }
                        }
                      }
                    }
                  }
                  
                } else {
                  // collectStep === 'done' - allow updates after collection
                  reply = "Got it. If you need to change it, tell me and I'll adjust.";
                }
              }
            }
          }
        }

        // Persist state
        await repo.upsertConvoState(lead.id, state.step, state.context);

        // ✅ FIX #6: Enhanced outbound logging with dedupeKey, mid, and slot labels
        const logPayload: any = { 
          psid, 
          step: state.step,
          dedupeKey,
          mid: ev.message?.mid ?? null,
          send_payload: { text: reply }
        };
        
        // Add slot labels if present
        if (state.context.slots && Array.isArray(state.context.slots)) {
          logPayload.slots = state.context.slots.map((s: any) => s.label);
        }
        
        await repo.insertOutboundMessage(lead.id, reply, logPayload);
        
        // Phase 2: Save assistant response to conversation history (non-blocking)
        try {
          await repo.saveConversationHistory(lead.id, 'assistant', reply);
        } catch (historyError) {
          console.error('[History] Failed to save assistant response:', historyError);
        }
        
        // Phase 3: Save detected intent if available (non-blocking)
        try {
          if (state.context.lastIntent) {
            await repo.saveIntent(lead.id, text, state.context.lastIntent);
          }
        } catch (intentError) {
          console.error('[Intent] Failed to save:', intentError);
        }
        
        // Phase 5: Track analytics events (non-blocking)
        try {
          if (state.context.slots && state.step === 'closing') {
            await repo.trackEvent(lead.id, 'slots_offered', {
              slots: state.context.slots.map((s: any) => s.label),
              attemptCount: state.context.attemptCount || 0
            });
          }
        } catch (analyticsError) {
          console.error('[Analytics] Failed to track slots offered:', analyticsError);
        }

        // Send
        await sendTextMessage(psid, reply, env.FB_PAGE_ACCESS_TOKEN);
      } catch (err) {
        console.error('Processing error:', err);

        // Global error handler: send fallback message
        const fallback = 'Sorry — something went wrong. What day/time works for you?';
        try {
          const lead = await repo.upsertLeadByPsid(ev.sender?.id);
          await repo.insertOutboundMessage(lead.id, fallback, {
            psid: ev.sender?.id,
            error: String(err)
          });
          await sendTextMessage(ev.sender?.id, fallback, env.FB_PAGE_ACCESS_TOKEN);
        } catch (sendError) {
          console.error('Failed to send error message:', sendError);
        }
      }
    }
  }
}

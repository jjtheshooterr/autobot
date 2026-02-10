/**
 * Context management utilities
 * Helpers for tracking conversation state and context
 */

import type { ConvoState, Slot } from './types';

/**
 * Extract day name from slot label
 * "Friday at 3:00 PM" -> "friday"
 */
export function extractDayName(slotLabel: string): string {
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const normalized = slotLabel.toLowerCase();
  
  for (const day of dayNames) {
    if (normalized.includes(day)) {
      return day;
    }
  }
  
  return '';
}

/**
 * Get days from slots
 */
export function getDaysFromSlots(slots: Slot[]): string[] {
  return slots
    .map(s => extractDayName(s.label))
    .filter(d => d !== '');
}

/**
 * Initialize context with defaults
 */
export function initializeContext(context: ConvoState['context']): ConvoState['context'] {
  return {
    ...context,
    offeredDays: context.offeredDays || [],
    attemptCount: context.attemptCount || 0,
    lastIntent: context.lastIntent || 'unknown'
  };
}

/**
 * Track offered slots in context
 * IMPORTANT: Only increment attemptCount if we're offering DIFFERENT days than requested
 */
export function trackOfferedSlots(
  context: ConvoState['context'],
  slots: Slot[],
  isSuccessfulMatch: boolean = false
): ConvoState['context'] {
  const newDays = getDaysFromSlots(slots);
  const existingDays = context.offeredDays || [];
  
  // Merge and deduplicate
  const allDays = [...new Set([...existingDays, ...newDays])];
  
  // Only increment attempt count if this is NOT a successful match to user's request
  const newAttemptCount = isSuccessfulMatch 
    ? 0  // Reset on successful match
    : (context.attemptCount || 0) + 1;  // Increment on failed match
  
  return {
    ...context,
    slots,
    offeredDays: allDays,
    attemptCount: newAttemptCount
  };
}

/**
 * Track requested day
 */
export function trackRequestedDay(
  context: ConvoState['context'],
  day: string
): ConvoState['context'] {
  return {
    ...context,
    requestedDay: day
  };
}

/**
 * Track detected intent
 */
export function trackIntent(
  context: ConvoState['context'],
  intent: string
): ConvoState['context'] {
  return {
    ...context,
    lastIntent: intent
  };
}

/**
 * Check if should trigger graceful degradation
 */
export function shouldTriggerGracefulDegradation(context: ConvoState['context']): boolean {
  return (context.attemptCount || 0) >= 3;
}

/**
 * Check if should ask open-ended question
 */
export function shouldAskOpenEnded(context: ConvoState['context']): boolean {
  return (context.attemptCount || 0) >= 2;
}

/**
 * Reset attempt counter
 */
export function resetAttemptCount(context: ConvoState['context']): ConvoState['context'] {
  return {
    ...context,
    attemptCount: 0
  };
}

/**
 * Get excluded days for slot generation
 */
export function getExcludedDays(context: ConvoState['context']): string[] {
  return context.offeredDays || [];
}

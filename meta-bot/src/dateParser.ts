/**
 * Date parsing utilities for explicit date requests
 * Handles "the 17th", "February 17", "next Monday", "this Sunday", etc.
 */

/**
 * Extract explicit requested date from user text
 * Returns Date object for the requested day, or null if no date found
 */
export function extractRequestedDate(text: string, now: Date, timeZone: string): Date | null {
  const cleaned = text.toLowerCase().trim();
  
  // PRIORITY 1: Handle relative day expressions (next Monday, this Sunday, etc.)
  const relativeDateResult = parseRelativeDate(cleaned, now, timeZone);
  if (relativeDateResult) return relativeDateResult;
  
  // PRIORITY 2: Handle explicit dates like "the 17th", "February 17"
  // IMPORTANT: Don't match bare numbers that could be times (12, 3, etc.)
  // Only match if:
  // - Has "the" prefix: "the 12th"
  // - Has ordinal suffix: "12th", "3rd"
  // - Has month name: "February 12"
  // - Has day name: "Tuesday 12"
  
  // Check for time indicators that mean this is NOT a date
  const timeIndicators = [
    /\b(am|pm)\b/i,
    /\b\d{1,2}:\d{2}/,  // 12:00, 3:30
    /\bat\s+\d{1,2}\b/i  // "at 12", "at 3"
  ];
  
  if (timeIndicators.some(pattern => pattern.test(cleaned))) {
    return null; // This is a time, not a date
  }
  
  // Match dates with clear indicators
  const dateMatch = cleaned.match(/\b(?:the\s+)?(\d{1,2})(st|nd|rd|th)\b/);
  if (dateMatch) {
    const dayOfMonth = parseInt(dateMatch[1], 10);
    if (dayOfMonth >= 1 && dayOfMonth <= 31) {
      return parseDateNumber(dayOfMonth, cleaned, now, timeZone);
    }
  }
  
  // Check for month name + number (e.g., "February 12")
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  
  for (let i = 0; i < monthNames.length; i++) {
    if (cleaned.includes(monthNames[i])) {
      const numberMatch = cleaned.match(/\b(\d{1,2})\b/);
      if (numberMatch) {
        const dayOfMonth = parseInt(numberMatch[1], 10);
        if (dayOfMonth >= 1 && dayOfMonth <= 31) {
          return parseDateNumber(dayOfMonth, cleaned, now, timeZone);
        }
      }
    }
  }
  
  // Check for day name + number (e.g., "Tuesday 12")
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const dayName of dayNames) {
    if (cleaned.includes(dayName)) {
      const numberMatch = cleaned.match(/\b(\d{1,2})\b/);
      if (numberMatch) {
        const dayOfMonth = parseInt(numberMatch[1], 10);
        if (dayOfMonth >= 1 && dayOfMonth <= 31) {
          return parseDateNumber(dayOfMonth, cleaned, now, timeZone);
        }
      }
    }
  }
  
  return null;
}

/**
 * Helper to parse a day number into a Date object
 */
function parseDateNumber(dayOfMonth: number, text: string, now: Date, timeZone: string): Date | null {
  // Get local year/month in timezone
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(now);
  
  const year = parseInt(parts.find(p => p.type === "year")?.value || "0", 10);
  const month = parseInt(parts.find(p => p.type === "month")?.value || "0", 10);
  
  // Check for explicit month name in text
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  
  let targetMonth = month;
  for (let i = 0; i < monthNames.length; i++) {
    if (text.includes(monthNames[i])) {
      targetMonth = i + 1; // 1-indexed
      break;
    }
  }
  
  // Create date in local month
  let candidate = new Date(Date.UTC(year, targetMonth - 1, dayOfMonth, 12, 0, 0));
  
  // If candidate already passed this month, roll into next month
  if (candidate.getTime() < now.getTime()) {
    candidate = new Date(Date.UTC(year, targetMonth, dayOfMonth, 12, 0, 0));
  }
  
  return candidate;
}

/**
 * Parse relative date expressions like "next Monday", "this Sunday", "tomorrow"
 * Returns Date object or null if no relative date found
 */
function parseRelativeDate(text: string, now: Date, timeZone: string): Date | null {
  const cleaned = text.toLowerCase().trim();
  
  // Get current day of week (0 = Sunday, 6 = Saturday)
  const currentDayOfWeek = now.getUTCDay();
  
  // Day name mapping
  const dayNames: { [key: string]: number } = {
    'sunday': 0,
    'monday': 1,
    'tuesday': 2,
    'wednesday': 3,
    'thursday': 4,
    'friday': 5,
    'saturday': 6
  };
  
  // Handle "tomorrow"
  if (cleaned.includes('tomorrow')) {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);
    return tomorrow;
  }
  
  // Handle "today"
  if (cleaned.includes('today')) {
    const today = new Date(now);
    today.setUTCHours(12, 0, 0, 0);
    return today;
  }
  
  // Check for day names with modifiers
  for (const [dayName, targetDay] of Object.entries(dayNames)) {
    if (!cleaned.includes(dayName)) continue;
    
    // Determine if it's "next", "this", or just the day name
    const hasNext = cleaned.includes('next');
    const hasThis = cleaned.includes('this');
    
    let daysToAdd = 0;
    
    if (hasNext) {
      // "next Monday" = the Monday in the next week (always at least 7 days away)
      // If today is Monday and they say "next Monday", it should be 7 days from now
      daysToAdd = (targetDay - currentDayOfWeek + 7) % 7;
      if (daysToAdd === 0) daysToAdd = 7; // If same day, go to next week
      if (daysToAdd < 7) daysToAdd += 7; // Ensure it's always next week (7-13 days away)
    } else if (hasThis) {
      // "this Monday" = the upcoming Monday in this week (0-6 days away)
      // If today is Monday and they say "this Monday", it should be today
      daysToAdd = (targetDay - currentDayOfWeek + 7) % 7;
      // If daysToAdd is 0, it means today - keep it as 0
    } else {
      // Just "Monday" = the next occurrence (same as "this Monday")
      // If today is Monday and they say "Monday", assume they mean today or upcoming
      daysToAdd = (targetDay - currentDayOfWeek + 7) % 7;
      // If daysToAdd is 0, it means today - keep it as 0
    }
    
    const targetDate = new Date(now);
    targetDate.setUTCDate(targetDate.getUTCDate() + daysToAdd);
    targetDate.setUTCHours(12, 0, 0, 0);
    
    return targetDate;
  }
  
  return null;
}

/**
 * Set local time for a date in a specific timezone
 * Returns UTC Date object representing that local time
 */
export function setLocalTime(base: Date, hour: number, minute: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(base);
  
  const year = parseInt(parts.find(p => p.type === "year")?.value || "0", 10);
  const month = parseInt(parts.find(p => p.type === "month")?.value || "0", 10);
  const day = parseInt(parts.find(p => p.type === "day")?.value || "0", 10);
  
  // Create local time string
  const localStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  
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
  
  const tzParts = formatter.formatToParts(utcDate);
  const tzHour = parseInt(tzParts.find(p => p.type === 'hour')?.value || '0');
  
  // Calculate offset: how many hours difference between what we want and what UTC gives us
  const offsetHours = hour - tzHour;
  
  // Apply offset to get correct UTC time
  return new Date(Date.UTC(year, month - 1, day, hour + offsetHours, minute, 0));
}

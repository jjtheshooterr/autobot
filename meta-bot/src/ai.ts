/**
 * AI-powered conversation features
 * Intent detection, context-aware responses, and conversation management
 */

import type { Env } from './types';
import { deepSeekAnswer } from './deepseek';

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Intent {
  type: string;
  confidence: number;
  reasoning: string;
}

export interface FAQ {
  question: string;
  answer: string;
  category: string;
}

/**
 * Detect user intent using AI
 */
export async function detectIntent(
  message: string,
  history: ConversationMessage[]
): Promise<Intent> {
  const systemPrompt = `You are an intent classifier for a booking chatbot.

Classify the user's message into ONE of these intents:
- booking_request: User wants to book an appointment
- availability_check: User asking about specific day/time availability  
- day_request: User mentions a specific day (Sunday, Monday, etc.)
- question_pricing: User asking about price/cost
- question_service: User asking what's included
- question_location: User asking about service area
- question_duration: User asking how long it takes
- cancel: User wants to cancel or stop
- human_request: User wants to talk to a human
- confirmation: User confirming a selection (yes, that works, etc.)
- unclear: Cannot determine intent

Return ONLY valid JSON in this exact format:
{"intent": "...", "confidence": 0.95, "reasoning": "..."}`;

  try {
    const response = await deepSeekAnswer({
      env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } as any,
      question: message,
      serviceName: '',
      servicePrice: '',
      dogHairMin: '',
      dogHairMax: '',
      slotLabels: []
    });

    // Try to parse JSON from response
    const jsonMatch = response.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        type: parsed.intent || 'unclear',
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || ''
      };
    }
  } catch (error) {
    console.error('[AI] Intent detection failed:', error);
  }

  // Fallback to simple keyword matching
  return detectIntentFallback(message);
}

/**
 * Fallback intent detection using keywords
 */
function detectIntentFallback(message: string): Intent {
  const normalized = message.toLowerCase().trim();
  
  // Day names
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const day of dayNames) {
    if (normalized.includes(day)) {
      return { type: 'day_request', confidence: 0.9, reasoning: `Mentioned ${day}` };
    }
  }
  
  // Pricing
  if (normalized.includes('price') || normalized.includes('cost') || normalized.includes('how much')) {
    return { type: 'question_pricing', confidence: 0.9, reasoning: 'Asking about price' };
  }
  
  // Service
  if (normalized.includes('include') || normalized.includes('what do you')) {
    return { type: 'question_service', confidence: 0.9, reasoning: 'Asking about service' };
  }
  
  // Location
  if (normalized.includes('where') || normalized.includes('area') || normalized.includes('zip')) {
    return { type: 'question_location', confidence: 0.9, reasoning: 'Asking about location' };
  }
  
  // Duration
  if (normalized.includes('long') || normalized.includes('duration')) {
    return { type: 'question_duration', confidence: 0.9, reasoning: 'Asking about duration' };
  }
  
  // Cancel
  if (normalized.includes('cancel') || normalized.includes('stop') || normalized.includes('nevermind')) {
    return { type: 'cancel', confidence: 0.95, reasoning: 'Wants to cancel' };
  }
  
  // Human
  if (normalized.includes('human') || normalized.includes('agent') || normalized.includes('call me')) {
    return { type: 'human_request', confidence: 0.95, reasoning: 'Wants human' };
  }
  
  // Confirmation
  if (normalized.match(/^(yes|yeah|yep|sure|ok|okay|sounds good|that works|perfect)$/)) {
    return { type: 'confirmation', confidence: 0.9, reasoning: 'Confirming' };
  }
  
  // Availability
  if (normalized.includes('available') || normalized.includes('other') || normalized.includes('different')) {
    return { type: 'availability_check', confidence: 0.8, reasoning: 'Asking about availability' };
  }
  
  return { type: 'unclear', confidence: 0.3, reasoning: 'Could not determine intent' };
}

/**
 * Generate context-aware response using AI with conversation history and FAQs
 */
export async function generateContextualResponse(
  env: Env,
  message: string,
  history: ConversationMessage[],
  faqs: FAQ[],
  slots: Array<{ label: string }>,
  context: any
): Promise<string> {
  const faqContext = faqs.length > 0
    ? `\n\nRELEVANT FAQs:\n${faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}`
    : '';

  const historyContext = history.length > 0
    ? `\n\nCONVERSATION HISTORY:\n${history.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n')}`
    : '';

  const contextInfo = `
CURRENT CONTEXT:
- Available slots: ${slots.map(s => s.label).join(', ')}
- Already offered days: ${(context.offeredDays || []).join(', ')}
- Attempt count: ${context.attemptCount || 0}
- Last intent: ${context.lastIntent || 'unknown'}`;

  const systemPrompt = `You are a friendly, professional booking assistant for Sparkle Auto Detailing.

BUSINESS INFO:
- Service: ${env.SERVICE_NAME}
- Price: ${env.SERVICE_PRICE}
- Dog hair add-on: ${env.DOG_HAIR_MIN}–${env.DOG_HAIR_MAX}
- Service area: Northern Utah
- Hours: 12-3 PM and 3-6 PM slots
${faqContext}
${contextInfo}
${historyContext}

INSTRUCTIONS:
1. Answer the user's question naturally and conversationally
2. Be concise (2-3 sentences max)
3. ALWAYS end by offering the available slots
4. Use a friendly, professional tone
5. If you don't know something, say so honestly
6. Never make up information not provided above

Format your response to naturally flow into offering the slots.`;

  try {
    const response = await deepSeekAnswer({
      env,
      question: message,
      serviceName: env.SERVICE_NAME,
      servicePrice: env.SERVICE_PRICE,
      dogHairMin: env.DOG_HAIR_MIN,
      dogHairMax: env.DOG_HAIR_MAX,
      slotLabels: slots.map(s => s.label)
    });

    return response;
  } catch (error) {
    console.error('[AI] Contextual response failed:', error);
    // Fallback to simple response
    return `We have ${slots[0].label} and ${slots[1].label} — which one works for you?`;
  }
}

/**
 * Extract keywords from message for FAQ matching
 */
export function extractKeywords(message: string): string[] {
  const normalized = message.toLowerCase();
  const keywords: string[] = [];
  
  // Common question words
  const questionWords = ['price', 'cost', 'how much', 'included', 'include', 'where', 'area', 'location', 'long', 'duration', 'dog', 'pet', 'hair'];
  
  for (const word of questionWords) {
    if (normalized.includes(word)) {
      keywords.push(word);
    }
  }
  
  return keywords;
}

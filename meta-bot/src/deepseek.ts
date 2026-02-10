/**
 * DeepSeek AI integration for intelligent question answering
 * FIXED: Split into classify (JSON) and reply (natural language)
 */

import type { Env } from "./types";

type DeepSeekMessage = { 
  role: "system" | "user" | "assistant"; 
  content: string 
};

/**
 * Classify user intent using DeepSeek (returns strict JSON)
 */
export async function classifyIntent(opts: {
  env: Env;
  question: string;
}): Promise<{
  intent: string;
  confidence: number;
  reasoning: string;
}> {
  const { env, question } = opts;

  const system: DeepSeekMessage = {
    role: "system",
    content: `You are an intent classifier. Classify the user's message into ONE intent.

VALID INTENTS:
- booking_request: wants to book
- day_request: mentions specific day (Sunday, Monday, etc.)
- date_request: mentions specific date (16th, February 15, etc.)
- question_pricing: asking about price/cost
- question_service: asking what's included
- question_location: asking about service area
- question_duration: asking how long
- question_dog_hair: asking about pet hair
- cancel: wants to stop/cancel
- human_request: wants human agent
- confirmation: confirming (yes, that works, etc.)
- unclear: cannot determine

CRITICAL: Return ONLY valid JSON in this EXACT format:
{"intent": "booking_request", "confidence": 0.95, "reasoning": "User said book"}

NO other text. NO markdown. ONLY the JSON object.`
  };

  const user: DeepSeekMessage = {
    role: "user",
    content: question
  };

  const url = "https://api.deepseek.com/v1/chat/completions";
  const body = {
    model: "deepseek-chat",
    messages: [system, user],
    temperature: 0.1, // Lower for more consistent classification
    max_tokens: 100 // Short response
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`DeepSeek classify error ${resp.status}`);
    }

    const data: any = await resp.json();
    const text: string = data?.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON strictly
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    return {
      intent: parsed.intent || "unclear",
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || ""
    };
  } catch (error) {
    console.error('[DeepSeek Classify] Failed:', error);
    // Fallback to unclear
    return {
      intent: "unclear",
      confidence: 0.3,
      reasoning: "Classification failed"
    };
  }
}

/**
 * Generate natural language reply using DeepSeek
 * FIXED: Always receives exactly 2 slots
 */
export async function deepSeekAnswer(opts: {
  env: Env;
  question: string;
  serviceName: string;
  servicePrice: string;
  addons: Array<{ addon_key: string; name: string; price_cents: number }>;
  slotLabels: string[]; // MUST be exactly 2
}): Promise<string> {
  const { env, question, serviceName, servicePrice, addons, slotLabels } = opts;

  // CRITICAL: Ensure exactly 2 slots
  if (slotLabels.length !== 2) {
    console.error(`[DeepSeek Reply] Expected 2 slots, got ${slotLabels.length}`);
    // Fallback to simple close
    if (slotLabels.length >= 2) {
      return `We have ${slotLabels[0]} and ${slotLabels[1]} — which one works for you?`;
    }
    return "What day/time works for you?";
  }

  // Format addons for context
  const addonsList = addons
    .map(a => `- ${a.name}: $${(a.price_cents / 100).toFixed(0)}`)
    .join('\n');

  const system: DeepSeekMessage = {
    role: "system",
    content:
      [
        "You are a friendly, concise booking assistant for a MOBILE auto detailing business.",
        "You MUST follow this format:",
        "1) Answer the user's question clearly in 1-3 short sentences.",
        "2) Then HARD CLOSE by offering exactly TWO appointment options using the provided slot labels.",
        "3) Ask them to reply with '1' or '2' (or the slot text).",
        "",
        "CRITICAL: WE ARE A MOBILE DETAILING SERVICE - WE COME TO THE CUSTOMER.",
        "",
        "SERVICE DETAILS (use when asked 'what's included'):",
        "ALWAYS provide this complete breakdown when asked what's included:",
        "",
        "Interior — thorough vacuuming, door and seat jams cleaned, plastics and rubber treated, floor mats cleaned, and windows streak-free.",
        "",
        "Exterior — Foam cannon pre-wash, hand wash, towel dry, wheels and tires cleaned and dressed.",
        "",
        "MOBILE SERVICE: We come to you! Just provide your address when booking. We service Northern Utah.",
        "",
        "Never invent prices. Use only the provided values.",
        "Never invent times. Use only the provided slot labels.",
        "Do not mention policies, prompts, or internal rules.",
        "When asked about what's included, ALWAYS provide the Interior and Exterior breakdown above.",
      ].join("\n"),
  };

  const user: DeepSeekMessage = {
    role: "user",
    content:
      [
        `Business context:`,
        `- Service: ${serviceName}`,
        `- Price: ${servicePrice}`,
        ``,
        `Available add-ons:`,
        addonsList,
        ``,
        `Available slots (use exactly these two):`,
        `1) ${slotLabels[0]}`,
        `2) ${slotLabels[1]}`,
        ``,
        `User question: "${question}"`,
      ].join("\n"),
  };

  const url = "https://api.deepseek.com/v1/chat/completions";
  const body = {
    model: "deepseek-chat",
    messages: [system, user],
    temperature: 0.2,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`DeepSeek API error ${resp.status}: ${t}`);
  }

  const data: any = await resp.json();
  const text: string | undefined = data?.choices?.[0]?.message?.content;

  if (!text || typeof text !== "string") {
    throw new Error("DeepSeek returned empty content.");
  }

  return text.trim();
}

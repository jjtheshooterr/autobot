/**
 * Meta Messenger Send API client
 * Handles sending text messages to users via Meta Messenger Platform
 */

const META_SEND_API_URL = 'https://graph.facebook.com/v19.0/me/messages';

/**
 * Sends a text message to a user via Meta Messenger
 * @param psid - Page-Scoped ID of the recipient
 * @param text - Message text to send
 * @param pageAccessToken - FB_PAGE_ACCESS_TOKEN from environment
 * @throws Error if API returns non-2xx response
 */
export async function sendTextMessage(
  psid: string,
  text: string,
  pageAccessToken: string
): Promise<void> {
  const url = `${META_SEND_API_URL}?access_token=${encodeURIComponent(pageAccessToken)}`;

  const payload = {
    messaging_type: 'RESPONSE',
    recipient: {
      id: psid
    },
    message: {
      text: text
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meta Send API error: ${response.status} ${errorText}`);
  }
}

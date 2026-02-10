/**
 * Resend email integration
 * Sends booking notifications via Resend API
 */

import type { Env } from './types';

export interface BookingEmailData {
  slotLabel: string;
  address: string;
  phone: string;
  psid: string;
  eventId: string;
}

/**
 * Send chatbot booking notification email via Resend
 */
export async function sendChatbotBookingEmail(
  env: Env,
  data: BookingEmailData
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.error('[RESEND] No API key configured, skipping email notification');
    return;
  }

  const emailBody = {
    from: 'Sparkle Auto Detailing <bookings@sparkleautodetailingllc.com>',
    to: ['nyeamanbusiness@gmail.com'],
    subject: `New Booking: ${data.slotLabel}`,
    html: `
      <h2>New Booking from Messenger Bot</h2>
      
      <h3>Appointment Details:</h3>
      <ul>
        <li><strong>Time:</strong> ${data.slotLabel}</li>
        <li><strong>Address:</strong> ${data.address}</li>
        <li><strong>Phone:</strong> ${data.phone}</li>
      </ul>
      
      <h3>Technical Details:</h3>
      <ul>
        <li><strong>Google Calendar Event ID:</strong> ${data.eventId}</li>
        <li><strong>Customer PSID:</strong> ${data.psid}</li>
      </ul>
      
      <p><em>This booking was made through the Facebook Messenger chatbot.</em></p>
    `,
    text: `
New Booking from Messenger Bot

Appointment Details:
- Time: ${data.slotLabel}
- Address: ${data.address}
- Phone: ${data.phone}

Technical Details:
- Google Calendar Event ID: ${data.eventId}
- Customer PSID: ${data.psid}

This booking was made through the Facebook Messenger chatbot.
    `.trim()
  };

  try {
    console.log('[RESEND] Sending booking notification email...');
    
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend API error ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    console.log('[RESEND] ✅ Email sent successfully:', result);
    
  } catch (error) {
    console.error('[RESEND] ❌ Failed to send email:', error);
    // Don't throw - email failure shouldn't break the booking flow
  }
}

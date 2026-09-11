import "server-only";
import { normalisePhone } from "./phone";

/**
 * WhatsApp Cloud API sender.
 *
 * Server-only: the access token must never reach a browser. If the credentials
 * aren't set the module reports that plainly rather than pretending a message
 * went out — a notification that silently doesn't send is worse than none.
 *
 * Set up at developers.facebook.com → your app → WhatsApp:
 *   WHATSAPP_PHONE_NUMBER_ID   the sending number's id
 *   WHATSAPP_ACCESS_TOKEN      a permanent system-user token
 *   WHATSAPP_DEFAULT_COUNTRY   e.g. 91, to normalise local numbers
 */

const GRAPH_VERSION = "v21.0";

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  defaultCountry: string;
}

export function whatsappConfig(): WhatsAppConfig | null {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) return null;
  return {
    phoneNumberId,
    accessToken,
    defaultCountry: process.env.WHATSAPP_DEFAULT_COUNTRY ?? "91",
  };
}

export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; detail: string };

export async function sendWhatsApp(
  config: WhatsAppConfig,
  toRaw: string,
  body: string,
): Promise<SendResult> {
  const to = normalisePhone(toRaw, config.defaultCountry);
  if (!to) return { ok: false, detail: `Unusable phone number: ${toRaw}` };

  try {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body },
        }),
      },
    );

    const payload = (await response.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number; error_subcode?: number };
    };

    if (!response.ok) {
      const err = payload.error;
      // 131030 is the sandbox allow-list rejection, which is the single most
      // common "why didn't it arrive" during setup.
      const hint =
        err?.code === 131030
          ? " (the test number isn't on your WhatsApp allow-list)"
          : err?.code === 190
            ? " (the access token has expired)"
            : "";
      return { ok: false, detail: `${response.status}: ${err?.message ?? "send failed"}${hint}` };
    }

    const providerId = payload.messages?.[0]?.id;
    if (!providerId) return { ok: false, detail: "Provider accepted the call but returned no message id" };
    return { ok: true, providerId };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Network error" };
  }
}

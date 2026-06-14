// Cliente Gmail via OAuth2 (fetch nativo — sin dependencias externas)
// Variables requeridas: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER_EMAIL

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || "";
const USER_EMAIL = process.env.GMAIL_USER_EMAIL || "me";

export const gmailConfigured = !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

let _accessToken: string | null = null;
let _tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiry - 60_000) return _accessToken;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`OAuth2 token refresh failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return _accessToken!;
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users";

export async function gmailSearch(query: string, maxResults = 50): Promise<any[]> {
  const token = await getAccessToken();
  const userId = encodeURIComponent(USER_EMAIL);
  const messages: any[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(maxResults, 500)) });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`${BASE}/${userId}/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Gmail search failed: ${res.status}`);
    const data: any = await res.json();
    const ids: any[] = data.messages || [];
    for (const { id } of ids) {
      const msgRes = await fetch(`${BASE}/${userId}/messages/${id}?format=full`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (msgRes.ok) messages.push(await msgRes.json());
      if (messages.length >= maxResults) break;
    }
    pageToken = data.nextPageToken;
  } while (pageToken && messages.length < maxResults);

  return messages;
}

export async function gmailDownloadAttachment(
  messageId: string,
  attachmentId: string
): Promise<string> {
  const token = await getAccessToken();
  const userId = encodeURIComponent(USER_EMAIL);
  const res = await fetch(
    `${BASE}/${userId}/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Gmail attachment download failed: ${res.status}`);
  const data: any = await res.json();
  const b64 = (data.data || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("latin1");
}

export function findTxtAttachment(
  message: any
): { attachmentId: string; filename: string } | null {
  const parts: any[] = message.payload?.parts || [];
  const part = parts.find(
    (p: any) => p.filename && p.filename.toUpperCase().endsWith(".TXT") && p.body?.attachmentId
  );
  if (!part) return null;
  return { attachmentId: part.body.attachmentId, filename: part.filename };
}
